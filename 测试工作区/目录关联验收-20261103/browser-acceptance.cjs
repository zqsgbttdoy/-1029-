// 真实浏览器（无头 Edge + CDP）逐页验收：常驻内嵌工程资料目录树。
// 默认使用隔离环境：静态页 BASE=http://127.0.0.1:18131，CDP=http://127.0.0.1:19250。
// 覆盖四个独立页面与四类 field-records.js 共用记录，验证上传前显示、默认继承、附件独立多选、保存和编辑回显。
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:18131';
const CDP = process.env.E2E_CDP || 'http://127.0.0.1:19250';
const SAMPLE = path.join(__dirname, 'upload-sample.txt');
const OUT = path.join(__dirname, 'results');
const EMPTY_TEXT = '暂无工程资料目录，请先在“工程资料目录设置”中创建';
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
async function poll(fn, label) {
  let lastError;
  for (let i = 0; i < 120; i++) {
    try { const value = await fn(); if (value) return value; } catch (e) { lastError = e; }
    await sleep(100);
  }
  throw new Error('等待超时：' + label + (lastError ? '；' + lastError.message : ''));
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
  async wait(expression, label) { for (let i = 0; i < 240; i++) { try { if (await this.eval(expression)) return; } catch (_) {} await sleep(100); } throw new Error('等待超时：' + label); }
  async navigate(page) { await this.send('Page.navigate', { url: BASE + '/' + page }); await this.wait(`location.pathname.endsWith(${JSON.stringify(page.split('?')[0])}) && document.readyState === 'complete'`, page); }
  async set(selector, value, event = 'input') { await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('缺控件 ${selector}');el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`); }
  async setBoth(selector, value) { await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('缺控件 ${selector}');el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async click(selector) { const pt = await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('不可点击 ${selector}');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`); await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pt }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pt }); }
  async setFiles(selector, files) { const doc = await this.send('DOM.getDocument'); const { nodeId } = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector }); if (!nodeId) throw new Error('找不到文件输入 ' + selector); await this.send('DOM.setFileInputFiles', { files, nodeId }); }
  async shot(name) { const img = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(img.data, 'base64')); }
}

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
function leafSelector(root, target) { return root + ' .leaf-node[data-path=' + JSON.stringify(target) + ']'; }
function tagSelector(root, target) { return root + ' .att-dir-tag[data-path=' + JSON.stringify(target) + ']'; }
async function readStyles(browser, root) {
  return browser.eval(`(()=>{
    const root=document.querySelector(${JSON.stringify(root)});if(!root)throw Error('缺目录组件 '+${JSON.stringify(root)});
    const section=root.matches('.doc-section')?root:(root.closest('.doc-section')||root.querySelector('.doc-section'));
    const els={section,tree:section.querySelector('.doc-tree'),row:section.querySelector('.doc-tree-node'),tag:section.querySelector('.selected-doc-tag'),selected:section.querySelector('.selected-docs'),checkbox:section.querySelector('input[type="checkbox"]')};
    const props={section:['backgroundColor','borderTopWidth','borderTopColor','borderRadius','padding','marginTop'],tree:['backgroundColor','borderTopWidth','borderRadius','padding','maxHeight','overflowY'],row:['padding','borderRadius','fontSize','display','alignItems','gap'],tag:['display','alignItems','gap','padding','borderRadius','fontSize','backgroundColor','color'],selected:['marginTop','display','flexWrap','gap','minHeight'],checkbox:['accentColor','width','height']};
    const out={};for(const k of Object.keys(props)){if(!els[k])throw Error('缺样式元素 '+k);const s=getComputedStyle(els[k]);out[k]={};for(const p of props[k])out[k][p]=s[p];}return out;
  })()`);
}
async function exerciseDefaultTree(browser, cfg, root) {
  await browser.click(root + ' .doc-parent-node');
  let parent = await browser.eval(`(()=>{const p=document.querySelector(${JSON.stringify(root + ' .doc-parent-node')});return{collapsed:p.nextElementSibling.classList.contains('collapsed'),icon:p.querySelector('.expand-icon').textContent};})()`);
  assert.deepEqual(parent, { collapsed: true, icon: '▶' });
  await browser.click(root + ' .doc-parent-node');
  parent = await browser.eval(`(()=>{const p=document.querySelector(${JSON.stringify(root + ' .doc-parent-node')});return{collapsed:p.nextElementSibling.classList.contains('collapsed'),icon:p.querySelector('.expand-icon').textContent};})()`);
  assert.deepEqual(parent, { collapsed: false, icon: '▼' });
  const selectedPaths = [cfg.expectedPaths[0], cfg.expectedPaths[2]];
  for (const target of selectedPaths) await browser.click(leafSelector(root, target));
  const state = await browser.eval(`(()=>{const h=document.querySelector(${JSON.stringify(root)});const parents=Array.from(h.querySelectorAll('.doc-parent-node input'));return{count:h.querySelector('.dir-selected-count').textContent,checked:h.querySelectorAll('input[data-label]:checked').length,tags:Array.from(h.querySelectorAll('.att-dir-tag')).map(t=>({path:t.getAttribute('data-path'),text:t.childNodes[0].nodeValue})),dirs:h._dirs,indeterminate:parents.some(p=>p.indeterminate)};})()`);
  assert.equal(state.count, '已选 2 项'); assert.equal(state.checked, 2);
  assert.deepEqual(state.tags.map(t => t.path), selectedPaths); assert.deepEqual(state.tags.map(t => t.text), selectedPaths);
  assert.deepEqual(state.dirs, selectedPaths); assert.ok(state.indeterminate, '部分子孙选中时父节点应半选');
  await browser.eval(`document.querySelector(${JSON.stringify(root)}).scrollIntoView({block:'center'})`);
  await browser.shot(cfg.label + '-常驻目录树');
  return state;
}
async function exerciseTag(browser, cfg, root) {
  const target = cfg.expectedPaths[2];
  await browser.eval(`(()=>{const c=document.querySelector(${JSON.stringify(leafSelector(root, target))});let p=c.closest('.doc-tree-children');while(p){p.classList.add('collapsed');p=p.parentElement.closest('.doc-tree-children');}})()`);
  await browser.click(tagSelector(root, target));
  const focused = await browser.eval(`(()=>{const c=document.activeElement;return{path:c&&c.getAttribute('data-label'),collapsed:c&&c.closest('.doc-tree-children').classList.contains('collapsed')};})()`);
  assert.deepEqual(focused, { path: target, collapsed: false }, '标签应展开祖先并聚焦对应复选框');
  await browser.click(tagSelector(root, target) + ' .remove-dir-tag');
  let state = await browser.eval(`(()=>{const h=document.querySelector(${JSON.stringify(root)});return{dirs:h._dirs,count:h.querySelector('.dir-selected-count').textContent};})()`);
  assert.deepEqual(state, { dirs: [cfg.expectedPaths[0]], count: '已选 1 项' });
  await browser.click(leafSelector(root, target));
  state = await browser.eval(`document.querySelector(${JSON.stringify(root)})._dirs`);
  assert.deepEqual(state, [cfg.expectedPaths[0], target]);
  return { focused, restored: state };
}
async function findStandaloneRecord(cfg) {
  const page = await api(cfg.recordPath + '?projectId=' + cfg.projectId + '&pageNum=1&pageSize=100');
  const list = page.list || page.content || page.rows || (Array.isArray(page) ? page : []);
  for (const rec of list.slice().sort((a, b) => b.id - a.id)) {
    if (cfg.codeValue && rec.code !== cfg.codeValue) continue;
    const full = await api(cfg.recordPath + '/' + rec.id);
    const atts = JSON.parse(full.attachments || '[]');
    const hit = atts.find(a => String(a.name || '').includes('upload-sample'));
    if (hit) return { id: rec.id, full, atts, hit };
  }
  return null;
}

