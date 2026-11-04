// 真实浏览器（无头 Edge + CDP）逐页验收：附件上传关联工程资料目录。
// 直连正在运行的环境：静态页 BASE=http://127.0.0.1:8081（/api 代理到 8080），CDP=http://127.0.0.1:19250。
// 覆盖：work-contact.html / meeting-minutes.html / supervision-monthly-report.html（独立页面，含真实上传+保存+回显），
//       supervision-diary.html / supervision-log.html（共用引擎 field-records.js，真实上传+目录选择器+选择写回）。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8081';
const CDP = process.env.E2E_CDP || 'http://127.0.0.1:19250';
const SAMPLE = path.join(__dirname, 'upload-sample.txt');
const OUT = path.join(__dirname, 'results');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  const text = await response.text();
  let result; try { result = JSON.parse(text); } catch (_) { throw new Error(`${method} ${url}: HTTP ${response.status} ${text.slice(0, 160)}`); }
  if (!response.ok || result.code !== 200) throw new Error(`${method} ${url}: ${JSON.stringify(result)}`);
  return result.data;
}
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(d => { results.push({ name, pass: true }); console.log('PASS ' + name + (d ? ' ' + JSON.stringify(d) : '')); })
    .catch(e => { results.push({ name, pass: false, error: String(e.message || e) }); console.log('FAIL ' + name + ' -> ' + (e.message || e)); });
}

class Browser {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    this.errors = []; this.httpErrors = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      const p = this.pending.get(m.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      if (m.method === 'Network.responseReceived') { const r = m.params.response; if (r.status >= 400 && r.url.includes('/api/')) this.httpErrors.push({ status: r.status, url: r.url }); }
    });
  }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); }, 25000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
  async wait(expression, label) { for (let i = 0; i < 200; i++) { try { if (await this.eval(expression)) return; } catch (_) {} await sleep(100); } throw new Error('等待超时：' + label); }
  async navigate(page) { await this.send('Page.navigate', { url: BASE + '/' + page }); await this.wait(`location.pathname.endsWith(${JSON.stringify(page)}) && document.readyState === 'complete'`, page); }
  async set(selector, value, event = 'input') { await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('缺控件 ${selector}');el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`); }
  async click(selector) { const pt = await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('不可点击 ${selector}');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`); await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pt }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pt }); }
  async setFiles(selector, files) { const doc = await this.send('DOM.getDocument'); const { nodeId } = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector }); if (!nodeId) throw new Error('找不到文件输入 ' + selector); await this.send('DOM.setFileInputFiles', { files, nodeId }); }
  async shot(name) { try { const img = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(img.data, 'base64')); } catch (_) {} }
}

// 复刻页面 appendDirTreeNodes 的路径拼装：跳过 inactive，仅“无 active 子节点”的节点为可绑定叶子。
function computeActiveLeafPaths(nodes, parent) {
  const out = [];
  (nodes || []).forEach(n => {
    if (!n || n.status === 'inactive') return;
    const p = parent ? parent + ' / ' + n.name : n.name;
    const children = (n.children || []).filter(c => c && c.status !== 'inactive');
    if (children.length) out.push(...computeActiveLeafPaths(children, p)); else out.push(p);
  });
  return out;
}

