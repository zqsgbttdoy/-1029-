const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../utils/diary-links');
const item = { type: 'file', sourceType: 'project-documents', sourceId: 12, file: '/api/uploads/20261030/file_A.jpg', name: '中文(括号)[复核]\\照片.jpg' };
const raw = L.format(item), base = 'https://test.example.invalid';
const tick = () => new Promise(resolve => setImmediate(resolve));
const copy = value => JSON.parse(JSON.stringify(value));
function setData(data, patch) {
  Object.entries(patch).forEach(([key, value]) => {
    const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = data;
    parts.slice(0, -1).forEach(k => { if (!target[k]) target[k] = {}; target = target[k]; });
    target[parts.at(-1)] = copy(value);
  });
}
function harness(component, value = '') {
  let def, uid = '1', resolveAccess, clipReads = 0;
  const calls = [], changes = [], clipboard = [];
  const api = {
    userId: () => uid, session: () => ({ token: 'token-' + uid }),
    referenceAccess: async (ref, project) => { calls.push(['access', ref, project]); return { name: item.name, projectId: 7 }; },
    referenceUrl: ref => base + '/' + L.stable(ref), openReference: async ref => { calls.push(['open', ref]); },
    request: async (url, method, params) => { calls.push([url, params]); return { list: [], total: 0 }; }
  };
  const wx = { getClipboardData: options => { clipReads++; options.success({ data: base + '/' + L.stable(item) }); },
    setClipboardData: options => clipboard.push(options.data), showToast() {}, showModal() {} };
  const source = fs.readFileSync(path.join(__dirname, '../components', component, 'index.js'), 'utf8');
  vm.runInNewContext(source, { Component: d => { def = d; }, require: name => {
    if (name.endsWith('/diary-links')) return L; if (name.endsWith('/api')) return api; if (name.endsWith('/config')) return { baseUrl: base }; throw new Error(name);
  }, wx });
  const c = Object.assign({}, def.methods, { data: copy(def.data), properties: { value, readonly: false, disabled: false, projectId: 7, date: '2026-10-30', context: 'local:1' },
    setData(patch) { setData(this.data, patch); }, triggerEvent(name, detail) { changes.push(copy(detail.value)); } });
  def.lifetimes.attached.call(c);
  return { c, api, def, calls, changes, clipboard, get clipReads() { return clipReads; }, switchUser() { uid = '2'; }, deferAccess() { api.referenceAccess = () => new Promise(resolve => { resolveAccess = resolve; }); }, resolveAccess() { resolveAccess({ name: item.name, projectId: 7 }); } };
}
const event = (index, value, cursor) => ({ currentTarget: { dataset: { index } }, detail: { value, cursor } });