async function verifyStandalone(browser, cfg) {
  await browser.navigate(cfg.page);
  await browser.wait(`!!window.App && !!App.getToken()`, cfg.page + ' 已登录');
  if (cfg.safety) {
    await browser.wait(`safetyProjectsReady && document.querySelector('#projectFilter option[value="${cfg.projectId}"]')`, '安全日志项目字典');
    await browser.set('#projectFilter', cfg.projectId, 'change');
  } else {
    await browser.wait(`document.querySelector('#projectSelect option[value="${cfg.projectId}"]')`, '项目字典加载');
  }
  await browser.eval(`openCreateModal()`);
  await browser.wait(`document.querySelector('#createModal').classList.contains('show')`, cfg.page + ' 新建表单');
  if (cfg.safety) { await browser.set('#projectSelect', '', 'change'); await browser.eval(`Promise.resolve(ensureDirTree())`); }

  await check(cfg.label + '：上传前常驻目录树位于附件前，未选项目提示统一且无旧弹窗', async () => {
    const data = await browser.eval(`(()=>{const h=document.querySelector(${JSON.stringify(cfg.defaultSelector)}),u=document.querySelector('#createAttachmentList');return{section:!!h,tree:!!h.querySelector('.doc-tree'),tags:!!h.querySelector('.selected-docs'),placeholder:h.querySelector('.doc-tree').textContent.trim(),before:!!(h.compareDocumentPosition(u)&Node.DOCUMENT_POSITION_FOLLOWING),attachments:document.querySelectorAll('#createAttachmentList .attachment-item').length,oldModal:!!document.getElementById('dirTreeModal')||!!document.getElementById('fwDirModal')};})()`);
    assert.ok(data.section && data.tree && data.tags && data.before); assert.equal(data.placeholder, EMPTY_TEXT);
    assert.equal(data.attachments, 0); assert.equal(data.oldModal, false); return data;
  });

  await browser.set('#projectSelect', cfg.projectId, 'change'); await browser.eval(`Promise.resolve(ensureDirTree())`);
  await browser.wait(`document.querySelectorAll(${JSON.stringify(cfg.defaultSelector + ' .leaf-node')}).length > 0`, '默认目录树加载');
  await check(cfg.label + '：项目自动加载全部有效末级目录，父节点禁用且复选框真实可用', async () => {
    const shown = await browser.eval(`Array.from(document.querySelectorAll(${JSON.stringify(cfg.defaultSelector + ' .leaf-node')})).map(e=>e.getAttribute('data-path'))`);
    const tree = await api('/sub-item-databases/tree?projectId=' + cfg.projectId);
    assert.deepEqual([...shown].sort(), computeActiveLeafPaths(tree, '').sort());
    assert.ok(!shown.some(p => p.includes('已删除目录') || p.includes('跨项目目录')));
    const controls = await browser.eval(`(()=>{const h=document.querySelector(${JSON.stringify(cfg.defaultSelector)});return{leaves:h.querySelectorAll('.leaf-node input[data-label]').length,parentsDisabled:Array.from(h.querySelectorAll('.doc-parent-node input')).every(c=>c.disabled)};})()`);
    assert.equal(controls.leaves, shown.length); assert.ok(controls.parentsDisabled); return { candidates: shown, controls };
  });

  await check(cfg.label + '：空目录项目提示统一，切回后无跨项目污染', async () => {
    try {
      await browser.set('#projectSelect', cfg.emptyProjectId, 'change'); await browser.eval(`Promise.resolve(ensureDirTree())`);
      await browser.wait(`document.querySelector(${JSON.stringify(cfg.defaultSelector + ' .doc-tree')}).textContent.includes(${JSON.stringify(EMPTY_TEXT)})`, '空目录提示');
      const empty = await browser.eval(`document.querySelectorAll(${JSON.stringify(cfg.defaultSelector + ' .leaf-node')}).length`);
      assert.equal(empty, 0);
    } finally {
      await browser.set('#projectSelect', cfg.projectId, 'change'); await browser.eval(`Promise.resolve(ensureDirTree())`);
      await browser.wait(`document.querySelectorAll(${JSON.stringify(cfg.defaultSelector + ' .leaf-node')}).length > 0`, '切回项目目录');
    }
    const paths = await browser.eval(`Array.from(document.querySelectorAll(${JSON.stringify(cfg.defaultSelector + ' .leaf-node')})).map(e=>e.getAttribute('data-path'))`);
    assert.ok(paths.every(p => cfg.expectedPaths.includes(p))); return { paths };
  });

  await check(cfg.label + '：常驻树展开收起、多选、父节点半选、计数及完整路径蓝标签', async () => exerciseDefaultTree(browser, cfg, cfg.defaultSelector));
  await check(cfg.label + '：点击标签自动展开定位，✕ 仅删除该项且可重新选择', async () => exerciseTag(browser, cfg, cfg.defaultSelector));
  await check(cfg.label + '：目录组件关键计算样式与监理通知单逐像素值一致', async () => {
    const actual = await readStyles(browser, cfg.defaultSelector); assert.deepEqual(actual, cfg.noticeStyles); return { matched: true };
  });

  await check(cfg.label + '：新附件继承默认目录，附件内嵌树可独立修改且不影响默认树', async () => {
    await browser.setFiles('#createFileInput', [SAMPLE]);
    await browser.wait(`document.querySelector('#createAttachmentList .attachment-item[data-url]') && document.querySelectorAll('#createAttachmentList .attachment-item .leaf-node').length > 0`, '附件上传及内嵌树加载');
    const root = '#createAttachmentList .attachment-item';
    let state = await browser.eval(`(()=>{const h=document.querySelector(${JSON.stringify(root)});return{dirs:h._dirs,section:!!h.querySelector('.doc-section.attachment-dir-section')};})()`);
    assert.deepEqual(state.dirs, [cfg.expectedPaths[0], cfg.expectedPaths[2]]); assert.ok(state.section);
    await browser.click(leafSelector(root, cfg.expectedPaths[2]));
    state = await browser.eval(`(()=>{const a=document.querySelector(${JSON.stringify(root)}),d=document.querySelector(${JSON.stringify(cfg.defaultSelector)});return{attachment:a._dirs,defaults:d._dirs,count:a.querySelector('.dir-selected-count').textContent,tags:Array.from(a.querySelectorAll('.att-dir-tag')).map(t=>t.getAttribute('data-path'))};})()`);
    assert.deepEqual(state.attachment, [cfg.expectedPaths[0]]); assert.deepEqual(state.defaults, [cfg.expectedPaths[0], cfg.expectedPaths[2]]);
    assert.equal(state.count, '已选 1 项'); assert.deepEqual(state.tags, [cfg.expectedPaths[0]]);
    await browser.eval(`document.querySelector(${JSON.stringify(root)}).scrollIntoView({block:'center'})`); await browser.shot(cfg.label + '-附件独立目录树');
    return state;
  });

  let recordId;
  await check(cfg.label + '：保存后附件级 dirs 真实持久化（UI→数据库）', async () => {
    if (cfg.codeField) await browser.set('#' + cfg.codeField, cfg.codeValue);
    for (const f of cfg.fills || []) await browser.set('#' + f.id, f.value);
    await browser.eval(`Promise.resolve(saveDraft())`);
    await browser.wait(`!document.querySelector('#createModal').classList.contains('show')`, '保存关闭表单');
    const saved = await poll(() => findStandaloneRecord(cfg), cfg.label + ' 保存记录');
    assert.deepEqual(saved.hit.dirs, [cfg.expectedPaths[0]]); recordId = saved.id;
    return { id: saved.id, dirs: saved.hit.dirs };
  });
  assert.ok(recordId, cfg.label + ' 未产生可编辑记录');

  await check(cfg.label + '：编辑自动加载内嵌树并准确回显已保存目录', async () => {
    if (cfg.safety) {
      await browser.eval(`Promise.resolve(loadData())`);
      await browser.wait(`filteredData.some(r=>String(r.id)===${JSON.stringify(String(recordId))})`, '安全日志列表回显');
      await browser.eval(`Promise.resolve(openEditModal(filteredData.findIndex(r=>String(r.id)===${JSON.stringify(String(recordId))})+1))`);
    } else {
      await browser.wait(`allData.some(r=>String(r.id)===${JSON.stringify(String(recordId))})`, '列表重新加载');
      await browser.eval(`openEditModal(${recordId})`);
    }
    await browser.wait(`document.querySelectorAll('#createAttachmentList input[data-label]:checked').length === 1 && document.querySelectorAll('#createAttachmentList .att-dir-tag').length === 1`, '编辑内嵌树回显');
    const state = await browser.eval(`(()=>{const h=document.querySelector('#createAttachmentList .attachment-item');return{dirs:h._dirs,tags:Array.from(h.querySelectorAll('.att-dir-tag')).map(t=>t.childNodes[0].nodeValue),oldModal:!!document.getElementById('dirTreeModal')};})()`);
    assert.deepEqual(state.dirs, [cfg.expectedPaths[0]]); assert.deepEqual(state.tags, [cfg.expectedPaths[0]]); assert.equal(state.oldModal, false); return state;
  });
}