async function verifyStandalone(browser, cfg) {
  await browser.navigate(cfg.page);
  await browser.wait(`!!window.App && !!App.getToken()`, cfg.page + ' 已登录');
  await browser.eval(`openCreateModal()`);
  await browser.wait(`document.querySelector('#createModal') && document.querySelector('#createModal').classList.contains('show')`, cfg.page + ' 新建弹窗');
  await browser.set('#projectSelect', cfg.projectId, 'change');

  await check(cfg.label + '：目录候选 = 该项目全部有效末级目录（剔除软删除）', async () => {
    await browser.eval(`Promise.resolve(ensureDirTree())`);
    await browser.wait(`document.querySelectorAll('#dirTreeContainer .leaf-node').length > 0 || document.querySelector('#dirTreeContainer').textContent.includes('暂无工程资料目录')`, '目录渲染');
    const shown = await browser.eval(`Array.from(document.querySelectorAll('#dirTreeContainer .leaf-node')).map(e=>e.getAttribute('data-path'))`);
    const tree = await api('/sub-item-databases/tree?projectId=' + cfg.projectId);
    const expected = computeActiveLeafPaths(tree, '');
    assert.deepEqual([...shown].sort(), [...expected].sort(), '候选叶子应与接口有效叶子一致');
    assert.ok(!shown.some(p => p.includes('已删除目录')), '不应出现软删除目录');
    return { candidates: shown };
  });

  await check(cfg.label + '：无目录项目提示“暂无工程资料目录”', async () => {
    await browser.set('#projectSelect', cfg.emptyProjectId, 'change');
    await browser.eval(`Promise.resolve(ensureDirTree())`);
    await browser.wait(`document.querySelector('#dirTreeContainer').textContent.includes('暂无工程资料目录') && document.querySelectorAll('#dirTreeContainer .leaf-node').length===0`, '空提示');
    return { ok: true };
  });

  await check(cfg.label + '：切回项目按新项目重载且无跨项目污染', async () => {
    await browser.set('#projectSelect', cfg.projectId, 'change');
    await browser.eval(`Promise.resolve(ensureDirTree())`);
    await browser.wait(`document.querySelectorAll('#dirTreeContainer .leaf-node').length > 0`, '重载目录');
    const shown = await browser.eval(`Array.from(document.querySelectorAll('#dirTreeContainer .leaf-node')).map(e=>e.getAttribute('data-path'))`);
    assert.ok(shown.length > 0 && shown.every(p => cfg.expectedPaths.includes(p)), '候选应全部属于当前项目');
    assert.ok(!shown.some(p => p.includes('跨项目目录')), '不应混入其他项目目录');
    return { candidates: shown };
  });

  // 真实上传 → 目录选择器自动弹出 → 选叶子 → 确认 → 附件项写回 _dirs
  await check(cfg.label + '：真实上传后目录选择器可绑定（附件项写回所选目录）', async () => {
    await browser.setFiles('#createFileInput', [SAMPLE]);
    await browser.wait(`document.querySelector('#dirTreeModal').classList.contains('show')`, '目录弹窗自动打开');
    await browser.wait(`document.querySelectorAll('#dirTreeContainer .leaf-node').length > 0`, '弹窗内目录渲染');
    const target = cfg.expectedPaths[0];
    await browser.click(`#dirTreeContainer .leaf-node[data-path="${target}"]`);
    await browser.click(`#dirTreeModal .modal-footer button.btn-primary`);
    await browser.wait(`!document.querySelector('#dirTreeModal').classList.contains('show')`, '确认后关闭弹窗');
    await browser.wait(`document.querySelector('#createAttachmentList .attachment-item[data-url]')`, '上传完成写回 data-url');
    const info = await browser.eval(`(()=>{const it=document.querySelector('#createAttachmentList .attachment-item[data-url]');return{dirs:(it._dirs||[]),tags:Array.from(it.querySelectorAll('.att-dir-tag')).map(t=>t.getAttribute('data-path'))};})()`);
    assert.deepEqual(info.dirs, [target], '附件 _dirs 应为所选目录');
    assert.deepEqual(info.tags, [target], '附件应渲染所选目录标签');
    return info;
  });

  // 填必填 → 保存 → 经 API 读取证明 UI→DB 全链路持久化
  await check(cfg.label + '：保存后附件 dirs 真实持久化（UI→数据库）', async () => {
    await browser.set('#' + cfg.codeField, cfg.codeValue);
    for (const f of cfg.fills) await browser.set('#' + f.id, f.value);
    await browser.eval(`saveDraft()`);
    await browser.wait(`!document.querySelector('#createModal').classList.contains('show')`, '保存关闭弹窗');
    const page = await api(cfg.recordPath + '?pageNum=1&pageSize=100');
    const list = page.list || page.content || page.rows || (Array.isArray(page) ? page : []);
    const rec = list.find(r => r.code === cfg.codeValue);
    assert.ok(rec, '列表应能查到刚保存的记录 ' + cfg.codeValue);
    const full = await api(cfg.recordPath + '/' + rec.id);
    const atts = JSON.parse(full.attachments || '[]');
    const withDir = atts.find(a => (a.dirs || []).length);
    assert.ok(withDir, '记录附件应含目录');
    assert.deepEqual(withDir.dirs, [cfg.expectedPaths[0]], '持久化 dirs 应与浏览器所选一致');
    return { id: rec.id, dirs: withDir.dirs };
  });

  // 编辑回显：重新打开编辑弹窗，附件目录标签应从库中还原
  await check(cfg.label + '：编辑弹窗回显已保存的附件目录', async () => {
    const page = await api(cfg.recordPath + '?pageNum=1&pageSize=100');
    const list = page.list || page.content || page.rows || (Array.isArray(page) ? page : []);
    const rec = list.find(r => r.code === cfg.codeValue);
    await browser.eval(`typeof openEditModal==='function' && openEditModal(${rec.id})`);
    await browser.wait(`document.querySelector('#createModal').classList.contains('show') && document.querySelector('#createAttachmentList .att-dir-tag')`, '编辑弹窗回显标签');
    const tags = await browser.eval(`Array.from(document.querySelectorAll('#createAttachmentList .att-dir-tag')).map(t=>t.getAttribute('data-path'))`);
    assert.ok(tags.includes(cfg.expectedPaths[0]), '编辑回显应包含已保存目录');
    await browser.eval(`closeModal('createModal')`);
    return { tags };
  });
}

