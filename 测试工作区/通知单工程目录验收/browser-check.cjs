'use strict';
// 独立 H2 + 真实 Edge/CDP：通知单工程资料目录加载、过滤、保存与回显。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:18151';
const CDP = process.env.E2E_CDP || 'http://127.0.0.1:19250';
const OUT = path.join(__dirname, 'results');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let token;

async function api(url, method = 'GET', body) {
  const response = await fetch(BASE + '/api' + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error(`${method} ${url}: ${JSON.stringify(result)}`);
  return result.data;
}

class Browser {
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
      if (message.method === 'Network.responseReceived') {
        const response = message.params.response;
        if (response.status >= 400 && response.url.includes('/api/')) this.httpErrors.push({ status: response.status, url: response.url });
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
  const makeProject = (name, code) => api('/projects', 'POST', { name, code, buildUnit: '目录验收建设单位', status: 'active', managerId: 1 });
  const project = await makeProject('通知单目录验收项目', 'NOTICE-DIR-' + run);
  const emptyProject = await makeProject('通知单无目录项目', 'NOTICE-EMPTY-' + run);
  const disabledProject = await makeProject('通知单禁用目录项目', 'NOTICE-DISABLED-' + run);
  const otherProject = await makeProject('通知单跨项目目录对照', 'NOTICE-OTHER-DIR-' + run);
  const root = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '主楼单位工程', sortOrder: 1 });
  const leaf = await api('/sub-item-databases', 'POST', { projectId: project.id, parentId: root.id, name: '钢筋分项工程', sortOrder: 1 });
  const inactive = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '已删除目录', sortOrder: 2 });
  await api('/sub-item-databases/' + inactive.id, 'DELETE');
  const disabledOnly = await api('/sub-item-databases', 'POST', { projectId: disabledProject.id, name: '仅禁用目录', sortOrder: 1 });
  await api('/sub-item-databases/' + disabledOnly.id, 'DELETE');
  const cross = await api('/sub-item-databases', 'POST', { projectId: otherProject.id, name: '跨项目目录', sortOrder: 1 });
  const noticeCode = 'NOTICE-DIRECTORY-' + run;

  const page = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const browser = new Browser(ws);
  await browser.send('Page.enable');
  await browser.send('Runtime.enable');
  await browser.send('Network.enable');
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
    await browser.set('#projectSelect', project.id, 'change');
    await browser.wait(`document.querySelector('#docTree input[data-id="${leaf.id}"]')`, '当前项目目录候选');

    await check('目录接口非空且页面候选与接口有效叶子一致', async () => {
      const tree = await api('/sub-item-databases/tree?projectId=' + project.id);
      assert.ok(tree.length > 0);
      const candidates = await browser.eval(`Array.from(document.querySelectorAll('#docTree input[data-id]')).map(el => ({ id: Number(el.dataset.id), label: el.dataset.label, disabled: el.disabled, projectId: el.closest('.doc-tree-node').dataset.projectId }))`);
      assert.deepEqual(candidates.map(item => item.id), [leaf.id]);
      assert.equal(candidates[0].label, '主楼单位工程 / 钢筋分项工程');
      assert.equal(candidates[0].disabled, false);
      assert.equal(candidates[0].projectId, String(project.id));
      assert.equal(await browser.eval(`document.querySelector('#docTree .doc-parent-node input').disabled`), true);
      assert.ok(!candidates.some(item => item.id === inactive.id || item.id === cross.id));
      return { treeRoots: tree.length, candidates };
    });

    await browser.set('#projectSelect', emptyProject.id, 'change');
    await browser.wait(`document.querySelector('#docTree').textContent.includes('暂无工程资料目录') && !document.querySelector('#docTree input[data-id]')`, '无目录项目空提示');
    await check('当前项目没有目录时才显示暂无工程资料目录', async () => assert.equal(await browser.eval(`document.querySelectorAll('#docTree input[data-id]').length`), 0));

    await browser.set('#projectSelect', disabledProject.id, 'change');
    await browser.wait(`document.querySelector('#docTree').textContent.includes('暂无工程资料目录') && !document.querySelector('#docTree input[data-id]')`, '禁用目录项目空提示');
    await check('已禁用目录及其子树不会成为候选', async () => assert.equal(await browser.eval(`document.querySelectorAll('#docTree input').length`), 0));

    await browser.set('#projectSelect', project.id, 'change');
    await browser.wait(`document.querySelector('#docTree input[data-id="${leaf.id}"]')`, '切回项目重新加载目录');
    await check('项目切换后按新项目刷新且跨项目目录不混入', async () => {
      const ids = await browser.eval(`Array.from(document.querySelectorAll('#docTree input[data-id]')).map(el => Number(el.dataset.id))`);
      assert.deepEqual(ids, [leaf.id]);
    });

    await browser.click(`#docTree input[data-id="${leaf.id}"]`);
    await browser.set('#noticeCode', noticeCode);
    await browser.set('#noticeTitle', '工程资料目录绑定验收');
    await browser.set('#noticeContent', '选择末级目录并验证保存与回显。');
    await browser.shot('01-新建通知单选择目录');
    await browser.click('button[onclick="saveDraft()"]');
    await browser.wait(`!document.querySelector('#createModal').classList.contains('show') && Array.from(document.querySelectorAll('tbody tr')).some(r => r.textContent.includes('${noticeCode}'))`, '草稿保存返回列表');

    const saved = await api('/supervision-notices?code=' + noticeCode);
    const noticeId = saved.list[0].id;
    assert.deepEqual(saved.list[0].documentDirectoryIds, [leaf.id]);
    await check('草稿保存后目录ID真实持久化', async () => ({ noticeId, documentDirectoryIds: saved.list[0].documentDirectoryIds }));

    await browser.eval(`Array.from(document.querySelectorAll('tbody tr')).find(r => r.textContent.includes('${noticeCode}')).querySelector('button[onclick^="openEditModal"]').click()`);
    await browser.wait(`document.querySelector('#createModal').classList.contains('show') && document.querySelector('#docTree input[data-id="${leaf.id}"]')?.checked`, '编辑页目录回显');
    await check('编辑页正确回显已选目录及完整路径', async () => {
      assert.equal(await browser.eval(`document.querySelector('#selectedDocCount').textContent`), '已选 1 项');
      assert.ok((await browser.eval(`document.querySelector('#selectedDocs').textContent`)).includes('主楼单位工程 / 钢筋分项工程'));
    });
    await browser.click('button[onclick="issueNotice()"]');
    await browser.wait(`!document.querySelector('#createModal').classList.contains('show') && Array.from(document.querySelectorAll('tbody tr')).some(r => r.dataset.status === 'issued' && r.textContent.includes('${noticeCode}'))`, '下发后目录保留');

    await browser.eval(`Array.from(document.querySelectorAll('tbody tr')).find(r => r.textContent.includes('${noticeCode}')).querySelector('button[onclick^="viewDetail"]').click()`);
    await browser.wait(`document.querySelector('#viewModal').classList.contains('show') && document.querySelector('#viewDocumentDirectorySection').style.display !== 'none'`, '详情目录区块');
    await check('下发及详情页目录完整回显', async () => {
      assert.ok((await browser.eval(`document.querySelector('#viewDocumentDirectories').textContent`)).includes('主楼单位工程 / 钢筋分项工程'));
      const detail = await api('/supervision-notices/' + noticeId);
      assert.deepEqual(detail.documentDirectoryIds, [leaf.id]);
      assert.equal(detail.documentDirectories[0].path, '主楼单位工程 / 钢筋分项工程');
    });
    await browser.shot('02-通知单详情目录回显');

    await browser.click('#viewModal .modal-footer button');
    await browser.eval(`Array.from(document.querySelectorAll('tbody tr')).find(r => r.textContent.includes('${noticeCode}')).querySelector('button[onclick^="respond"]').click()`);
    await browser.wait(`document.querySelector('#respondModal').classList.contains('show')`, '回复弹窗');
    await browser.set('#replyContent', '整改资料已按所选目录归档。');
    await browser.click('button[onclick="submitResponse()"]');
    await browser.wait(`Array.from(document.querySelectorAll('tbody tr')).some(r => r.dataset.status === 'responded' && r.textContent.includes('${noticeCode}'))`, '回复完成');
    await browser.eval(`Array.from(document.querySelectorAll('tbody tr')).find(r => r.textContent.includes('${noticeCode}')).querySelector('button[onclick^="verify"]').click()`);
    await browser.wait(`document.querySelector('#verifyModal').classList.contains('show')`, '验证弹窗');
    await browser.set('#verifyOpinion', '整改结果及资料目录均核验通过。');
    await browser.click('button[onclick="submitVerify()"]');
    await browser.wait(`Array.from(document.querySelectorAll('tbody tr')).some(r => r.dataset.status === 'verified' && r.textContent.includes('${noticeCode}'))`, '验证完成');
    await check('回复与验证全量更新不会清空目录', async () => {
      const detail = await api('/supervision-notices/' + noticeId);
      assert.equal(detail.status, 'verified');
      assert.deepEqual(detail.documentDirectoryIds, [leaf.id]);
      assert.equal(detail.documentDirectories[0].path, '主楼单位工程 / 钢筋分项工程');
    });

    await check('页面无JavaScript异常且业务接口无4xx或5xx', async () => {
      assert.deepEqual(browser.errors, []);
      assert.deepEqual(browser.httpErrors, []);
    });
  } catch (error) {
    results.push({ name: '阻塞', pass: false, error: error.message });
    console.error(error);
    await browser.shot('FAIL-current').catch(() => {});
    fs.writeFileSync(path.join(OUT, 'failure-dom.txt'), await browser.eval('document.body.innerText').catch(() => ''));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ run, projectId: project.id, leafId: leaf.id, noticeCode, results, errors: browser.errors, httpErrors: browser.httpErrors }, null, 2));
    console.log('证据目录：' + OUT);
    ws.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
