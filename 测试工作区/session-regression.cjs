'use strict';
// 执行真实前端基座，用独立标签页存储与可控网络验证会话竞态；不依赖第三方包。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..', '补后端');
const source = fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8');
let count = 0;
function check(name, fn) { fn(); count++; console.log('[PASS] ' + name); }
function storage(initial = {}, notify = () => {}) {
  const values = { ...initial };
  return new Proxy(values, {
    get(target, key) {
      if (key === 'getItem') return k => target[k] ?? null;
      if (key === 'setItem') return (k, v) => { target[k] = String(v); notify(k, String(v)); };
      if (key === 'removeItem') return k => { delete target[k]; notify(k, null); };
      if (key === 'key') return i => Object.keys(target)[i] ?? null;
      if (key === 'length') return Object.keys(target).length;
      return target[key];
    }
  });
}
const sharedValues = {};
const tabs = [];
function tab(session, pathname = '/login.html') {
  const listeners = {}, nodes = {};
  const element = () => ({ style: {}, textContent: '', innerHTML: '', dataset: {}, addEventListener() {},
    appendChild(el) { if (el.id) nodes[el.id] = el; }, replaceChildren() { this.cleared = true; } });
  const name = element(), role = element(), right = element(), avatar = element();
  const document = { readyState: 'loading', documentElement: element(), body: element(),
    addEventListener() {}, createElement: element,
    querySelector: s => s === '.header-right' ? right : null,
    querySelectorAll: s => s === '.user-name, .up-name' ? [name] : s === '.up-role' ? [role] : s.includes('.user-avatar') ? [avatar] : [],
    getElementById: id => nodes[id] || null };
  const localStorage = new Proxy(sharedValues, { get(target, key) {
    if (key === 'getItem') return k => target[k] ?? null;
    if (key === 'setItem') return (k, v) => { target[k] = String(v); tabs.filter(t => t !== context).forEach(t => t.emit('storage', { key: k, newValue: String(v) })); };
    if (key === 'removeItem') return k => { delete target[k]; };
    return target[key];
  } });
  const context = { document, localStorage, sessionStorage: session || storage(), console, Promise, FormData,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    location: { pathname, replace(url) { this.redirect = url; } },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    emit(type, event) { (listeners[type] || []).forEach(fn => fn(event)); },
    fetch: async () => ({ status: 200, json: async () => ({ code: 200, data: {} }) }),
    setTimeout, clearTimeout, nameNode: name, roleNode: role, nodes };
  context.window = context;
  tabs.push(context);
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}
function login(userId, userName, roles = []) {
  const payload = Buffer.from(JSON.stringify({ jti: 'test-' + userId + '-' + Math.random(), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return { token: 'test.' + payload + '.signature', userId, userName, roles };
}
async function main() {
  sharedValues.token = 'legacy-token'; sharedValues.userName = '旧管理员'; sharedValues.roles = '["admin"]';
  const a = tab(), b = tab();
  check('不接受旧版共享登录缓存', () => { assert.equal(a.App.getToken(), ''); assert.equal(sharedValues.token, undefined); });
  const admin = login(1, 'admin', ['admin']), worker = login(2, '普通监理');
  a.App.saveSession(admin); b.App.saveSession(worker);
  check('两标签页账号及权限独立', () => { assert.equal(a.App.getUser().userName, 'admin'); assert.equal(b.App.getUser().userName, '普通监理'); assert.equal(b.App.getUser().roles.length, 0); });
  check('凭证从不写入共享存储', () => { assert.equal(Object.values(sharedValues).includes(admin.token), false); assert.equal(Object.values(sharedValues).includes(worker.token), false); });
  const refreshed = tab(a.sessionStorage);
  check('同标签页导航和刷新保留完整会话', () => assert.equal(refreshed.App.getToken(), admin.token));
  const copied = tab(storage({ 'supervision.session.v2': JSON.stringify(admin) }));
  copied.location.pathname = '/project-ledger.html';
  a.sessionStorage.setItem('userSettings', '{}'); a.sessionStorage.setItem('field-pc:test', '{"draft":true}');
  a.location.pathname = '/index.html';
  a.fetch = () => new Promise(() => {});
  a.App.logout();
  check('退出接口挂起也立即退出并清空个人缓存', () => { assert.equal(a.App.getToken(), ''); assert.equal(a.location.redirect, 'login.html'); assert.equal(a.document.body.cleared, true); assert.equal(a.sessionStorage.getItem('userSettings'), null); assert.equal(a.sessionStorage.getItem('field-pc:test'), null); });
  check('复制同一登录的页面收到失效通知', () => { assert.equal(copied.App.getToken(), ''); assert.equal(copied.location.redirect, 'login.html'); });
  check('其他独立账号不会被串改或退出', () => { assert.equal(b.App.getToken(), worker.token); assert.equal(b.App.getUser().roles.length, 0); });
  const c = tab(); c.App.saveSession(login(3, '旧用户'));
  let resolveJson;
  c.fetch = async () => ({ status: 200, json: () => new Promise(resolve => { resolveJson = resolve; }) });
  const pending = c.App.apiFetch('/auth/info').then(() => false, () => true);
  await Promise.resolve(); await Promise.resolve();
  c.App.saveSession(login(4, '新用户'));
  resolveJson({ code: 200, data: { userName: '旧用户', roles: ['admin'] } });
  const discarded = await pending;
  check('JSON解析期间切换账号，旧响应不可回写', () => { assert.equal(discarded, true); assert.equal(c.App.getUser().userName, '新用户'); });
  let resolve401;
  c.fetch = () => new Promise(resolve => { resolve401 = resolve; });
  const stale = c.App.apiFetch('/auth/info').catch(() => {});
  c.App.saveSession(login(5, '再次登录'));
  resolve401({ status: 401 }); await stale;
  check('旧请求的401不能踢掉新会话', () => assert.equal(c.App.getUser().userName, '再次登录'));
  const guard = tab(undefined, '/permission-settings.html');
  check('直接打开业务页无登录则隐藏并跳转', () => { assert.equal(guard.location.redirect, 'login.html'); assert.equal(guard.document.documentElement.style.visibility, 'hidden'); });
  const d = tab(); d.App.saveSession(login(6, '缓存旧名', ['admin']));
  d.fetch = async url => ({ status: 200, json: async () => ({ code: 200, data: url.endsWith('/auth/info') ? { userId: 6, userName: '权威姓名', roles: [] } : 0 }) });
  await d.App.initTopbar();
  check('顶部姓名和角色以当前后端身份为准', () => { assert.equal(d.nameNode.textContent, '权威姓名'); assert.equal(d.App.getUser().roles.length, 0); assert.equal(d.roleNode.textContent, '当前登录用户'); assert.ok(d.nodes.appLogout); });
  check('统一用户菜单包含资料/改密/日志/退出且默认收起', () => { assert.ok(d.nodes.appMenuProfile); assert.ok(d.nodes.appMenuPwd); assert.ok(d.nodes.appMenuLog); assert.equal(d.nodes.appUserMenu.style.display, 'none'); assert.ok(d.nodes.appChromeStyle); });
  d.location.pathname = '/index.html'; d.App.clearSession(); d.emit('pageshow', { persisted: true });
  check('浏览器后退恢复页面时重新执行守卫', () => assert.equal(d.location.redirect, 'login.html'));
  const e = tab(); e.App.saveSession(login(7, '离线用户')); e.location.pathname = '/index.html'; e.fetch = () => { throw new Error('网络已断开'); }; e.App.logout();
  check('同步网络异常不会阻止退出', () => assert.equal(e.location.redirect, 'login.html'));
  const pages = fs.readdirSync(root).filter(f => f.endsWith('.html') && !['login.html', 'welcome.html'].includes(f));
  check('24个业务页统一接入会话基座且脚本语法有效', () => {
    assert.equal(pages.length, 24);
    for (const page of pages) {
      const html = fs.readFileSync(path.join(root, page), 'utf8');
      assert.ok(html.includes('assets/app.js'), page);
      for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!script[1].includes('src=')) new vm.Script(script[2]);
    }
  });
  await safetyFormChecks();
  console.log('SESSION TOTAL: ' + count + ' PASS: ' + count + ' FAIL: 0');
}
// 安全日志执行真实内联脚本；隔离 DOM/网络，不访问运行服务或真实数据。
function safetyHarness() {
  const html = fs.readFileSync(path.join(root, 'safety-log.html'), 'utf8');
  const decode = s => String(s).replace(/&#10;/g, '\n').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  class Node {
    constructor(tag = 'div') { this.tag = tag; this.attrs = {}; this.children = []; this.style = {}; this.value = ''; this.disabled = false; this.scrollTop = 0; this.text = ''; }
    get id() { return this.attrs.id; } set id(v) { this.attrs.id = v; }
    get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
    get classList() { const n = this; return { contains: c => n.className.split(' ').includes(c),
      add: c => { if (!n.className.split(' ').includes(c)) n.className += ' ' + c; },
      remove: c => { n.className = n.className.split(' ').filter(x => x !== c).join(' '); } }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    get firstChild() { return this.children[0]; }
    get parentElement() { return this.parentNode; }
    appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
    insertBefore(n, ref) { n.parentNode = this; const at = this.children.indexOf(ref); this.children.splice(at < 0 ? this.children.length : at, 0, n); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; }
    addEventListener() {}
    focus() { this.focused = true; }
    get textContent() { return this.text + this.children.map(n => n.textContent).join(''); }
    set textContent(v) { this.text = String(v); this.children = []; }
    set innerHTML(v) { this.text = ''; this.children.forEach(n => { n.parentNode = null; }); this.children = []; parse(v, this); }
    get innerHTML() { return this.textContent; }
    insertAdjacentHTML(_, v) { parse(v, this); }
    querySelectorAll(selector) {
      const all = []; const walk = n => n.children.forEach(c => { all.push(c); walk(c); }); walk(this);
      return all.filter(n => selector.split(',').some(s => matches(n, s.trim().split(/\s+/))));
    }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  }
  function simple(n, s) {
    let excluded; s = s.replace(/:not\(([^)]+)\)/g, (_, v) => { excluded = v; return ''; });
    if (excluded && simple(n, excluded)) return false;
    const tag = s.match(/^[a-z][\w-]*/i); if (tag && n.tag !== tag[0].toLowerCase()) return false;
    for (const m of s.matchAll(/#([\w-]+)/g)) if (n.id !== m[1]) return false;
    for (const m of s.matchAll(/\.([\w-]+)/g)) if (!n.classList.contains(m[1])) return false;
    for (const m of s.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
      if (n.getAttribute(m[1]) == null || (m[2] !== undefined && n.getAttribute(m[1]) !== m[2])) return false;
    }
    return true;
  }
  function matches(n, parts) {
    if (!simple(n, parts[parts.length - 1])) return false;
    let p = n.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) { while (p && !simple(p, parts[i])) p = p.parentNode; if (!p) return false; p = p.parentNode; }
    return true;
  }
  function parse(markup, parent) {
    const stack = [parent];
    for (const token of String(markup).match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('<!--') || token.startsWith('<!')) continue;
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (!token.startsWith('<')) { stack.at(-1).text += decode(token); continue; }
      const tag = token.match(/^<([\w-]+)/); if (!tag) continue;
      const n = new Node(tag[1].toLowerCase());
      for (const a of token.slice(tag[0].length).matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) n.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
      n.value = n.getAttribute('value') || ''; stack.at(-1).appendChild(n);
      if (!['input', 'img', 'br', 'hr', 'meta', 'link', 'path'].includes(n.tag) && !token.endsWith('/>')) stack.push(n);
    }
  }
  const document = new Node('document'); document.body = document.appendChild(new Node('body'));
  document.createElement = tag => new Node(tag);
  document.getElementById = id => document.querySelector('#' + id);
  parse(html.slice(html.indexOf('<body>') + 6, html.indexOf('    <script>', html.indexOf('<body>'))), document.body);
  const state = { writes: [], reads: [], downloads: [], toasts: [], projects: [{ id: 1, name: '测试工程一' }], records: [], user: { userId: 7, userName: '安全监理员' } };
  const context = { document, console, Promise, URLSearchParams, Date, setTimeout: () => {}, location: { search: '' }, alert: message => { state.alert = message; } };
  context.window = context;
  context.App = {
    getUser: () => state.user, requireAuth() {}, initTopbar() {}, tableLoading() {},
    escape: v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    toast: (message, type) => state.toasts.push({ message, type }),
    confirm: async () => true, prompt: async () => '复查未通过',
    buildQuery: params => new URLSearchParams(params).toString(),
    downloadFile: async (url, name) => { state.downloads.push(url); return name; },
    apiGetPage: async (url, params) => {
      state.reads.push({ url, params });
      if (url === '/projects') {
        if (state.projectError) throw new Error('项目断网');
        if (state.projectPage) return state.projectPage(params.pageNum);
        return { list: state.projects, total: state.projects.length };
      }
      return { list: state.records, total: state.records.length };
    },
    apiFetch: async (url, options) => {
      state.writes.push({ url, options: structuredClone(options) });
      if (state.write) return state.write(url, options);
      return { ...options.body, id: 51, authorId: 7, version: 1 };
    }
  };
  vm.createContext(context);
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!script[1].includes('src=')) vm.runInContext(script[2], context);
  state.context = context; state.html = html; state.$ = id => document.getElementById(id);
  state.ready = async () => { await new Promise(resolve => setImmediate(resolve)); state.writes = []; state.reads = []; };
  state.openRecord = record => { context.tableData = [context.mapLog(record)]; context.filteredData = context.tableData.slice(); context.openEditModal(1); };
  return state;
}
async function safetyFormChecks() {
  const run = async (name, fn) => { await fn(); count++; console.log('[PASS] 安全日志：' + name); };
  await run('九项规范在框内呈现且自动项只读', async () => {
    const s = safetyHarness(); await s.ready(); s.context.openCreateModal();
    assert.equal(s.$('projectSelect').getAttribute('type'), 'hidden'); assert.equal(s.$('safetyLogDate').getAttribute('readonly'), '');
    for (const id of ['safetyWeather', 'safetyWind', 'safetyTemp', 'safetyContent', 'safetyInspection', 'safetySafety', 'safetyMajorIssue']) {
      const n = s.$(id); assert.ok(n.getAttribute('placeholder')); assert.equal(n.getAttribute('title'), n.getAttribute('placeholder'));
      assert.equal(n.getAttribute('aria-description'), n.getAttribute('placeholder')); assert.equal(n.value, '');
    }
    for (const text of ['①专职安全员', '②特种作业人员', '③施工机械', '④临时用电', '⑤脚手架']) assert.ok(s.$('safetyInspection').getAttribute('placeholder').includes(text));
    assert.match(s.$('safetySafety').getAttribute('placeholder'), /重大危险源.*处理结果/);
    assert.match(s.$('safetyAuthorHint').textContent, /项目安全监理工程师/);
    for (const text of ['监理工程师通知单', '专题会议纪要', '工程暂停令', '第三方验收单']) assert.ok(s.$('safetyAttachmentHint').textContent.includes(text));
    assert.doesNotMatch(s.html.slice(s.html.indexOf('id="createModal"'), s.html.indexOf('id="deleteModal"')), /placeholder="如：/);
  });
  await run('单项目自动带入本地当天，不把提示写入草稿', async () => {
    const s = safetyHarness(); await s.ready(); s.context.openCreateModal();
    assert.equal(s.$('safetyProjectName').textContent, '测试工程一'); assert.equal(s.$('safetyLogDate').value, s.context.safetyToday());
    assert.equal(s.$('safetyAuthor').textContent, '安全监理员'); await s.context.saveDraft();
    assert.equal(s.writes.length, 1); assert.equal(s.writes[0].options.body.projectId, 1);
    for (const k of ['content', 'inspection', 'safety', 'majorIssue', 'weather', 'wind', 'temperature']) assert.equal(s.writes[0].options.body[k], '');
    assert.equal(s.writes[0].options.body.status, 'draft'); assert.equal(s.writes[0].options.body.authorId, undefined);
  });
  await run('多项目未选拦截，选中后清理对应提示但保留其他错误', async () => {
    const s = safetyHarness(); await s.ready(); s.projects.push({ id: 2, name: '测试工程二' }); await s.context.loadProjects();
    s.context.openCreateModal(); assert.equal(s.$('createModal').classList.contains('show'), false); assert.match(s.$('safetyPageHint').textContent, /请先/);
    s.$('projectFilter').value = '2'; s.context.clearSafetyProjectHint(); assert.equal(s.$('safetyPageHint').textContent, '');
    s.$('safetyPageHint').textContent = '其他错误'; s.context.clearSafetyProjectHint(); assert.equal(s.$('safetyPageHint').textContent, '其他错误');
    s.context.openCreateModal(); assert.equal(s.$('safetyProjectName').textContent, '测试工程二'); assert.equal(s.$('safetyPageHint').textContent, '');
  });
  await run('项目分页完整加载，空项目和加载失败不猜测工程', async () => {
    const s = safetyHarness(); await s.ready();
    s.projectPage = n => ({ list: [{ id: n, name: '工程' + n }], total: 2 }); await s.context.loadProjects();
    assert.equal(Object.keys(s.context.projectsMap).length, 2); s.context.openCreateModal(); assert.equal(s.$('createModal').classList.contains('show'), false);
    s.projectPage = null; s.projects = []; await s.context.loadProjects(); s.context.openCreateModal(); assert.match(s.$('safetyPageHint').textContent, /暂无可填报项目/);
    s.projectError = true; await s.context.loadProjects(); assert.equal(s.context.safetyProjectsReady, false); s.context.openCreateModal(); assert.equal(s.$('createModal').classList.contains('show'), false);
  });
  await run('草稿回显全部原字段、原人员和附件，不随筛选或列表漂移', async () => {
    const s = safetyHarness(); await s.ready();
    const record = { id: 12, code: 'AQ-old', projectId: 8, logDate: '2020-01-02', authorId: 20, authorName: '原填写人', reviewerId: 21,
      status: 'draft', weather: '阴', wind: '三级', temperature: '12℃', content: '原施工\n部位', inspection: '资料原文', safety: '复查中', majorIssue: '主管检查',
      photos: JSON.stringify([{ url: '/uploads/photo.png', name: '现场', remark: '照片说明' }]),
      attachments: JSON.stringify([{ url: '/uploads/a.pdf', name: '验收单.pdf', size: '10', dirs: ['旧目录'], time: '历史时间' }]) };
    s.openRecord(record); assert.equal(s.$('safetyAuthor').textContent, '原填写人'); assert.equal(s.$('safetyReviewer').textContent, '用户#21');
    assert.equal(s.$('safetyLogDate').value, record.logDate); assert.equal(s.$('safetyContent').value, record.content);
    s.$('projectFilter').value = '1'; s.context.tableData = []; s.context.filteredData = [];
    s.$('safetyLogDate').value = '2026-10-28'; s.$('projectSelect').value = '1'; await s.context.saveDraft();
    const body = s.writes[0].options.body; assert.equal(s.writes[0].url, '/safety-logs/12'); assert.equal(body.projectId, 8); assert.equal(body.logDate, record.logDate);
    for (const k of ['weather', 'wind', 'temperature', 'content', 'inspection', 'safety', 'majorIssue']) assert.equal(body[k], record[k]);
    assert.deepEqual(JSON.parse(body.photos), JSON.parse(record.photos)); assert.deepEqual(JSON.parse(body.attachments), JSON.parse(record.attachments));
  });
  await run('从编辑转新建清空正文天气人员附件及历史页签', async () => {
    const s = safetyHarness(); await s.ready();
    s.openRecord({ id: 2, code: 'AQ-2', projectId: 1, logDate: '2020-01-01', authorName: '旧人', reviewerName: '旧审核人', status: 'rejected', version: 2, content: '旧正文', weather: '旧天气', photos: '[{"url":"/uploads/old.png"}]' });
    assert.ok(s.context.document.querySelector('#createModal .version-tabs'));
    s.context.openCreateModal();
    assert.equal(s.$('safetyContent').value, ''); assert.equal(s.$('safetyWeather').value, ''); assert.equal(s.$('safetyReviewer').textContent, '—');
    assert.equal(s.$('safetyAuthor').textContent, '安全监理员'); assert.equal(s.$('safetyLogDate').value, s.context.safetyToday());
    assert.equal(s.context.document.querySelector('#createModal .version-tabs'), null); assert.equal(s.$('createPhotoGrid').children.length, 0);
    assert.equal(s.context.document.body.classList.contains('fw-modal-open'), true); s.context.closeModal('createModal'); assert.equal(s.context.document.body.classList.contains('fw-modal-open'), false);
  });
  await run('新建提交先保存草稿再按真实ID提交，编辑提交只发一次PUT', async () => {
    const s = safetyHarness(); await s.ready(); s.context.openCreateModal(); s.$('safetyContent').value = '手写施工进度'; await s.context.submitLog();
    assert.equal(s.writes.length, 2); assert.equal(s.writes[0].options.method, 'POST'); assert.equal(s.writes[0].options.body.status, 'draft');
    assert.equal(s.writes[1].url, '/safety-logs/51'); assert.equal(s.writes[1].options.body.status, 'submitted'); assert.equal(s.writes[1].options.body.content, '手写施工进度');
    s.writes = []; s.openRecord({ id: 18, code: 'AQ-18', projectId: 1, logDate: '2020-01-01', status: 'draft' }); await s.context.submitLog();
    assert.equal(s.writes.length, 1); assert.equal(s.writes[0].url, '/safety-logs/18'); assert.equal(s.writes[0].options.body.status, 'submitted');
  });
  await run('提交失败保留正文与已创建ID，重试不重复新建', async () => {
    const s = safetyHarness(); await s.ready(); s.context.openCreateModal(); s.$('safetySafety').value = '待复查原文';
    s.write = async (url, opts) => { if (opts.method === 'PUT') throw new Error('断网'); return { ...opts.body, id: 66 }; };
    await s.context.submitLog(); assert.equal(s.$('safetySafety').value, '待复查原文'); assert.equal(s.$('createModal').classList.contains('show'), true);
    assert.match(s.$('safetyFormError').textContent, /断网/); assert.equal(s.context.editingRecord.id, 66); assert.equal(s.toasts.some(t => t.type === 'success'), false);
    s.write = null; s.writes = []; await s.context.submitLog(); assert.equal(s.writes.length, 1); assert.equal(s.writes[0].url, '/safety-logs/66');
  });
  await run('保存期间防重复点击、关闭和切记录', async () => {
    const s = safetyHarness(); await s.ready(); s.context.openCreateModal(); let finish;
    s.write = (_, opts) => new Promise(resolve => { finish = () => resolve({ ...opts.body, id: 90 }); });
    const save = s.context.saveDraft(); await s.context.saveDraft(); s.context.closeModal('createModal'); s.context.openCreateModal();
    assert.equal(s.writes.length, 1); assert.equal(s.$('createModal').classList.contains('show'), true); assert.equal(s.$('safetyContent').disabled, true);
    finish(); await save; assert.equal(s.$('safetyContent').disabled, false);
  });
  await run('待审核、已批准记录不进入编辑，待审核筛选与导出契约一致', async () => {
    const s = safetyHarness(); await s.ready();
    for (const status of ['submitted', 'approved']) { s.openRecord({ id: 8, projectId: 1, logDate: '2020-01-01', status }); assert.equal(s.$('createModal').classList.contains('show'), false); }
    s.records = [{ id: 8, projectId: 1, status: 'submitted' }]; s.$('statusFilter').value = 'pending'; await s.context.loadData();
    assert.equal(s.reads.at(-1).params.status, 'submitted'); assert.equal(s.context.filteredData[0].status, 'pending');
    s.context.exportWordBatch(); await Promise.resolve(); assert.match(s.downloads[0], /status=submitted/);
    s.context.exportWordById(8, 'AQ-8'); await Promise.resolve(); assert.equal(s.downloads[1], '/safety-logs/8/export');
  });
  await run('缺少姓名不冒用查看者，详情不把施工内容混入巡视栏', async () => {
    const s = safetyHarness(); await s.ready();
    const d = s.context.mapLog({ id: 1, projectId: 1, status: 'draft', authorId: 99, submittedBy: '代提交人', content: '施工唯一原文' });
    assert.equal(d.author, '用户#99'); const panel = s.context.buildViewVersionPanel(d, d.versions[0]);
    assert.equal((panel.match(/施工唯一原文/g) || []).length, 1); assert.match(panel, />草稿</);
  });
  await run('未上传成功的附件不被静默忽略保存', async () => {
    const s = safetyHarness(); await s.ready(); s.context.openCreateModal();
    const item = s.context.document.createElement('div'); item.className = 'attachment-item'; s.$('createAttachmentList').appendChild(item);
    await s.context.saveDraft(); assert.equal(s.writes.length, 0); assert.match(s.$('safetyFormError').textContent, /未上传成功/);
    item.setAttribute('data-url', ''); await s.context.saveDraft(); assert.equal(s.writes.length, 0);
  });
  await run('照片读取期间拦截保存，切换新建或移除后迟到回调不串入', async () => {
    const s = safetyHarness(); await s.ready(); const readers = []; let uploads = 0;
    s.context.FileReader = class { constructor() { readers.push(this); } readAsDataURL() {} };
    s.context.App.uploadFile = async () => { uploads++; return { url: '/uploads/photo.png' }; };
    s.context.openCreateModal(); s.context.uploadPhotoFiles([{ name: '旧照片.png' }]);
    await s.context.saveDraft(); assert.equal(s.writes.length, 0);
    s.context.openCreateModal(); readers[0].onload({ target: { result: 'data:image/png;base64,old' } });
    assert.equal(s.$('createPhotoGrid').children.length, 0); assert.equal(uploads, 0);
    s.context.uploadPhotoFiles([{ name: '移除的照片.png' }]); s.$('createPhotoGrid').children[0].remove();
    readers[1].onload({ target: { result: 'data:image/png;base64,removed' } }); assert.equal(uploads, 0);
    s.context.uploadPhotoFiles([{ name: '有效照片.png' }]); readers[2].onload({ target: { result: 'data:image/png;base64,current' } });
    await Promise.resolve(); await s.context.saveDraft(); assert.equal(JSON.parse(s.writes[0].options.body.photos)[0].url, '/uploads/photo.png');
  });
  await run('审批入口继续走原专用接口，版本切换使用正在编辑的记录', async () => {
    const s = safetyHarness(); await s.ready();
    const first = s.context.mapLog({ id: 1, projectId: 1, logDate: '2020-01-01', status: 'rejected', version: 1 });
    const second = s.context.mapLog({ id: 2, projectId: 1, logDate: '2020-01-02', status: 'rejected', version: 4, content: '第二份原文' });
    s.context.tableData = [first, second]; s.context.filteredData = [first, second]; s.context.openEditModal(2);
    const tabs = s.context.document.querySelectorAll('#createModal .version-tab');
    s.context.switchVersionTab(tabs[0], 4); assert.equal(s.$('safetyContent').value, '第二份原文');
    s.context.switchVersionTab(tabs[1], 5); assert.equal(s.$('safetyContent').parentNode.parentNode.style.display, '');
    s.context.closeModal('createModal'); s.context.approveLog(2); await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.writes[0].url, '/safety-logs/2/approve'); assert.equal(s.writes[0].options.body.status, 'approved');
  });
  await run('共享CSS包含两列、窄屏单列、长提示及独立滚动规则', async () => {
    const css = fs.readFileSync(path.join(root, 'assets/field-records.css'), 'utf8');
    assert.match(css, /\[data-kind="safety-logs"\] \.fd-grid \{ grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
    assert.match(css, /\[data-kind="safety-logs"\] \.fd-grid \{ grid-template-columns:minmax\(0,1fr\);/);
    assert.match(css, /#safetyInspection \{ min-height:460px/); assert.match(css, /\[data-kind="safety-logs"\] \.fd-footer \{ position:static/);
    assert.match(css, /\[data-kind="safety-logs"\] \.modal-body \{ max-height:none; overscroll-behavior:contain/);
  });
}
main().catch(error => { console.error('[FAIL]', error); process.exitCode = 1; });