test('共用受限编码器保留特殊文件名和正文原位顺序', () => {
  assert.equal(L.serialize(L.parse('前文\n' + raw + '\n后文')), '前文\n' + raw + '\n后文');
  assert.equal(L.parse(raw)[0].name, item.name);
  assert.deepEqual(L.editableNodes(raw + raw).map(n => n.type), ['text', 'file', 'text', 'file', 'text']);
  assert.equal(L.serialize(L.editableNodes(raw + raw)), raw + raw);
});
test('历史裸网址不是引用，用户粘贴时才识别同部署稳定地址', () => {
  const url = base + '/' + L.stable(item);
  assert.equal(L.parse(url)[0].type, 'text');
  assert.equal(L.pasted('之前 ' + url + ' 之后', base)[1].type, 'file');
  assert.equal(L.pasted('https://evil.invalid/' + L.stable(item), base)[0].type, 'text');
  assert.equal(L.pasted(base + '.evil.invalid/' + L.stable(item), base)[0].type, 'text');
  assert.equal(L.pasted('之前' + url + '之后', base)[1].type, 'file');
  for (const prefix of ['../', '/', 'javascript:', '//evil.invalid/', 'subdir/']) assert.equal(L.pasted(prefix + L.stable(item), base)[0].type, 'text');
});
test('危险协议、重复参数、跨目录、越界路径及未知源不能形成引用', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.invalid/' + L.stable(item), '../' + L.stable(item), L.stable(item) + '&sourceId=2', L.stable(item) + '&returnTo=https://evil.invalid', L.stable(item).replace('project-documents', 'users'), L.stable(item).replace('file_A.jpg', '..%2Fsecret.txt')]) assert.throws(() => L.target(url, base), Error);
  assert.equal(L.parse('<img src=x onerror=alert(1)>[外站](https://evil.invalid/file-reference.html?x=y)')[0].type, 'text');
  assert.equal(L.normalize('uploads/file_A.jpg'), '/api/uploads/file_A.jpg');
});
test('长文本不截断，长文件名拒绝而非伪造有效链接', () => {
  const text = '中'.repeat(60001); assert.equal(L.serialize(L.parse(text)), text);
  assert.throws(() => L.format(Object.assign({}, item, { name: '['.repeat(501) })), /过长/);
});
test('原生组件初次展示不读剪贴板、文字段与文件节点原位混排', async () => {
  const s = harness('diary-body', '前文' + raw + '后文'); await tick();
  assert.equal(s.clipReads, 0); assert.equal(s.c.collect(), '前文' + raw + '后文');
  assert.deepEqual(s.c.data.nodes.map(n => n.type), ['text', 'file', 'text']);
  assert.equal(s.changes.length, 0);
});
test('原生显式粘贴保留光标前后文字，授权后变为文件名', async () => {
  const s = harness('diary-body', '甲乙'); s.c.edit(event(0)); s.c.cursor({ detail: { cursor: 1 } });
  await s.c.paste(); await tick();
  assert.equal(s.clipReads, 1); assert.equal(s.c.collect(), '甲' + raw + '乙');
  assert.equal(s.c.data.nodes[1].name, item.name);
});
test('原生英文中间普通粘贴只转换新增片段，不吞相邻字母', async () => {
  const s = harness('diary-body', 'AB'); s.c.edit(event(0));
  s.c.input(event(0, 'A' + base + '/' + L.stable(item) + 'B', 1)); await tick();
  assert.equal(s.c.collect(), 'A' + raw + 'B');
});
test('原生普通粘贴触发授权，删除重复链接只移除指定位置并支持撤销', async () => {
  const s = harness('diary-body', raw + raw); await tick();
  s.c.remove(event(1)); assert.equal(s.c.collect(), raw);
  s.c.undo(); assert.equal(s.c.collect(), raw + raw);
  s.c.edit(event(4)); s.c.input(event(4, '之后 ' + base + '/' + L.stable(item), 3)); await tick();
  assert.equal(L.parse(s.c.collect()).filter(n => n.type === 'file').length, 3);
});
test('原生链接授权失败保留完整粘贴输入', async () => {
  const s = harness('diary-body', ''); s.api.referenceAccess = async () => { throw new Error('网络不可用'); };
  const text = '前 ' + base + '/' + L.stable(item) + ' 后';
  s.c.input(event(0, text, text.length)); await tick();
  assert.equal(s.c.collect(), text); assert.match(s.c.data.error, /粘贴文字已保留/);
});
test('原生在途输入版本变化后不替换新文字', async () => {
  const s = harness('diary-body', ''); s.deferAccess();
  const text = base + '/' + L.stable(item); s.c.input(event(0, text, text.length));
  s.c.input(event(0, '用户已更改文字', 3)); s.resolveAccess(); await tick();
  assert.equal(s.c.collect(), '用户已更改文字');
});
test('原生保存、卸载、换账号、换草稿和后台阻止迟到链接回填', async () => {
  for (const invalidate of [s => s.c.collect(), s => s.def.lifetimes.detached.call(s.c), s => s.switchUser(), s => { s.c.properties.context = 'other'; }, s => s.def.pageLifetimes.hide.call(s.c)]) {
    const s = harness('diary-body', ''); s.deferAccess(); const text = base + '/' + L.stable(item);
    s.c.input(event(0, text, text.length)); invalidate(s); s.resolveAccess(); await tick();
    assert.equal(L.serialize(s.c.data.nodes), text);
  }
});
test('原生只读、忙状态不编辑、不读取剪贴板、不删除或撤销', async () => {
  for (const state of ['readonly', 'disabled']) {
    const s = harness('diary-body', raw); s.c.properties[state] = true;
    s.c.edit(event(0)); s.c.input(event(0, '篡改', 2)); s.c.remove(event(1)); await s.c.paste(); s.c.undo();
    assert.equal(s.c.collect(), raw); assert.equal(s.clipReads, 0); assert.equal(s.changes.length, 0);
  }
});
test('原生失效状态不改正文且仍保留稳定复制入口', async () => {
  const s = harness('diary-body', raw); await tick();
  s.api.referenceAccess = async () => { const e = new Error('已删除'); e.code = 404; throw e; };
  s.c.checkFiles(); await tick(); assert.equal(s.c.data.nodes[1].unavailable, '资料已删除／不可用');
  s.c.copy(event(1)); assert.equal(s.clipboard[0], base + '/' + L.stable(item)); assert.equal(s.c.collect(), raw);
});
test('原生资源五组默认同日独立只读查询', async () => {
  const s = harness('diary-resources'); await tick();
  assert.equal(s.calls.length, 5); assert.deepEqual(s.calls.map(c => c[1].sourceType), L.sources.map(x => x[0]));
  s.calls.forEach(c => { assert.equal(c[0], '/field/diary-resources'); assert.equal(c[1].pageSize, 20); assert.equal(c[1].dateFrom, '2026-10-30'); });
  assert.equal(s.clipReads, 0); assert.equal(s.changes.length, 0);
});
test('资源组失败不冒充空结果、可重试且附件筛选不覆盖错误', async () => {
  const s = harness('diary-resources'); await tick();
  s.api.request = async () => { throw new Error('离线'); }; await s.c.load(0);
  assert.match(s.c.data.groups[0].error, /读取失败/); assert.equal(s.c.data.groups[1].error, '');
  s.c.filter({ currentTarget: { dataset: { group: 0, field: 'fileName' } }, detail: { value: '中文' } });
  assert.match(s.c.data.groups[0].error, /读取失败/);
  s.api.request = async () => ({ list: [], total: 0 }); await s.c.load(0); assert.equal(s.c.data.groups[0].error, '');
});
test('资源组分页、历史日期和附件名称筛选都保留独立状态', async () => {
  const s = harness('diary-resources'); await tick();
  s.api.request = async (url, method, params) => { s.calls.push([url, params]); return { total: 23, list: [{ sourceId: 12, files: [item] }, { sourceId: 13, files: [] }] }; };
  await s.c.load(4); s.c.page({ currentTarget: { dataset: { group: 4, delta: 1 } } }); await tick();
  assert.equal(s.calls.at(-1)[1].pageNum, 2); assert.equal(s.c.data.groups[0].page, 1);
  s.c.filter({ currentTarget: { dataset: { group: 4, field: 'fileName' } }, detail: { value: '不存在' } });
  assert.equal(s.c.data.groups[4].visibleRecords[0].visibleFiles.length, 0); assert.equal(s.c.data.groups[4].visibleRecords[1].files.length, 0);
});
test('资源迟到响应不能覆盖新筛选，其他组查询不会因此取消', async () => {
  const s = harness('diary-resources'); await tick(); const pending = [];
  s.api.request = () => new Promise(resolve => pending.push(resolve));
  const a = s.c.load(0), b = s.c.load(1);
  s.c.filter({ currentTarget: { dataset: { group: 0, field: 'keyword' } }, detail: { value: '新关键词' } });
  pending[0]({ list: [], total: 20 }); pending[1]({ list: [], total: 3 }); await Promise.all([a, b]);
  assert.match(s.c.data.groups[0].error, /筛选条件已改变/); assert.equal(s.c.data.groups[1].total, 3);
});
test('PC 安全渲染对历史 HTML 转义，导出只含稳定地址', () => {
  const window = {}, App = { escape: v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) };
  window.DiaryLinks = L;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../assets/diary-links.js'), 'utf8'), { window, App });
  const html = window.DiaryLinkView.html('<script>bad()</script>' + raw);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /class="fd-file-link"/); assert.doesNotMatch(html, /<script>|ticket=|token=|signature=/);
  assert.match(L.readable(raw), /file-reference\.html/); assert.match(L.readable(raw), /中文/);
});
function documentsPage() {
  let p, uid = '1'; const calls = [], navigation = [];
  const api = { userId: () => uid, allProjects: async () => [{ id: 7, name: '甲工程' }, { id: 8, name: '乙工程' }],
    request: async (url, method, params) => {
      calls.push([url, params]);
      if (url.includes('/tree')) return [{ id: 71, name: '主目录', children: [{ id: 72, name: '子目录' }] }];
      if (url.includes('/diary-references')) return { list: [{ id: 91, status: 'draft' }], total: 12 };
      return { list: [{ id: 12, filePath: item.file, diaryReferenceCount: 12 }], total: 23 };
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/project-documents/index.js'), 'utf8'), {
    Page: value => { p = value; }, require: name => name.endsWith('/api') ? api : require('../utils/schema'),
    wx: { navigateTo: options => navigation.push(options.url), stopPullDownRefresh() {} }
  });
  p.data = copy(p.data); p.setData = patch => setData(p.data, patch);
  return { p, api, calls, navigation, switchUser() { uid = '2'; } };
}
test('原生工程资料目录、真实分页与反查只读跳转', async () => {
  const s = documentsPage(); await s.p.onLoad({ projectId: 8 });
  assert.equal(s.p.project().id, 8); assert.equal(s.p.data.folders[2].name, '主目录 / 子目录');
  s.p.selectFolder({ detail: { value: 2 } }); await tick();
  assert.equal(s.calls.at(-1)[1].subItemId, 72);
  s.p.page({ currentTarget: { dataset: { delta: 1 } } }); await tick();
  assert.equal(s.calls.at(-1)[1].pageNum, 2); assert.equal(s.calls.at(-1)[1].pageSize, 20);
  await s.p.showReferences({ currentTarget: { dataset: { id: 12, page: 2 } } });
  assert.equal(s.calls.at(-1)[1].pageSize, 10); assert.equal(s.p.data.refTotal, 12);
  s.p.diary({ currentTarget: { dataset: { id: 91 } } }); assert.match(s.navigation[0], /id=91&readonly=true$/);
});
test('原生工程资料返回保留目录与页码、离线清除旧计数', async () => {
  const s = documentsPage(); await s.p.onLoad({ projectId: 7 }); s.p.setData({ folderIndex: 2, page: 2 });
  await s.p.refresh(); assert.equal(s.p.data.folderIndex, 2); assert.equal(s.p.data.page, 2);
  s.api.request = async () => { throw new Error('离线'); }; await s.p.refresh();
  assert.equal(s.p.data.total, null); assert.equal(s.p.data.documents.length, 0); assert.match(s.p.data.treeError, /读取失败/);
});
test('原生工程资料项目切换和刷新不会被旧资料或引用请求覆盖', async () => {
  const s = documentsPage(); await s.p.onLoad({ projectId: 7 }); const pending = [];
  s.api.request = () => new Promise(resolve => pending.push(resolve));
  const old = s.p.showReferences({ currentTarget: { dataset: { id: 12 } } });
  const load = s.p.load(); s.p.selectProject({ detail: { value: 1 } });
  pending[0]({ list: [{ id: 999 }], total: 100 }); pending[1]({ list: [{ id: 999 }], total: 100 }); await Promise.all([old, load]);
  assert.equal(s.p.data.refTotal, null); assert.equal(s.p.data.documents.length, 0); assert.equal(s.p.project().id, 8);
  pending[2]([]); await tick(); pending[3]({ list: [], total: 0 }); await tick(); assert.equal(s.p.data.total, 0);
});
test('原生工程资料换账号或卸载后忽略迟到数据', async () => {
  for (const invalidate of [s => s.switchUser(), s => s.p.onUnload(), s => s.p.onHide()]) {
    const s = documentsPage(); await s.p.onLoad({}); let resolve;
    s.api.request = () => new Promise(r => { resolve = r; }); const work = s.p.load(); invalidate(s);
    resolve({ list: [{ id: 999 }], total: 999 }); await work; assert.equal(s.p.data.total, null); assert.equal(s.p.data.documents.length, 0);
  }
});
test('登录返回严格白名单，不接受开放重定向或凭证参数', () => {
  const store = { getItem() { return null; }, removeItem() {} }, window = { addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../assets/app.js'), 'utf8'), { window, location: { pathname: '/login.html', search: '' }, document: { readyState: 'loading', addEventListener() {} }, localStorage: store, sessionStorage: store, URLSearchParams, setTimeout });
  const valid = window.App.safeReturnTarget;
  assert.equal(valid(L.stable(item)), L.stable(item)); assert.equal(valid('supervision-diary.html?id=12&readonly=true'), 'supervision-diary.html?id=12&readonly=true');
  for (const url of [base + '/' + L.stable(item), '//evil.invalid', 'javascript:alert(1)', 'index.html', 'supervision-diary.html?id=1&readonly=false', L.stable(item) + '&token=secret', L.stable(item) + '&sourceId=1']) assert.equal(valid(url), '');
});