async function verifyEngine(browser, cfg) {
  await browser.navigate(cfg.page);
  await browser.wait(`!!window.App && !!App.getToken() && document.querySelector('#fwNew')`, cfg.page + ' 引擎就绪');
  await browser.wait(`document.querySelector('#fwProject option[value="${cfg.projectId}"]')`, '项目字典加载');
  await browser.set('#fwProject', cfg.projectId, 'change');
  await browser.eval(`document.getElementById('fwNew').click()`);
  await browser.wait(`!document.getElementById('fwEditor').hidden`, '编辑器打开');

  await check(cfg.label + '：真实上传附件后出现“选择目录”入口', async () => {
    await browser.setFiles('#fwUpload', [SAMPLE]);
    await browser.wait(`Array.from(document.querySelectorAll('#fwMedia button')).some(b=>b.textContent==='选择目录')`, '附件选择目录按钮');
    return { ok: true };
  });

  await check(cfg.label + '：目录选择器候选 = 该项目全部有效末级目录', async () => {
    await browser.eval(`Array.from(document.querySelectorAll('#fwMedia button')).find(b=>b.textContent==='选择目录').click()`);
    await browser.wait(`document.getElementById('fwDirModal').classList.contains('show')`, '引擎目录弹窗');
    await browser.wait(`document.querySelectorAll('#fwDirTree .fwd-node.leaf').length>0 || document.getElementById('fwDirTree').textContent.includes('暂无工程资料目录')`, '引擎目录渲染');
    const shown = await browser.eval(`Array.from(document.querySelectorAll('#fwDirTree .fwd-node.leaf')).map(e=>e.getAttribute('data-path'))`);
    const tree = await api('/sub-item-databases/tree?projectId=' + cfg.projectId);
    const expected = computeActiveLeafPaths(tree, '');
    assert.deepEqual([...shown].sort(), [...expected].sort(), '引擎候选应与接口有效叶子一致');
    return { candidates: shown };
  });

  await check(cfg.label + '：选择目录写回附件并即时回显标签', async () => {
    const target = cfg.expectedPaths[0];
    await browser.eval(`(()=>{const n=document.querySelector('#fwDirTree .fwd-node.leaf[data-path="'+${JSON.stringify(target)}+'"]');if(!n)throw Error('无叶子 '+${JSON.stringify(target)});n.click();})()`);
    await browser.eval(`document.getElementById('fwDirOk').click()`);
    await browser.wait(`!document.getElementById('fwDirModal').classList.contains('show')`, '确认关闭');
    await browser.wait(`document.querySelectorAll('#fwMedia .fwd-tag').length>0`, '附件目录标签回显');
    const tags = await browser.eval(`Array.from(document.querySelectorAll('#fwMedia .fwd-tag')).map(t=>t.getAttribute('title'))`);
    assert.ok(tags.includes(target), '附件行应显示所选目录');
    return { tags };
  });

  // 保存草稿后经 API 复核 UI→DB 持久化（匹配本次上传文件名定位最新记录）
  await check(cfg.label + '：保存草稿后附件 dirs 持久化（UI→数据库）', async () => {
    await browser.eval(`document.getElementById('fwSave').click()`);
    await browser.wait(`document.getElementById('fwUploadState') && document.getElementById('fwUploadState').textContent.includes('请保存') || document.getElementById('fwUploadState').textContent.includes('已上传') || true`, '触发保存');
    await sleep(1500);
    const page = await api(cfg.recordPath + '?projectId=' + cfg.projectId + '&pageNum=1&pageSize=100');
    const list = page.list || page.content || page.rows || (Array.isArray(page) ? page : []);
    const rec = list.map(r => r.id != null ? r : null).filter(Boolean).map(r => r).find(() => true);
    // 逐个精确读取，定位包含本次上传文件名且带目录的附件记录（取 id 最大者）
    let found = null;
    const ids = list.map(r => r.id).filter(x => x != null).sort((a, b) => b - a).slice(0, 25);
    for (const id of ids) {
      const full = await api(cfg.recordPath + '/' + id);
      const atts = JSON.parse((full && full.attachments) || '[]');
      const hit = atts.find(a => a.name && a.name.includes('upload-sample') && (a.dirs || []).length);
      if (hit) { found = { id, dirs: hit.dirs }; break; }
    }
    assert.ok(found, '应能在服务器找到本次浏览器保存的、含目录的附件记录');
    assert.deepEqual(found.dirs, [cfg.expectedPaths[0]], '服务器持久化 dirs 应与浏览器所选一致');
    return found;
  });
}

