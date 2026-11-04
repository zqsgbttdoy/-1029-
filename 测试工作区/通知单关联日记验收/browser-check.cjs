'use strict';
// 独立 H2 + 真实 Edge/CDP 验收：通知单关联监理日记完整链路。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:18141';
const CDP = process.env.E2E_CDP || 'http://127.0.0.1:19240';
const OUT = path.join(__dirname, 'results');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let token;

async function api(url, method = 'GET', body, headers = {}) {
  const response = await fetch(BASE + '/api' + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error(`${method} ${url}: ${JSON.stringify(result)}`);
  return result.data;
}

async function uploadPhoto() {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/png' }), 'diary-site.png');
  const response = await fetch(BASE + '/api/files/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error('上传验收照片：' + JSON.stringify(result));
  return result.data.url;
}

async function createDiary(projectId, code, diaryDate, construction, approved, photo) {
  let record = await api('/supervision-diaries', 'POST', {
    projectId, code, diaryDate, construction, weather: '晴', photos: JSON.stringify([{ url: photo, name: 'diary-site.png' }]), attachments: '[]'
  });
  if (approved) {
    record = await api(`/supervision-diaries/${record.id}/submit`, 'POST', undefined, { 'X-Record-Version': record.lockVersion });
    record = await api(`/supervision-diaries/${record.id}/approve`, 'POST', { status: 'approved' }, { 'X-Record-Version': record.lockVersion });
  }
  return record;
}

class Browser {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
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
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 超时：' + method)); }, 20000);
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
    for (let i = 0; i < 120; i++) {
      try { if (await this.eval(expression)) return; } catch (_) {}
      await sleep(100);
    }
    throw new Error('等待超时：' + label);
  }
  async navigate(page) {
    await this.send('Page.navigate', { url: BASE + '/' + page });
    await this.wait(`location.pathname.endsWith(${JSON.stringify(page)}) && document.readyState === 'complete'`, page);
  }
  async set(selector, value, event = 'input') {
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('缺少控件 ${selector}'); el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
  }
  async click(selector) {
    const point = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) throw Error('控件不可点击: ${selector}'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async shot(name) {
    await sleep(150);
    const image = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(image.data, 'base64'));
  }
}

async function check(name, action) {
  const detail = await action();
  results.push({ name, pass: true, detail });
  console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail)));
}

