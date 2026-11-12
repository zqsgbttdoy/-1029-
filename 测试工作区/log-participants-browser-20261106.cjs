// 监理日志“参会人员”独立 H2 + 真实 Edge/CDP 验收；不连接正式 8080/8081。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const BASE = 'http://127.0.0.1:18131';
const CDP = 'http://127.0.0.1:19257';
const OUT = path.join(__dirname, '日志参会人员验收-20261106');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let token;
let browser;

async function request(url, method = 'GET', body) {
  const response = await fetch(BASE + '/api' + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json();
  return { response, json };
}
async function api(url, method = 'GET', body) {
  const { response, json } = await request(url, method, body);
  if (!response.ok || json.code !== 200) throw new Error(method + ' ' + url + ': ' + JSON.stringify(json));
  return json.data;
}
async function check(name, fn) {
  const detail = await fn();
  results.push({ name, pass: true, detail });
  console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail)));
}
class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.httpErrors = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      }
      if (message.method === 'Network.responseReceived' && message.params.response.url.includes('/api/') && message.params.response.status >= 400) {
        this.httpErrors.push({ status: message.params.response.status, url: message.params.response.url });
      }
      if (message.method === 'Page.javascriptDialogOpening') void this.send('Page.handleJavaScriptDialog', { accept: true });
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 超时：' + method));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async wait(expression, label) {
    for (let i = 0; i < 180; i++) {
      try { if (await this.eval(expression)) return; } catch (_) {}
      await sleep(100);
    }
    throw new Error('等待超时：' + label);
  }
  async navigate(page) {
    await this.send('Page.navigate', { url: BASE + '/' + page });
    await this.wait(`location.pathname.endsWith(${JSON.stringify(page.split('?')[0])}) && document.readyState === 'complete'`, page);
  }
  async click(selector) {
    const point = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.hidden || el.disabled) throw Error('控件不可点：' + ${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) throw Error('控件没有可点击区域：' + ${JSON.stringify(selector)});
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async select(selector, value) {
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }
  async shot(name, selector) {
    if (selector) await this.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`);
    await sleep(200);
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(result.data, 'base64'));
  }
}
async function seed() {
  const run = randomUUID().slice(0, 8);
  const date = new Date().toLocaleDateString('sv-SE');
  const project = await api('/projects', 'POST', {
    name: '日志参会人员独立验收工程-' + run,
    code: 'LOG-PART-' + run,
    buildUnit: '独立验收建设单位',
    status: 'active',
    managerId: 1
  });
  const other = await api('/projects', 'POST', {
    name: '参会人员外项目-' + run,
    code: 'LOG-OTHER-' + run,
    buildUnit: '独立验收建设单位',
    status: 'active',
    managerId: 1
  });
  const phoneBase = Date.now() % 100000000;
  async function user(name, index, projectId) {
    return api('/users', 'POST', {
      name,
      gender: '男',
      deptId: 2,
      position: '监理工程师',
      phone: String(13900000000 + phoneBase + index),
      password: '123456',
      hireDate: '2026-01-01',
      status: 'active',
      projectIds: [projectId]
    });
  }
  const memberA = await user('参会成员甲', 1, project.id);
  const memberB = await user('参会成员乙', 2, project.id);
  const outsider = await user('外项目人员', 3, other.id);
  const disabled = await user('取消授权人员', 4, project.id);
  const inactive = await user('停用账号人员', 5, project.id);
  await api('/projects/' + project.id + '/members', 'PUT', { userId: 1, enabled: true, canReview: true });
  // e2e 种子用户 2 的旧 projectId=1；新项目恰好取得 ID 1 时，显式禁用以隔离本用例候选。
  if (project.id === 1) await api('/projects/' + project.id + '/members', 'PUT', { userId: 2, enabled: false, canReview: false });
  await api('/projects/' + project.id + '/members', 'PUT', { userId: memberA.id, enabled: true, canReview: false });
  await api('/projects/' + project.id + '/members', 'PUT', { userId: memberB.id, enabled: true, canReview: false });
  await api('/projects/' + project.id + '/members', 'PUT', { userId: disabled.id, enabled: false, canReview: false });
  await api('/users/' + inactive.id + '/status?status=inactive', 'PUT');
  return { run, date, project, other, memberA, memberB, outsider, disabled, inactive };
}
async function waitSaved(projectId) {
  for (let i = 0; i < 100; i++) {
    const page = await api('/records/supervision-logs?projectId=' + projectId + '&pageNum=1&pageSize=100');
    if (page.list && page.list.length === 1) return page.list[0];
    await sleep(100);
  }
  const error = await browser.eval(`(document.querySelector('#fwError') || { textContent: '' }).textContent`);
  throw new Error('保存后未查询到唯一监理日志；页面错误：' + error);
}
(async () => {
  const page = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  browser = new CDPClient(ws);
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Network.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  let fixture;
  let record;
  try {
    await browser.navigate('login.html');
    await browser.eval(`document.querySelector('#username').value='admin';document.querySelector('#password').value='123456'`);
    await browser.click('#loginBtn');
    await browser.wait(`!!window.App && !!App.getToken() && !location.pathname.endsWith('login.html')`, '真实登录');
    token = await browser.eval('App.getToken()');
    fixture = await seed();
    const allowedIds = [1, fixture.memberA.id, fixture.memberB.id].map(String).sort();
    const forbiddenIds = [fixture.outsider.id, fixture.disabled.id, fixture.inactive.id].map(String);

    await check('候选接口仅返回本项目启用且授权的人员', async () => {
      const options = await api('/field/projects/' + fixture.project.id + '/member-options');
      assert.deepEqual(options.map(item => String(item.userId)).sort(), allowedIds);
      for (const id of forbiddenIds) assert.ok(!options.some(item => String(item.userId) === id));
      return options.map(item => item.userName);
    });

    await browser.navigate('supervision-log.html');
    await browser.wait(`document.querySelector('#fwProject option[value="${fixture.project.id}"]')`, '项目下拉');
    await browser.select('#fwProject', fixture.project.id);
    await browser.click('#fwNew');
    await browser.wait(`!document.querySelector('#fwEditor').hidden && document.querySelectorAll('#fwF-participants [data-participant-id]').length === 3`, '参会人员加载');

    await check('新建监理日志中参会人员紧跟编号，且只显示本项目候选', async () => {
      const state = await browser.eval(`(() => {
        const ids = Array.from(document.querySelectorAll('#fwForm [id^="fwF-"]')).map(el => el.id);
        const options = Array.from(document.querySelectorAll('#fwF-participants [data-participant-id]')).map(el => ({ id: el.dataset.participantId, text: el.closest('label').textContent.trim() }));
        return { ids, options, code: document.querySelector('#fwF-code').value };
      })()`);
      assert.equal(state.ids.indexOf('fwF-participants'), state.ids.indexOf('fwF-code') + 1, JSON.stringify(state.ids));
      assert.deepEqual(state.options.map(item => item.id).sort(), allowedIds);
      assert.ok(state.options.some(item => item.text.includes('参会成员甲')));
      assert.ok(state.options.some(item => item.text.includes('参会成员乙')));
      return { order: state.ids.slice(state.ids.indexOf('fwF-code') - 1, state.ids.indexOf('fwF-code') + 2), options: state.options };
    });

    await browser.click(`#fwF-participants [data-participant-id="1"]`);
    await browser.click(`#fwF-participants [data-participant-id="${fixture.memberA.id}"]`);
    await check('真实鼠标点击可勾选多人', async () => {
      const checked = await browser.eval(`Array.from(document.querySelectorAll('#fwF-participants [data-participant-id]:checked')).map(el => el.dataset.participantId)`);
      assert.deepEqual(checked.slice().sort(), ['1', String(fixture.memberA.id)].sort());
      return checked;
    });
    await browser.shot('01-编号后参会人员多选', '#fwF-participants');

    await browser.click('#fwSave');
    record = await waitSaved(fixture.project.id);
    await check('保存草稿后服务器持久化人员 ID，而不是只保存姓名', async () => {
      assert.deepEqual(JSON.parse(record.participants).map(String).sort(), ['1', String(fixture.memberA.id)].sort());
      assert.equal(record.status, 'draft');
      return { id: record.id, code: record.code, participants: record.participants };
    });

    await browser.wait(`!document.querySelector('#fwClose').disabled && !document.querySelector('#fwSave').disabled`, '保存操作收尾');
    await browser.click('#fwClose');
    await browser.wait(`document.querySelector('#fwEditor').hidden`, '关闭编辑器');
    await browser.select('#fwStatus', 'draft');
    await browser.wait(`document.querySelector('#fwRows [data-id="${record.id}"]')`, '草稿列表');
    await browser.click(`#fwRows [data-id="${record.id}"]`);
    await browser.wait(`!document.querySelector('#fwEditor').hidden && document.querySelectorAll('#fwF-participants [data-participant-id]:checked').length === 2`, '重新打开回显');
    await check('关闭并重新打开后，原勾选人员准确回显', async () => {
      const checked = await browser.eval(`Array.from(document.querySelectorAll('#fwF-participants [data-participant-id]:checked')).map(el => ({ id: el.dataset.participantId, text: el.closest('label').textContent.trim() }))`);
      assert.deepEqual(checked.map(item => item.id).sort(), ['1', String(fixture.memberA.id)].sort());
      assert.ok(checked.some(item => item.text.includes('参会成员甲')));
      return checked;
    });
    await browser.shot('02-重新打开参会人员回显', '#fwF-participants');

    await browser.navigate('supervision-log.html?id=' + record.id + '&readonly=true');
    await browser.wait(`document.querySelector('#fwF-participants .fd-readonly') && document.querySelector('#fwF-participants .fd-readonly').textContent.includes('参会成员甲')`, '只读姓名');
    await check('只读详情展示人员姓名且不能编辑', async () => {
      const state = await browser.eval(`({ text: document.querySelector('#fwF-participants .fd-readonly').textContent, checkboxCount: document.querySelectorAll('#fwF-participants input').length, saveHidden: document.querySelector('#fwSave').hidden, submitHidden: document.querySelector('#fwSubmit').hidden })`);
      assert.ok(state.text.includes('admin') && state.text.includes('参会成员甲'));
      assert.equal(state.checkboxCount, 0);
      assert.equal(state.saveHidden && state.submitHidden, true);
      return state;
    });
    await browser.shot('03-只读参会人员姓名', '#fwF-participants');

    await browser.navigate('supervision-log.html');
    await browser.wait(`document.querySelector('#fwRows [data-id="${record.id}"]')`, '导出列表');
    await browser.eval(`(() => {
      window.__participantCsv = '';
      window.__originalCreateObjectURL = URL.createObjectURL;
      window.__originalAnchorClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = function(blob) {
        if (blob.type.includes('text/csv')) blob.text().then(text => { window.__participantCsv = text; });
        return window.__originalCreateObjectURL.call(URL, blob);
      };
      HTMLAnchorElement.prototype.click = function() {
        if (this.download && this.download.endsWith('.csv')) return;
        return window.__originalAnchorClick.call(this);
      };
    })()`);
    await browser.click('#fwExport');
    await browser.wait(`window.__participantCsv.includes('参会人员')`, 'CSV 导出');
    await check('CSV 导出包含参会人员姓名且不泄露人员 ID JSON', async () => {
      const csv = await browser.eval('window.__participantCsv');
      assert.ok(csv.includes('参会人员'));
      assert.ok(csv.includes('admin、参会成员甲') || csv.includes('参会成员甲、admin'));
      assert.ok(!csv.includes('外项目人员'));
      return csv.split('\r\n').slice(0, 2);
    });

    await check('服务端拒绝勾选中不存在的外项目人员', async () => {
      const { response, json } = await request('/supervision-logs', 'POST', {
        projectId: fixture.project.id,
        logDate: fixture.date,
        participants: JSON.stringify([fixture.outsider.id]),
        content: '跨项目人员服务端校验',
        photos: '[]',
        attachments: '[]'
      });
      assert.equal(response.status, 400);
      assert.equal(json.code, 400);
      assert.ok(json.message.includes('本项目'));
      return { status: response.status, message: json.message };
    });

    await check('真实浏览器流程无 JavaScript 异常和意外接口错误', async () => {
      assert.deepEqual(browser.errors, []);
      assert.deepEqual(browser.httpErrors, []);
    });
    console.log('合计 ' + results.length + '/' + results.length + ' 通过');
  } catch (error) {
    results.push({ name: '阻塞', pass: false, error: error.message });
    console.error(error);
    await browser.shot('FAIL-current').catch(() => {});
    fs.writeFileSync(path.join(OUT, 'failure-dom.txt'), await browser.eval('document.body.innerText').catch(() => ''));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({
      base: BASE,
      projectId: fixture && fixture.project.id,
      recordId: record && record.id,
      results,
      errors: browser.errors,
      httpErrors: browser.httpErrors
    }, null, 2));
    console.log('证据目录：' + OUT);
    browser.ws.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