(async () => {
  const run = randomUUID().slice(0, 8).replace(/-/g, 'x');
  token = (await api('/auth/login', 'POST', { username: 'admin', password: '123456' })).token;

  const project = await api('/projects', 'POST', { name: '浏览器目录验收项目-' + run, code: 'BDIR-' + run, buildUnit: '验收建设单位', status: 'active', managerId: 1 });
  const emptyProject = await api('/projects', 'POST', { name: '浏览器无目录项目-' + run, code: 'BEMPTY-' + run, buildUnit: '验收建设单位', status: 'active', managerId: 1 });
  const otherProject = await api('/projects', 'POST', { name: '浏览器跨项目对照-' + run, code: 'BOTHER-' + run, buildUnit: '验收建设单位', status: 'active', managerId: 1 });
  const rootA = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '主楼单位工程', sortOrder: 1 });
  await api('/sub-item-databases', 'POST', { projectId: project.id, parentId: rootA.id, name: '钢筋分项工程', sortOrder: 1 });
  const rootB = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '裙楼单位工程', sortOrder: 2 });
  await api('/sub-item-databases', 'POST', { projectId: project.id, parentId: rootB.id, name: '模板分项工程', sortOrder: 1 });
  const dropped = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '已删除目录', sortOrder: 3 });
  await api('/sub-item-databases/' + dropped.id, 'DELETE');
  await api('/sub-item-databases', 'POST', { projectId: otherProject.id, name: '跨项目目录', sortOrder: 1 });
  const treeData = await api('/sub-item-databases/tree?projectId=' + project.id);
  const expectedPaths = computeActiveLeafPaths(treeData, '');

  const page = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const browser = new Browser(ws);
  await browser.send('Page.enable'); await browser.send('Runtime.enable'); await browser.send('Network.enable'); await browser.send('DOM.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  // 干净登录
  await browser.navigate('login.html');
  await browser.eval(`localStorage.clear();sessionStorage.clear();`);
  await browser.navigate('login.html');
  await browser.set('#username', 'admin');
  await browser.set('#password', '123456');
  await browser.click('#loginBtn');
  await browser.wait(`!!window.App && !!App.getToken() && !location.pathname.endsWith('login.html')`, '真实登录');

  const common = { projectId: project.id, emptyProjectId: emptyProject.id, expectedPaths };
  const standalone = [
    { label: '工作联系单', page: 'work-contact.html', recordPath: '/work-contacts', codeField: 'contactCode', codeValue: 'WC-UI-' + run, fills: [{ id: 'sendDate', value: '2026-11-03' }, { id: 'receiverUnit', value: '验收接收单位' }, { id: 'contactContent', value: '浏览器验收内容' }] },
    { label: '会议纪要', page: 'meeting-minutes.html', recordPath: '/meeting-minutes', codeField: 'minutesNo', codeValue: 'MM-UI-' + run, fills: [{ id: 'meetingTime', value: '2026-11-03T09:00' }, { id: 'meetingTopic', value: '浏览器验收例会' }, { id: 'meetingContent', value: '浏览器验收内容' }] },
    { label: '监理月报', page: 'supervision-monthly-report.html', recordPath: '/supervision-monthly-reports', codeField: 'reportNo', codeValue: 'MR-UI-' + run, fills: [{ id: 'reportPeriod', value: '2026-11' }, { id: 'workSummary', value: '浏览器验收内容' }] }
  ];
  for (const cfg of standalone) { try { await verifyStandalone(browser, { ...cfg, ...common }); } catch (e) { results.push({ name: cfg.label + '（页面流程搭建）', pass: false, error: String(e.message || e) }); console.log('FAIL ' + cfg.label + ' 搭建 -> ' + (e.message || e)); try { await browser.eval(`closeModal('createModal');closeModal('dirTreeModal')`); } catch (_) {} } }
  const engine = [
    { label: '监理日记', page: 'supervision-diary.html', recordPath: '/supervision-diaries' },
    { label: '监理日志', page: 'supervision-log.html', recordPath: '/supervision-logs' }
  ];
  for (const cfg of engine) { try { await verifyEngine(browser, { ...cfg, ...common }); } catch (e) { results.push({ name: cfg.label + '（引擎流程搭建）', pass: false, error: String(e.message || e) }); console.log('FAIL ' + cfg.label + ' 搭建 -> ' + (e.message || e)); try { await browser.eval(`closeDirPicker&&closeDirPicker()`); } catch (_) {} } }

  await check('全程无 JS 运行时异常', async () => { assert.equal(browser.errors.length, 0, '异常：' + JSON.stringify(browser.errors.slice(0, 5))); return { errors: browser.errors.length }; });
  await check('全程无接口 4xx/5xx 错误', async () => { assert.equal(browser.httpErrors.length, 0, 'HTTP 错误：' + JSON.stringify(browser.httpErrors.slice(0, 8))); return { httpErrors: browser.httpErrors.length }; });

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const passed = results.filter(r => r.pass).length;
  console.log(`\n合计 ${passed}/${results.length} 通过`);
  if (passed !== results.length) process.exitCode = 1;
})().catch(e => { console.error('测试中断：', e.message); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2)); process.exitCode = 1; });