async function findEngineRecord(cfg) {
  const page = await api(cfg.recordPath + '?projectId=' + cfg.projectId + '&pageNum=1&pageSize=100');
  const list = page.list || page.content || page.rows || (Array.isArray(page) ? page : []);
  for (const rec of list.slice().sort((a, b) => b.id - a.id)) {
    const full = await api(cfg.recordPath + '/' + rec.id);
    const atts = JSON.parse(full.attachments || '[]');
    const hit = atts.find(a => String(a.name || '').includes('upload-sample'));
    if (hit) return { id: rec.id, full, hit };
  }
  return null;
}

async function verifyEngine(browser, cfg) {
  await browser.navigate(cfg.page);
  await browser.wait(`!!window.App && !!App.getToken() && document.querySelector('#fwNew')`, cfg.page + ' 引擎就绪');
  await browser.wait(`document.querySelector('#fwProject option[value="${cfg.projectId}"]')`, '项目字典加载');
  await browser.set('#fwProject', cfg.projectId, 'change');
  await browser.eval(`document.getElementById('fwNew').click()`);
  await browser.wait(`!document.getElementById('fwEditor').hidden && document.querySelector('#fwDefaultDirSection')`, '编辑器及常驻目录树打开');
  if (cfg.hasTemplate) {
    await browser.wait(`document.querySelectorAll('#fwDefaultDirSection .leaf-node').length > 0`, '表单外项目自动加载目录');
  } else {
    await browser.setBoth('#fwF-projectId', '');
    await browser.wait(`document.querySelector('#fwDefaultDirSection .doc-tree').textContent.includes(${JSON.stringify(EMPTY_TEXT)})`, '未选项目提示');
  }

  await check(cfg.label + '：上传前常驻目录树位于附件前，未选项目提示统一且无旧弹窗', async () => {
    const data = await browser.eval(`(()=>{const h=document.getElementById('fwDefaultDirSection'),u=document.getElementById('fwUploadField');return{tree:!!h.querySelector('.doc-tree'),tags:!!h.querySelector('.selected-docs'),placeholder:h.querySelector('.doc-tree').textContent.trim(),before:!!(h.compareDocumentPosition(u)&Node.DOCUMENT_POSITION_FOLLOWING),attachments:document.querySelectorAll('#fwMedia .attachment-dir-section').length,oldModal:!!document.getElementById('fwDirModal')||!!document.getElementById('dirTreeModal')};})()`);
    assert.ok(data.tree && data.tags && data.before); if (!cfg.hasTemplate) assert.equal(data.placeholder, EMPTY_TEXT); assert.equal(data.attachments, 0); assert.equal(data.oldModal, false); return data;
  });

  if (!cfg.hasTemplate) await browser.setBoth('#fwF-projectId', cfg.projectId);
  await browser.wait(`document.querySelectorAll('#fwDefaultDirSection .leaf-node').length > 0`, '默认目录树加载');
  await check(cfg.label + '：项目自动加载全部有效末级目录，父节点禁用且复选框真实可用', async () => {
    const shown = await browser.eval(`Array.from(document.querySelectorAll('#fwDefaultDirSection .leaf-node')).map(e=>e.getAttribute('data-path'))`);
    const tree = await api('/sub-item-databases/tree?projectId=' + cfg.projectId);
    assert.deepEqual([...shown].sort(), computeActiveLeafPaths(tree, '').sort());
    const controls = await browser.eval(`(()=>{const h=document.getElementById('fwDefaultDirSection');return{leaves:h.querySelectorAll('.leaf-node input[data-label]').length,parentsDisabled:Array.from(h.querySelectorAll('.doc-parent-node input')).every(c=>c.disabled)};})()`);
    assert.equal(controls.leaves, shown.length); assert.ok(controls.parentsDisabled); return { candidates: shown };
  });

  await check(cfg.label + '：空目录项目提示统一，切回后无跨项目污染', async () => {
    try {
      if (cfg.hasTemplate) {
        await browser.eval(`document.getElementById('fwCancel').click()`);
        await browser.wait(`document.getElementById('fwEditor').hidden`, '关闭当前编辑器');
        await browser.set('#fwProject', cfg.emptyProjectId, 'change');
        await browser.eval(`document.getElementById('fwNew').click()`);
      } else await browser.setBoth('#fwF-projectId', cfg.emptyProjectId);
      await browser.wait(`!document.getElementById('fwEditor').hidden && document.querySelector('#fwDefaultDirSection .doc-tree').textContent.includes(${JSON.stringify(EMPTY_TEXT)})`, '空目录提示');
      assert.equal(await browser.eval(`document.querySelectorAll('#fwDefaultDirSection .leaf-node').length`), 0);
    } finally {
      if (cfg.hasTemplate) {
        await browser.eval(`document.getElementById('fwCancel').click()`);
        await browser.wait(`document.getElementById('fwEditor').hidden`, '关闭空目录编辑器');
        await browser.set('#fwProject', cfg.projectId, 'change');
        await browser.eval(`document.getElementById('fwNew').click()`);
      } else await browser.setBoth('#fwF-projectId', cfg.projectId);
      await browser.wait(`!document.getElementById('fwEditor').hidden && document.querySelectorAll('#fwDefaultDirSection .leaf-node').length > 0`, '切回项目目录');
    }
    const paths = await browser.eval(`Array.from(document.querySelectorAll('#fwDefaultDirSection .leaf-node')).map(e=>e.getAttribute('data-path'))`);
    assert.ok(paths.every(p => cfg.expectedPaths.includes(p))); return { paths };
  });

  await check(cfg.label + '：常驻树展开收起、多选、父节点半选、计数及完整路径蓝标签', async () => exerciseDefaultTree(browser, cfg, '#fwDefaultDirSection'));
  await check(cfg.label + '：点击标签自动展开定位，✕ 仅删除该项且可重新选择', async () => exerciseTag(browser, cfg, '#fwDefaultDirSection'));
  await check(cfg.label + '：目录组件关键计算样式与监理通知单逐像素值一致', async () => {
    const actual = await readStyles(browser, '#fwDefaultDirSection'); assert.deepEqual(actual, cfg.noticeStyles); return { matched: true };
  });

  await check(cfg.label + '：新附件继承默认目录，附件内嵌树可独立修改且不影响默认树', async () => {
    await browser.setFiles('#fwUpload', [SAMPLE]);
    await browser.wait(`document.querySelector('#fwMedia .attachment-dir-section') && document.querySelectorAll('#fwMedia .attachment-dir-section .leaf-node').length > 0 && document.getElementById('fwUploadState').textContent.includes('全部附件已上传')`, '附件上传及内嵌树加载');
    const root = '#fwMedia .attachment-dir-section';
    let state = await browser.eval(`document.querySelector(${JSON.stringify(root)})._dirs`);
    assert.deepEqual(state, [cfg.expectedPaths[0], cfg.expectedPaths[2]]);
    await browser.click(leafSelector(root, cfg.expectedPaths[2]));
    state = await browser.eval(`(()=>{const a=document.querySelector(${JSON.stringify(root)}),d=document.getElementById('fwDefaultDirSection');return{attachment:a._dirs,stored:a._attachment.dirs,defaults:d._dirs,count:a.querySelector('.dir-selected-count').textContent};})()`);
    assert.deepEqual(state.attachment, [cfg.expectedPaths[0]]); assert.deepEqual(state.stored, [cfg.expectedPaths[0]]);
    assert.deepEqual(state.defaults, [cfg.expectedPaths[0], cfg.expectedPaths[2]]); assert.equal(state.count, '已选 1 项');
    await browser.eval(`document.querySelector(${JSON.stringify(root)}).scrollIntoView({block:'center'})`); await browser.shot(cfg.label + '-附件独立目录树');
    return state;
  });

  let recordId;
  await check(cfg.label + '：保存草稿后附件级 dirs 真实持久化（UI→数据库）', async () => {
    await browser.eval(`document.getElementById('fwSave').click()`);
    const saved = await poll(() => findEngineRecord(cfg), cfg.label + ' 保存记录');
    assert.deepEqual(saved.hit.dirs, [cfg.expectedPaths[0]]); recordId = saved.id;
    return { id: saved.id, dirs: saved.hit.dirs };
  });
  assert.ok(recordId, cfg.label + ' 未产生可编辑记录');

  await check(cfg.label + '：重新打开编辑时内嵌树准确回显附件目录', async () => {
    await browser.navigate(cfg.page + '?id=' + recordId);
    await browser.wait(`!document.getElementById('fwEditor').hidden && document.querySelectorAll('#fwMedia .attachment-dir-section input[data-label]:checked').length === 1`, '编辑内嵌树回显');
    const state = await browser.eval(`(()=>{const h=document.querySelector('#fwMedia .attachment-dir-section');return{dirs:h._dirs,tags:Array.from(h.querySelectorAll('.att-dir-tag')).map(t=>t.childNodes[0].nodeValue),oldModal:!!document.getElementById('fwDirModal')};})()`);
    assert.deepEqual(state.dirs, [cfg.expectedPaths[0]]); assert.deepEqual(state.tags, [cfg.expectedPaths[0]]); assert.equal(state.oldModal, false); return state;
  });

  await check(cfg.label + '：只读记录目录复选框全部禁用且不显示删除标签按钮', async () => {
    await browser.navigate(cfg.page + '?id=' + recordId + '&readonly=true');
    await browser.wait(`!document.getElementById('fwEditor').hidden && document.querySelector('#fwMedia .attachment-dir-section input[data-label]')`, '只读目录树回显');
    const state = await browser.eval(`(()=>{const h=document.querySelector('#fwMedia .attachment-dir-section');return{disabled:Array.from(h.querySelectorAll('input[type="checkbox"]')).every(c=>c.disabled),removeButtons:h.querySelectorAll('.remove-dir-tag').length,tags:h.querySelectorAll('.att-dir-tag').length};})()`);
    assert.deepEqual(state, { disabled: true, removeButtons: 0, tags: 1 }); return state;
  });
}