(async () => {
  const run = randomUUID().slice(0, 8);
  token = (await api('/auth/login', 'POST', { username: 'admin', password: '123456' })).token;
  const project = await api('/projects', 'POST', { name: '通知单关联日记验收项目', code: 'NOTICE-DIARY-' + run, buildUnit: '独立验收建设单位', status: 'active', managerId: 1 });
  const otherProject = await api('/projects', 'POST', { name: '通知单关联日记对照项目', code: 'NOTICE-OTHER-' + run, buildUnit: '独立验收建设单位', status: 'active', managerId: 1 });
  const photo = await uploadPhoto();
  const target = await createDiary(project.id, 'TARGET-' + run, '2026-11-01', '三层梁板钢筋绑扎验收，发现保护层垫块不足。', true, photo);
  await createDiary(project.id, 'OLDER-' + run, '2026-10-01', '基础施工记录。', true, photo);
  await createDiary(project.id, 'DRAFT-' + run, '2026-11-01', '未审核日记不应出现在候选中。', false, photo);
  const otherPhoto = await uploadPhoto();
  await createDiary(otherProject.id, 'CROSS-' + run, '2026-11-01', '其他项目日记不应出现在候选中。', true, otherPhoto);
  const noticeCode = 'NOTICE-' + run;

  const page = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const browser = new Browser(ws);
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  try {
    await browser.navigate('login.html');
    await browser.set('#username', 'admin');
    await browser.set('#password', '123456');
    await browser.click('#loginBtn');
    await browser.wait(`!!window.App && !!App.getToken() && !location.pathname.endsWith('login.html')`, '真实登录');
    await browser.navigate('supervision-notice.html');
    await browser.wait(`document.querySelector('#projectSelect option[value="${project.id}"]')`, '项目字典');
    await browser.click('button[onclick="openCreateModal()"]');
    await browser.wait(`document.querySelector('#createModal').classList.contains('show')`, '新建弹窗');
    await browser.set('#projectSelect', project.id, 'change');
    await browser.wait(`document.querySelector('#relatedDiary').options.length === 3`, '已审核日记候选');

    await check('候选仅含同项目已审核日记且展示编号日期作者施工摘要', async () => {
      const options = await browser.eval(`Array.from(document.querySelector('#relatedDiary').options).map(o => ({ value: o.value, text: o.textContent }))`);
      const values = options.map(o => o.value);
      assert.ok(values.includes(String(target.id)));
      assert.equal(values.length, 3);
      const text = options.find(o => o.value === String(target.id)).text;
      assert.ok(text.includes(target.code) && text.includes('2026-11-01') && text.includes('admin') && text.includes('三层梁板钢筋绑扎验收'));
      assert.equal(await browser.eval(`!!document.querySelector('#relatedInspection')`), false);
    });

    await browser.set('#diaryFrom', '2026-11-01');
    await browser.set('#diaryTo', '2026-11-01');
    await browser.set('#diaryKeyword', target.code);
    await browser.click('button[onclick="loadDiaryOptions()"]');
    await browser.wait(`document.querySelector('#relatedDiary').options.length === 2 && document.querySelector('#relatedDiary').options[1].value === '${target.id}'`, '日期与关键词筛选');
    await check('项目日期关键词及approved条件传到supervision-diaries', async () => {
      const queries = await browser.eval(`performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('/api/supervision-diaries?')).map(n => Object.fromEntries(new URL(n).searchParams))`);
      const query = queries[queries.length - 1];
      assert.equal(query.projectId, String(project.id));
      assert.equal(query.status, 'approved');
      assert.equal(query.dateFrom, '2026-11-01');
      assert.equal(query.dateTo, '2026-11-01');
      assert.equal(query.code, target.code);
    });

    await browser.set('#relatedDiary', target.id, 'change');
    await browser.set('#noticeCode', noticeCode);
    await browser.set('#noticeTitle', '关联监理日记的整改通知');
    await browser.set('#noticeContent', '请依据关联日记记录的问题完成整改。');
    await browser.set('#noticeRequirement', '三日内回复整改结果。');
    await browser.shot('01-新建通知单关联日记');
    await browser.click('button[onclick="saveDraft()"]');
    await browser.wait(`!document.querySelector('#createModal').classList.contains('show') && Array.from(document.querySelectorAll('tbody tr')).some(r => r.textContent.includes('${noticeCode}'))`, '草稿保存返回列表');

    await browser.eval(`Array.from(document.querySelectorAll('tbody tr')).find(r => r.textContent.includes('${noticeCode}')).querySelector('button[onclick^="openEditModal"]').click()`);
    await browser.wait(`document.querySelector('#createModal').classList.contains('show') && document.querySelector('#relatedDiary').value === '${target.id}'`, '编辑回显关联日记');
    await check('编辑界面保留原关联日记', async () => assert.equal(await browser.eval(`document.querySelector('#relatedDiary').value`), String(target.id)));
    await browser.click('button[onclick="issueNotice()"]');
    await browser.wait(`!document.querySelector('#createModal').classList.contains('show') && Array.from(document.querySelectorAll('tbody tr')).some(r => r.dataset.status === 'issued' && r.textContent.includes('${noticeCode}'))`, '下发保存返回列表');

    await browser.eval(`Array.from(document.querySelectorAll('tbody tr')).find(r => r.textContent.includes('${noticeCode}')).querySelector('button[onclick^="viewDetail"]').click()`);
    await browser.wait(`document.querySelector('#viewModal').classList.contains('show') && document.querySelector('#viewDiarySection').style.display !== 'none'`, '详情关联日记区块');
    await check('保存跳转及详情日记信息准确', async () => {
      assert.equal(await browser.eval(`document.querySelector('#viewCode').textContent`), noticeCode);
      assert.equal(await browser.eval(`document.querySelector('#viewDiaryCode').textContent`), target.code);
      assert.equal(await browser.eval(`document.querySelector('#viewDiaryDate').textContent`), '2026-11-01');
      assert.equal(await browser.eval(`document.querySelector('#viewDiaryAuthor').textContent`), 'admin');
      assert.ok((await browser.eval(`document.querySelector('#viewDiaryConstruction').textContent`)).includes('保护层垫块不足'));
      const notices = await api('/supervision-notices?code=' + noticeCode);
      assert.equal(notices.list[0].relatedDiaryId, target.id);
    });
    await browser.shot('02-通知单详情关联日记');
    await check('无浏览器JavaScript异常', async () => assert.deepEqual(browser.errors, []));
  } catch (error) {
    results.push({ name: '阻塞', pass: false, error: error.message });
    console.error(error);
    await browser.shot('FAIL-current').catch(() => {});
    fs.writeFileSync(path.join(OUT, 'failure-dom.txt'), await browser.eval('document.body.innerText').catch(() => ''));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ run, projectId: project.id, diaryId: target.id, noticeCode, results, errors: browser.errors }, null, 2));
    console.log('证据目录：' + OUT);
    ws.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
