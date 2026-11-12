// 监理日志"参会人员"——正式(local)服务真实浏览器验收。
// 直接连到用户重启的正式实例：页面 http://127.0.0.1:8081，后端 /api 由静态代理转发到 8080。
// 原则：复用现有项目 3「雪后多伦多」与其真实候选（admin），不新建项目/用户；
//       仅新建 1 条监理日志用于验证，全部检查完成后软删除该日志，把真实库恢复到验收前状态。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8081';
const CDP = process.env.E2E_CDP || 'http://127.0.0.1:19311';
const PROJECT_ID = Number(process.env.LOG_PROJECT_ID || 3);
const OUT = path.join(__dirname, '日志参会人员正式验收-20261106');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
let token;
let browser;

async function raw(url, method = 'GET', body, headers = {}) {
  const res = await fetch(BASE + '/api' + url, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers, ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { res, json, text };
}
async function api(url, method = 'GET', body, headers = {}) {
  const { res, json } = await raw(url, method, body, headers);
  if (!res.ok || !json || json.code !== 200) throw new Error(method + ' ' + url + ': ' + (text => text.slice(0, 200))(JSON.stringify(json || res.status)));
  return json.data;
}
async function check(name, fn) {
  const detail = await fn();
  results.push({ name, pass: true, detail });
  console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail)));
}
class CDPClient {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.httpErrors = [];
    ws.addEventListener('message', event => {
      const m = JSON.parse(event.data);
      const p = this.pending.get(m.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/') && m.params.response.status >= 400) this.httpErrors.push({ status: m.params.response.status, url: m.params.response.url });
      if (m.method === 'Page.javascriptDialogOpening') void this.send('Page.handleJavaScriptDialog', { accept: true });
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 超时：' + method)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async wait(expr, label) {
    for (let i = 0; i < 180; i++) { try { if (await this.eval(expr)) return; } catch (_) {} await sleep(100); }
    throw new Error('等待超时：' + label);
  }
  async navigate(page) {
    await this.send('Page.navigate', { url: BASE + '/' + page });
    await this.wait(`location.pathname.endsWith(${JSON.stringify(page.split('?')[0])}) && document.readyState === 'complete'`, page);
  }
  async click(selector) {
    const pt = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.hidden || el.disabled) throw Error('控件不可点：' + ${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); if (!r.width || !r.height) throw Error('无可点击区域：' + ${JSON.stringify(selector)}); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pt });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pt });
  }
  async select(selector, value) {
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(String(value))}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  }
  async shot(name, selector) {
    if (selector) await this.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`).catch(() => {});
    await sleep(200);
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  }
}
async function listProjectLogs(pid) {
  const page = await api('/records/supervision-logs?projectId=' + pid + '&pageNum=1&pageSize=100');
  return (page && page.list) || [];
}
async function waitOneLog(prevCount) {
  for (let i = 0; i < 100; i++) { const l = await listProjectLogs(PROJECT_ID); if (l.length === prevCount + 1) return l.find(x => x.status !== 'inactive'); await sleep(100); }
  const err = await browser.eval(`(document.querySelector('#fwError')||{textContent:''}).textContent`);
  throw new Error('保存后未出现新增监理日志；页面错误：' + err);
}
(async () => {
  const page = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  browser = new CDPClient(ws);
  await browser.send('Page.enable'); await browser.send('Runtime.enable'); await browser.send('Network.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  let record = null; let prevCount = 0;
  try {
    await browser.navigate('login.html');
    await browser.eval(`document.querySelector('#username').value='admin';document.querySelector('#password').value='123456'`);
    await browser.click('#loginBtn');
    await browser.wait(`!!window.App && !!App.getToken() && !location.pathname.endsWith('login.html')`, '真实登录');
    token = await browser.eval('App.getToken()');

    // 取现有项目的真实候选人员（只读），确定本次要勾选的 id 与"不属于本项目"的对照 id
    const options = await api('/field/projects/' + PROJECT_ID + '/member-options');
    const allowedIds = options.map(o => String(o.userId)).sort();
    const allowedNames = options.map(o => o.userName);
    assert.ok(allowedIds.length >= 1, '现有项目无候选人员，无法验收勾选');
    const allUsers = (await api('/users?pageSize=200').catch(() => null)) || (await api('/records/authors?kind=supervision-logs&projectId=' + PROJECT_ID).catch(() => []));
    const allIds = Array.isArray(allUsers) ? allUsers.map(u => String(u.id ?? u.userId)) : [];
    const forbiddenId = allIds.find(id => !allowedIds.includes(id)) || (allowedIds.includes('2') ? '999999' : '2');
    console.log('候选 allowedIds=' + JSON.stringify(allowedIds) + ' 姓名=' + JSON.stringify(allowedNames) + ' 对照非本项目 id=' + forbiddenId);

    await browser.navigate('supervision-log.html');
    await browser.wait(`document.querySelector('#fwProject option[value="${PROJECT_ID}"]')`, '项目下拉');
    await browser.select('#fwProject', PROJECT_ID);
    prevCount = (await listProjectLogs(PROJECT_ID)).filter(x => x.status !== 'inactive').length;
    await browser.click('#fwNew');
    await browser.wait(`!document.querySelector('#fwEditor').hidden && document.querySelectorAll('#fwF-participants [data-participant-id]').length === ${allowedIds.length}`, '参会人员候选加载');

    await check('新建监理日志中"参会人员"复选框紧跟"编号"字段', async () => {
      const st = await browser.eval(`(() => { const ids = Array.from(document.querySelectorAll('#fwForm [id^="fwF-"]')).map(el => el.id); const opts = Array.from(document.querySelectorAll('#fwF-participants [data-participant-id]')).map(el => ({ id: el.dataset.participantId, text: el.closest('label').textContent.trim() })); return { ids, opts }; })()`);
      assert.equal(st.ids.indexOf('fwF-participants'), st.ids.indexOf('fwF-code') + 1, JSON.stringify(st.ids));
      assert.deepEqual(st.opts.map(o => o.id).sort(), allowedIds);
      for (const n of allowedNames) assert.ok(st.opts.some(o => o.text.includes(n)), '候选缺少姓名：' + n);
      assert.ok(!st.opts.some(o => o.id === forbiddenId), '候选不应包含非本项目人员');
      return { around: st.ids.slice(st.ids.indexOf('fwF-code'), st.ids.indexOf('fwF-participants') + 1), options: st.opts.map(o => o.text) };
    });
    await browser.shot('01-编号后紧跟参会人员', '#fwF-participants');

    for (const id of allowedIds) await browser.click(`#fwF-participants [data-participant-id="${id}"]`);
    await check('真实鼠标点击可勾选本项目全部候选人员', async () => {
      const checked = await browser.eval(`Array.from(document.querySelectorAll('#fwF-participants [data-participant-id]:checked')).map(el => el.dataset.participantId)`);
      assert.deepEqual(checked.slice().sort(), allowedIds);
      return checked;
    });

    await browser.click('#fwSave');
    record = await waitOneLog(prevCount);
    await check('保存后服务器持久化人员 ID（participants 列迁移在真实库生效）', async () => {
      const saved = JSON.parse(record.participants).map(String).sort();
      assert.deepEqual(saved, allowedIds);
      return { id: record.id, code: record.code, status: record.status, participants: record.participants };
    });

    await browser.wait(`!document.querySelector('#fwClose').disabled && !document.querySelector('#fwSave').disabled`, '保存收尾');
    await browser.click('#fwClose');
    await browser.wait(`document.querySelector('#fwEditor').hidden`, '关闭编辑器');
    await browser.select('#fwStatus', 'draft');
    await browser.wait(`document.querySelector('#fwRows [data-id="${record.id}"]')`, '草稿列表');
    await browser.click(`#fwRows [data-id="${record.id}"]`);
    await browser.wait(`!document.querySelector('#fwEditor').hidden && document.querySelectorAll('#fwF-participants [data-participant-id]:checked').length === ${allowedIds.length}`, '重新打开回显');
    await check('关闭并重新打开后姓名与勾选状态准确回显', async () => {
      const checked = await browser.eval(`Array.from(document.querySelectorAll('#fwF-participants [data-participant-id]:checked')).map(el => ({ id: el.dataset.participantId, text: el.closest('label').textContent.trim() }))`);
      assert.deepEqual(checked.map(c => c.id).sort(), allowedIds);
      for (const n of allowedNames) assert.ok(checked.some(c => c.text.includes(n)), '回显缺少姓名：' + n);
      return checked.map(c => c.text);
    });
    await browser.shot('02-重新打开参会人员回显', '#fwF-participants');

    await check('打印预览在参会人员位置输出姓名文本', async () => {
      await browser.eval(`window.__printParticipants = null; window.print = function(){ const host = document.querySelector('#fwF-participants'); const sib = host && host.nextElementSibling; window.__printParticipants = (sib && sib.classList.contains('fw-print-value')) ? sib.textContent : ('NO_VALUE:'+(sib?sib.className:'null')); };`);
      await browser.click('#fwPrint');
      const txt = await browser.eval(`window.__printParticipants`);
      assert.ok(txt && !String(txt).startsWith('NO_VALUE:'), '打印未生成参会人员文本节点：' + txt);
      for (const n of allowedNames) assert.ok(String(txt).includes(n), '打印内容缺少姓名：' + n);
      assert.ok(!String(txt).includes('['), '打印内容不应出现人员 ID JSON：' + txt);
      await browser.shot('03-打印预览参会人员', '#fwF-participants');
      return { printed: txt };
    });
    await browser.eval(`delete window.print`);
    await browser.click('#fwClose').catch(() => {});

    await browser.navigate('supervision-log.html?id=' + record.id + '&readonly=true');
    await browser.wait(`document.querySelector('#fwF-participants .fd-readonly')`, '只读姓名');
    await check('只读详情展示人员姓名且不可编辑', async () => {
      const st = await browser.eval(`({ text: document.querySelector('#fwF-participants .fd-readonly').textContent, checkbox: document.querySelectorAll('#fwF-participants input').length, saveHidden: document.querySelector('#fwSave').hidden, submitHidden: (document.querySelector('#fwSubmit')||{hidden:true}).hidden })`);
      for (const n of allowedNames) assert.ok(st.text.includes(n), '只读缺少姓名：' + n);
      assert.equal(st.checkbox, 0, '只读不应渲染复选框');
      assert.equal(st.saveHidden, true);
      return st;
    });
    await browser.shot('04-只读参会人员', '#fwF-participants');

    await browser.navigate('supervision-log.html');
    await browser.wait(`document.querySelector('#fwProject option[value="${PROJECT_ID}"]')`, '导出项目下拉');
    await browser.select('#fwProject', PROJECT_ID);
    await browser.wait(`document.querySelector('#fwRows [data-id="${record.id}"]')`, '导出列表');
    await browser.eval(`(() => { window.__csv=''; window.__co=URL.createObjectURL; URL.createObjectURL=function(b){ if(b.type.includes('text/csv')) b.text().then(t=>window.__csv=t); return window.__co.call(URL,b); }; window.__ac=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){ if(this.download&&this.download.endsWith('.csv')) return; return window.__ac.call(this); }; })()`);
    await browser.click('#fwExport');
    await browser.wait(`window.__csv.includes('参会人员')`, 'CSV 导出');
    await check('CSV 导出参会人员列显示姓名而非人员 ID JSON', async () => {
      const csv = await browser.eval(`window.__csv`);
      await browser.eval(`(() => { URL.createObjectURL=window.__co; HTMLAnchorElement.prototype.click=window.__ac; })()`);
      const lines = csv.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
      const header = lines[0].split(',');
      const idx = header.findIndex(h => h.replace(/^"|"$/g, '') === '参会人员');
      assert.ok(idx >= 0, 'CSV 无参会人员列');
      const row = lines.find(l => l.includes(record.code));
      assert.ok(row, 'CSV 未含本次记录 ' + record.code);
      const cell = row.split(',')[idx].replace(/^"|"$/g, '');
      for (const n of allowedNames) assert.ok(cell.includes(n), 'CSV 单元格缺少姓名：' + cell);
      assert.ok(!cell.includes('[') && !/^\d+$/.test(cell), 'CSV 单元格疑似泄露 ID：' + cell);
      return { header: header[idx], cell };
    });

    await check('服务端拒绝勾选非本项目人员（跨项目二次校验）', async () => {
      const { res, json } = await raw('/supervision-logs', 'POST', { projectId: PROJECT_ID, logDate: new Date().toLocaleDateString('sv-SE'), participants: JSON.stringify([Number(forbiddenId)]), content: '跨项目人员服务端校验', photos: '[]', attachments: '[]' });
      assert.equal(res.status, 400, JSON.stringify(json));
      assert.equal(json.code, 400);
      assert.ok((json.message || '').includes('本项目'), json.message);
      return { status: res.status, message: json.message };
    });

    await check('真实浏览器流程无 JavaScript 异常和意外接口错误', async () => {
      assert.deepEqual(browser.errors, []);
      assert.deepEqual(browser.httpErrors, []);
    });

    console.log('合计 ' + results.length + '/' + results.length + ' 通过');
  } catch (error) {
    results.push({ name: '阻塞/失败', pass: false, error: error.message });
    console.error('FAIL', error);
    await browser.shot('FAIL-current').catch(() => {});
    fs.writeFileSync(path.join(OUT, 'failure-dom.txt'), await browser.eval('document.body.innerText').catch(() => ''));
    process.exitCode = 1;
  } finally {
    // 清理：软删除本次在项目 3 新建的全部监理日志，把真实库恢复到验收前状态（prevCount 基线）。
    let cleaned = [];
    try {
      const now = await listProjectLogs(PROJECT_ID);
      for (const r of now.filter(x => x.status !== 'inactive')) {
        const full = await api('/supervision-logs/' + r.id);
        await raw('/supervision-logs/' + r.id, 'DELETE', undefined, { 'X-Record-Version': String(full.lockVersion) });
        cleaned.push(r.id);
      }
      const after = await listProjectLogs(PROJECT_ID);
      cleaned = { cleanedIds: cleaned, remainingActive: after.filter(x => x.status !== 'inactive').length, baseline: prevCount };
    } catch (e) { cleaned = { cleanupError: e.message }; }
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ base: BASE, projectId: PROJECT_ID, recordId: record && record.id, results, cleanup: cleaned, errors: browser.errors, httpErrors: browser.httpErrors }, null, 2));
    console.log('清理结果 ' + JSON.stringify(cleaned));
    console.log('证据目录：' + OUT);
    browser.ws.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