async function captureNoticeBaseline(browser, cfg) {
  let styles;
  await check('监理通知单：基准目录树加载、多选与截图', async () => {
    await browser.navigate('supervision-notice.html');
    await browser.wait(`!!window.App && !!App.getToken() && document.querySelector('#projectSelect option[value="${cfg.projectId}"]')`, '通知单项目字典');
    await browser.eval(`openCreateModal()`); await browser.set('#projectSelect', cfg.projectId, 'change');
    await browser.wait(`document.querySelectorAll('#docTree .doc-leaf-node').length > 0`, '通知单目录加载');
    for (const target of [cfg.expectedPaths[0], cfg.expectedPaths[2]]) await browser.click(`#docTree .doc-leaf-node input[data-label=${JSON.stringify(target)}]`);
    await browser.wait(`document.querySelectorAll('#selectedDocs .selected-doc-tag').length === 2`, '通知单多选标签');
    styles = await readStyles(browser, '#docTree');
    await browser.eval(`document.getElementById('docTree').closest('.doc-section').scrollIntoView({block:'center'})`);
    await browser.shot('00-监理通知单目录树基准'); return { count: '已选 2 项' };
  });
  assert.ok(styles, '通知单基准样式读取失败'); return styles;
}

(async () => {
  const run = randomUUID().slice(0, 8).replace(/-/g, 'x');
  token = (await api('/auth/login', 'POST', { username: 'admin', password: '123456' })).token;
  const project = await api('/projects', 'POST', { name: '浏览器目录验收项目-' + run, code: 'BDIR-' + run, buildUnit: '验收建设单位', status: 'active', managerId: 1 });
  const emptyProject = await api('/projects', 'POST', { name: '浏览器无目录项目-' + run, code: 'BEMPTY-' + run, buildUnit: '验收建设单位', status: 'active', managerId: 1 });
  const otherProject = await api('/projects', 'POST', { name: '浏览器跨项目对照-' + run, code: 'BOTHER-' + run, buildUnit: '验收建设单位', status: 'active', managerId: 1 });
  const rootA = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '主楼单位工程', sortOrder: 1 });
  const leafA = await api('/sub-item-databases', 'POST', { projectId: project.id, parentId: rootA.id, name: '钢筋分项工程', sortOrder: 1 });
  await api('/sub-item-databases', 'POST', { projectId: project.id, parentId: rootA.id, name: '混凝土分项工程', sortOrder: 2 });
  const rootB = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '裙楼单位工程', sortOrder: 2 });
  await api('/sub-item-databases', 'POST', { projectId: project.id, parentId: rootB.id, name: '模板分项工程', sortOrder: 1 });
  const dropped = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '已删除目录', sortOrder: 3 });
  await api('/sub-item-databases/' + dropped.id, 'DELETE');
  await api('/sub-item-databases', 'POST', { projectId: otherProject.id, name: '跨项目目录', sortOrder: 1 });
  const treeData = await api('/sub-item-databases/tree?projectId=' + project.id);
  const expectedPaths = computeActiveLeafPaths(treeData, '');
  assert.equal(expectedPaths.length, 3, '验收目录应含三个有效叶子');

  const page = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const browser = new Browser(ws);
  await browser.send('Page.enable'); await browser.send('Runtime.enable'); await browser.send('Network.enable'); await browser.send('DOM.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  await browser.navigate('login.html');
  await browser.eval(`localStorage.clear();sessionStorage.clear();`);
  await browser.navigate('login.html');
  await browser.set('#username', 'admin'); await browser.set('#password', '123456'); await browser.click('#loginBtn');
  await browser.wait(`!!window.App && !!App.getToken() && !location.pathname.endsWith('login.html')`, '真实登录');

  const common = { projectId: project.id, emptyProjectId: emptyProject.id, expectedPaths };
  common.noticeStyles = await captureNoticeBaseline(browser, common);
  const standalone = [
    { label: '工作联系单', page: 'work-contact.html', recordPath: '/work-contacts', defaultSelector: '#contactDirSection', codeField: 'contactCode', codeValue: 'WC-UI-' + run, fills: [{ id: 'sendDate', value: '2026-11-03' }, { id: 'receiverUnit', value: '验收接收单位' }, { id: 'contactContent', value: '浏览器验收内容' }] },
    { label: '会议纪要', page: 'meeting-minutes.html', recordPath: '/meeting-minutes', defaultSelector: '#defaultDirSection', codeField: 'minutesNo', codeValue: 'MM-UI-' + run, fills: [{ id: 'meetingTime', value: '2026-11-03T09:00' }, { id: 'meetingTopic', value: '浏览器验收例会' }, { id: 'meetingContent', value: '浏览器验收内容' }] },
    { label: '监理月报', page: 'supervision-monthly-report.html', recordPath: '/supervision-monthly-reports', defaultSelector: '#defaultDirSection', codeField: 'reportNo', codeValue: 'MR-UI-' + run, fills: [{ id: 'reportPeriod', value: '2026-11' }, { id: 'workSummary', value: '浏览器验收内容' }] },
    { label: '监理安全日志', page: 'safety-log.html', recordPath: '/safety-logs', defaultSelector: '#defaultDirSection', safety: true, fills: [{ id: 'safetyContent', value: '浏览器验收内容' }] }
  ];
  for (const cfg of standalone) {
    try { await verifyStandalone(browser, { ...cfg, ...common }); }
    catch (e) { results.push({ name: cfg.label + '（页面流程搭建）', pass: false, error: String(e.message || e) }); console.log('FAIL ' + cfg.label + ' 搭建 -> ' + (e.message || e)); }
  }
  const engine = [
    { label: '日常巡检', page: 'daily-inspection.html', recordPath: '/daily-inspections' },
    { label: '旁站检查', page: 'sideline-inspection.html', recordPath: '/sideline-inspections' },
    { label: '监理日记', page: 'supervision-diary.html', recordPath: '/supervision-diaries', hasTemplate: true },
    { label: '监理日志', page: 'supervision-log.html', recordPath: '/supervision-logs', hasTemplate: true }
  ];
  for (const cfg of engine) {
    try { await verifyEngine(browser, { ...cfg, ...common }); }
    catch (e) { results.push({ name: cfg.label + '（引擎流程搭建）', pass: false, error: String(e.message || e) }); console.log('FAIL ' + cfg.label + ' 搭建 -> ' + (e.message || e)); }
  }

  const contactList = await api('/work-contacts?projectId=' + project.id + '&pageNum=1&pageSize=100');
  const contactRecord = contactList.list.find(r => r.code === 'WC-UI-' + run);
  assert.ok(contactRecord, '应找到浏览器创建的工作联系单');
  const traceFile = JSON.parse(contactRecord.attachments || '[]')[0];
  const traceAttachments = JSON.stringify([{ url: traceFile.url, name: '目录来源验收.txt', dirs: [expectedPaths[0]] }]);
  const direct = await api('/project-documents', 'POST', { projectId: project.id, subItemId: leafA.id, name: '直接上传来源验收', filePath: traceFile.url });
  const notice = await api('/supervision-notices', 'POST', { code: 'NT-TRACE-' + run, projectId: project.id, noticeDate: '2026-11-04', title: '目录来源通知单', content: '验收', attachments: traceAttachments });
  const safety = await api('/safety-logs', 'POST', { code: 'SF-TRACE-' + run, projectId: project.id, logDate: '2026-11-04', title: '目录来源安全日志', content: '验收', attachments: traceAttachments });
  const daily = await api('/daily-inspections', 'POST', { projectId: project.id, inspectionDate: '2026-11-04', location: '目录来源巡检部位', content: '验收', attachments: traceAttachments });
  const sideline = await api('/sideline-inspections', 'POST', { projectId: project.id, inspectionDate: '2026-11-04', location: '目录来源旁站部位', content: '验收', attachments: traceAttachments });
  const meeting = (await api('/meeting-minutes?projectId=' + project.id + '&pageNum=1&pageSize=100')).list.find(r => r.code === 'MM-UI-' + run);
  const monthly = (await api('/supervision-monthly-reports?projectId=' + project.id + '&pageNum=1&pageSize=100')).list.find(r => r.code === 'MR-UI-' + run);
  const diary = (await api('/supervision-diaries?projectId=' + project.id + '&pageNum=1&pageSize=100')).list[0];
  const log = (await api('/supervision-logs?projectId=' + project.id + '&pageNum=1&pageSize=100')).list[0];

  await check('目录树节点返回附件统计与十类来源分布', async () => {
    const tree = await api('/sub-item-databases/tree?projectId=' + project.id);
    const root = tree.find(n => n.id === rootA.id);
    assert.equal(root.attachmentCount, 13); assert.equal(root.recordCount, 13); assert.equal(root.sourceDistribution.length, 10);
    return { attachmentCount: root.attachmentCount, recordCount: root.recordCount, sources: root.sourceDistribution.map(s => s.sourceType) };
  });
  await browser.navigate('sub-item-database.html');
  await browser.wait(`document.querySelector('#projectSelect option[value="${project.id}"]')`, '目录设置项目字典');
  await browser.set('#projectSelect', project.id, 'change');
  await browser.wait(`document.querySelector('.tree-node[data-id="${leafA.id}"]')`, '目录树节点');
  await browser.click('.tree-node[data-id="' + leafA.id + '"]');
  await browser.wait(`document.querySelector('#sourceModal').classList.contains('show') && document.querySelectorAll('#sourceGroups .source-group').length === 10`, '十类来源分组');
  await check('目录详情按十类来源展示记录、附件和单据入口', async () => {
    const data = await browser.eval(`(()=>({path:document.getElementById('sourceDirectoryPath').textContent,groups:Array.from(document.querySelectorAll('#sourceGroups .source-group-title')).map(e=>e.textContent),links:Array.from(document.querySelectorAll('#sourceGroups .source-record-link')).map(a=>a.getAttribute('href')),files:document.querySelectorAll('#sourceGroups [data-file-url]').length}))()`);
    assert.ok(data.path.includes(expectedPaths[0])); assert.equal(data.groups.length, 10); assert.equal(data.links.length, 13); assert.equal(data.files, 13);
    assert.ok(data.links.some(h => h === 'work-contact.html?id=' + contactRecord.id + '&readonly=true'));
    await browser.shot('90-目录数据来源十类分组'); return data;
  });
  await check('点击工作联系单来源链接可打开对应只读单据', async () => {
    await browser.eval(`(()=>{const a=Array.from(document.querySelectorAll('#sourceGroups .source-record-link')).find(a=>a.getAttribute('href').startsWith('work-contact.html'));a.removeAttribute('target');a.click();})()`);
    await browser.wait(`location.pathname.endsWith('work-contact.html') && document.querySelector('#viewModal').classList.contains('show') && document.querySelector('#viewModal').textContent.includes(${JSON.stringify(contactRecord.code)})`, '联系单深链详情');
    return { id: contactRecord.id, code: contactRecord.code };
  });

  const deepLinks = [
    { name: '监理通知单', page: 'supervision-notice.html?id=' + notice.id + '&readonly=true', ready: `document.querySelector('#viewModal').classList.contains('show') && document.getElementById('viewCode').textContent===${JSON.stringify(notice.code)}` },
    { name: '监理日记', page: 'supervision-diary.html?id=' + diary.id + '&readonly=true', ready: `!document.getElementById('fwEditor').hidden` },
    { name: '监理日志', page: 'supervision-log.html?id=' + log.id + '&readonly=true', ready: `!document.getElementById('fwEditor').hidden` },
    { name: '监理安全日志', page: 'safety-log.html?id=' + safety.id + '&readonly=true', ready: `document.querySelector('#viewModal').classList.contains('show') && !!document.querySelector('#viewModal .version-view-panel')` },
    { name: '会议纪要', page: 'meeting-minutes.html?id=' + meeting.id + '&readonly=true', ready: `document.querySelector('#viewModal').classList.contains('show') && document.querySelector('#viewModal').textContent.includes(${JSON.stringify(meeting.code)})` },
    { name: '监理月报', page: 'supervision-monthly-report.html?id=' + monthly.id + '&readonly=true', ready: `document.querySelector('#viewModal').classList.contains('show') && document.querySelector('#viewModal').textContent.includes(${JSON.stringify(monthly.code)})` },
    { name: '日常巡检', page: 'daily-inspection.html?id=' + daily.id + '&readonly=true', ready: `!document.getElementById('fwEditor').hidden` },
    { name: '旁站检查', page: 'sideline-inspection.html?id=' + sideline.id + '&readonly=true', ready: `!document.getElementById('fwEditor').hidden` },
    { name: '直接上传', page: 'project-data-upload.html?projectId=' + project.id + '&subItemId=' + leafA.id + '&id=' + direct.id, ready: `String(currentProjectId)===${JSON.stringify(String(project.id))} && String(currentSubItemId)===${JSON.stringify(String(leafA.id))} && document.getElementById('existingFileList').textContent.includes('直接上传来源验收')` }
  ];
  for (const link of deepLinks) {
    await check(link.name + '来源深链可打开对应记录', async () => {
      await browser.navigate(link.page); await browser.wait(link.ready, link.name + '深链详情'); return { page: link.page };
    });
  }

  await check('全程无 JS 运行时异常', async () => { assert.equal(browser.errors.length, 0, '异常：' + JSON.stringify(browser.errors.slice(0, 5))); return { errors: browser.errors.length }; });
  await check('全程无接口 4xx/5xx 错误', async () => { assert.equal(browser.httpErrors.length, 0, 'HTTP 错误：' + JSON.stringify(browser.httpErrors.slice(0, 8))); return { httpErrors: browser.httpErrors.length }; });

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const passed = results.filter(r => r.pass).length, rate = results.length ? passed / results.length * 100 : 0;
  console.log(`\n合计 ${passed}/${results.length} 通过，通过率 ${rate.toFixed(2)}%`);
  ws.close();
  if (rate < 95) process.exitCode = 1;
})().catch(e => { console.error('测试中断：', e.message); fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2)); process.exit(1); });
