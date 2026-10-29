// 运行：node --test 补后端/miniprogram/tests/drafts.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const schema = require('../utils/schema');
const source = fs.readFileSync(path.join(__dirname, '../utils/drafts.js'), 'utf8');
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const error = (code, message = '请求失败') => Object.assign(new Error(message), { code });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function setup() {
  const state = { uid: '1', store: new Map(), calls: [], uploads: [], removed: [], foreground: true, quota: false, server: null };
  const wx = {
    env: { USER_DATA_PATH: '/persistent' },
    getStorageSync: key => copy(state.store.get(key)),
    setStorageSync(key, value) { if (state.quota) throw new Error('quota'); state.store.set(key, copy(value)); },
    getFileSystemManager: () => ({ copyFile: options => options.success(), unlink: options => state.removed.push(options.filePath) })
  };
  const api = {
    namespace: () => 'test-domain', userId: () => state.uid, session: () => ({ userId: state.uid, userName: '当前记录人' }),
    assertUser(uid) { if (!uid || state.uid !== String(uid)) throw new Error('账号已变化'); },
    async upload(file) { state.uploads.push(file); return { url: '/api/uploads/a.jpg', name: 'a.jpg', size: 1 }; },
    async request(url, method = 'GET', body, headers) {
      state.calls.push(copy({ url, method, body, headers }));
      if (url === '/field/diary-prefill') return state.prefill ? state.prefill() : copy(state.prefillSource || {});
      if (url.startsWith('/projects/')) return { id: 2, name: '测试工程' };
      if (url === '/field/summary') return { canReview: true };
      if (method === 'GET') return copy(state.server);
      state.server = Object.assign({}, body, { id: 10, lockVersion: state.server ? state.server.lockVersion + 1 : 0, status: url.endsWith('/submit') ? 'submitted' : 'draft' });
      return copy(state.server);
    }
  };
  function load() {
    const context = { module: { exports: {} }, require: name => name === './api' ? api : schema, wx, getApp: () => ({ globalData: { foreground: state.foreground } }), console };
    vm.runInNewContext(source, context, { filename: 'drafts.js' });
    return context.module.exports;
  }
  state.drafts = load(); state.api = api; state.wx = wx; state.reload = () => { state.drafts = load(); }; return state;
}
const body = () => ({ projectId: 2, diaryDate: '2026-09-23', construction: '现场原文', photos: '[]', attachments: '[]' });
const create = state => state.drafts.create('supervision-diaries', body());

test('日记规范栏目和提示完整，旧正文不拆分、示例不入库', () => {
  const diary = schema.schemas['supervision-diaries'];
  assert.deepEqual(diary.fields.map(f => f[0]), ['weather', 'wind', 'temperature', 'construction', 'management', 'inspection', 'otherWork', 'otherMatters', 'morningMeeting', 'newIssues', 'materialInspection', 'drawingReview']);
  diary.fields.forEach(([key]) => { assert.ok(diary.hints[key]); assert.ok(diary.placeholders[key]); });
  assert.deepEqual(schema.pack('supervision-diaries', body()), body());
  assert.deepEqual(schema.unpack('supervision-diaries', body()), body());
  assert.equal(schema.schemas['supervision-logs'].fields.some(f => f[0] === 'otherWork'), false);
});
test('日记新增字段断网恢复与提交保留，展示元数据不进入写请求', async () => {
  const s = setup(), request = s.api.request;
  s.api.request = async (...args) => Object.assign(await request(...args), { authorId: 1, authorName: '真实记录人', reviewerId: 2, reviewerName: '真实审核人', reviewedAt: '2026-09-23T10:00:00' });
  const values = Object.assign(body(), { otherWork: '专题会议', newIssues: '质量问题', materialInspection: '试块送检' });
  const d = s.drafts.create('supervision-diaries', values); s.reload();
  assert.deepEqual(s.drafts.get(d.localId).body, values);
  await s.drafts.sync(d.localId);
  assert.equal(s.drafts.get(d.localId).recordMeta.authorName, '真实记录人');
  assert.equal(s.calls[0].body.otherWork, '专题会议');
  assert.equal(s.calls[0].body.materialInspection, '试块送检');
  assert.equal(s.calls[0].body.reviewerId, undefined);
  assert.equal(s.calls[0].body.authorName, undefined);
  await s.drafts.submit(d.localId);
  assert.equal(s.drafts.get(d.localId).body.newIssues, '质量问题');
  assert.equal(s.drafts.get(d.localId).recordMeta.reviewerName, '真实审核人');
  assert.equal(s.drafts.get(d.localId).serverStatus, 'submitted');
});
test('旧请求重试期间新增日记字段，不改变原 pending 正文', async () => {
  const s = setup(), d = create(s), request = s.api.request; let lost = true;
  s.api.request = async (...args) => { if (lost) { lost = false; await request(...args); throw error(undefined); } return request(...args); };
  await assert.rejects(s.drafts.sync(d.localId));
  const original = copy(s.drafts.get(d.localId).pending);
  s.drafts.edit(d.localId, { body: Object.assign(body(), { otherWork: '升级后新填' }) });
  await s.drafts.sync(d.localId);
  assert.deepEqual(s.calls[1].body, original.body);
  assert.equal(s.drafts.get(d.localId).body.otherWork, '升级后新填');
  assert.equal(s.drafts.get(d.localId).dirty, true);
  await s.drafts.sync(d.localId);
  assert.equal(s.calls[2].body.otherWork, '升级后新填');
});
test('只读人员不冒用当前用户，退回重提不显示本次已通过', () => {
  const record = { id: 3, authorId: 9, reviewerId: 8, reviewerName: '张总监', reviewedAt: '2026-09-23T10:00:00', status: 'submitted' };
  const people = schema.diaryPeople(record, { userName: '查看者' });
  assert.equal(people.author, '用户#9');
  assert.match(people.reviewer, /本次尚未通过/);
  assert.match(schema.diaryPeople({ id: 2, status: 'approved' }).reviewer, /缺失/);
  assert.equal(schema.diaryPeople({}, { userName: '专业监理' }).author, '专业监理');
});
test('离线草稿重启恢复并按账号隔离', () => {
  const s = setup(), d = create(s); s.reload();
  assert.equal(s.drafts.get(d.localId).body.construction, '现场原文');
  s.uid = '2'; assert.equal(s.drafts.list().length, 0);
  s.uid = '1'; assert.equal(s.drafts.list().length, 1);
});
test('新建响应丢失后重放同一正文与 key，保留后续编辑', async () => {
  const s = setup(), d = create(s), request = s.api.request; let lost = true;
  s.api.request = async (...args) => {
    if (args[1] === 'POST' && lost) { lost = false; await request(...args); throw error(undefined, '响应丢失'); }
    if (args[1] === 'POST') { s.calls.push(copy({ method: args[1], body: args[2], headers: args[3] })); return copy(s.server); }
    return request(...args);
  };
  await assert.rejects(s.drafts.sync(d.localId));
  s.drafts.edit(d.localId, { body: Object.assign(body(), { construction: '新内容' }) });
  await s.drafts.sync(d.localId);
  assert.deepEqual(s.calls[0].body, s.calls[1].body);
  assert.deepEqual(s.calls[0].headers, s.calls[1].headers);
  assert.equal(s.drafts.get(d.localId).dirty, true);
  await s.drafts.sync(d.localId);
  assert.equal(s.server.construction, '新内容'); assert.equal(s.drafts.get(d.localId).dirty, false);
});
test('服务器生成编号回填，旧页面正文不能清掉已分配编号', async () => {
  const s = setup(), d = create(s), request = s.api.request;
  s.api.request = async (...args) => Object.assign(await request(...args), { code: 'DIARY-assigned' });
  await s.drafts.sync(d.localId);
  assert.equal(s.drafts.get(d.localId).body.code, 'DIARY-assigned');
  s.drafts.edit(d.localId, { body: body() });
  await s.drafts.sync(d.localId);
  assert.equal(s.calls[1].body.code, 'DIARY-assigned');
});
test('移除已上传本机照片同步时不残留旧引用', async () => {
  const s = setup(), d = create(s);
  s.drafts.edit(d.localId, { media: [{ id: 'p1', path: '/persistent/a.jpg' }] });
  await s.drafts.sync(d.localId);
  const saved = Object.assign(body(), { photos: s.server.photos });
  s.drafts.edit(d.localId, { body: saved, media: [] });
  await s.drafts.sync(d.localId);
  assert.deepEqual(JSON.parse(s.server.photos), []);
});
test('服务端 400 明确拒绝后可纠正文案再保存', async () => {
  const s = setup(), d = create(s), request = s.api.request;
  s.api.request = async () => { throw error(400); };
  await assert.rejects(s.drafts.sync(d.localId));
  assert.equal(s.drafts.get(d.localId).pending, null);
  s.drafts.edit(d.localId, { body: Object.assign(body(), { construction: '纠正内容' }) });
  s.api.request = request; await s.drafts.sync(d.localId);
  assert.equal(s.server.construction, '纠正内容');
});
test('并行同步同草稿只有一个在途任务', async () => {
  const s = setup(), d = create(s), gate = deferred(), request = s.api.request;
  s.api.request = async (...args) => { await gate.promise; return request(...args); };
  const a = s.drafts.sync(d.localId), b = s.drafts.sync(d.localId);
  assert.equal(a, b); gate.resolve(); await a; assert.equal(s.calls.length, 1);
});
test('版本冲突保留原 pending，自动同步不覆盖', async () => {
  const s = setup(); const d = s.drafts.create('supervision-diaries', body(), { id: 10, status: 'draft', lockVersion: 0 });
  s.drafts.edit(d.localId, { body: Object.assign(body(), { construction: '手机稿' }) });
  s.api.request = async (url, method) => { if (method === 'PUT') throw error(409); return { construction: 'PC稿', id: 10, lockVersion: 1 }; };
  await assert.rejects(s.drafts.sync(d.localId));
  assert.equal(s.drafts.get(d.localId).state, '内容冲突');
  assert.ok(s.drafts.get(d.localId).pending); await s.drafts.syncQueued();
  assert.equal(s.drafts.get(d.localId).body.construction, '手机稿');
});
test('更新响应丢失后仅接纳服务器完全相同内容', async () => {
  const s = setup(); const d = s.drafts.create('supervision-diaries', body(), { id: 10, status: 'draft', lockVersion: 0 });
  s.drafts.edit(d.localId, { body: body() }); let applied = false;
  s.api.request = async (url, method, input) => {
    if (method === 'PUT' && !applied) { applied = true; s.server = Object.assign({}, input, { id: 10, lockVersion: 1 }); throw error(undefined); }
    if (method === 'PUT') throw error(409);
    return copy(s.server);
  };
  await assert.rejects(s.drafts.sync(d.localId)); await s.drafts.sync(d.localId);
  assert.equal(s.drafts.get(d.localId).version, 1); assert.equal(s.drafts.get(d.localId).pending, null);
});
test('页面旧照片对象不能覆盖同步过程已确认的 URL', async () => {
  const s = setup(), d = create(s), gate = deferred(), sent = deferred(), request = s.api.request;
  const photo = { id: 'p1', path: '/persistent/a.jpg', description: '' };
  s.drafts.edit(d.localId, { media: [photo] });
  s.api.request = async (...args) => { sent.resolve(); await gate.promise; return request(...args); };
  const work = s.drafts.sync(d.localId); await sent.promise;
  s.drafts.edit(d.localId, { media: [photo], body: Object.assign(body(), { construction: '上传时编辑' }) });
  assert.equal(s.drafts.get(d.localId).media[0].url, '/api/uploads/a.jpg');
  gate.resolve(); await work; await s.drafts.sync(d.localId);
  assert.equal(s.uploads.length, 1); assert.equal(s.server.construction, '上传时编辑');
});
test('同步中新增照片也必须上传后才保存', async () => {
  const s = setup(), d = create(s), gate = deferred(), entered = deferred();
  s.drafts.edit(d.localId, { media: [{ id: 'p1', path: '/persistent/1.jpg' }] });
  s.api.upload = async file => { s.uploads.push(file); if (s.uploads.length === 1) { entered.resolve(); await gate.promise; } return { url: '/api/uploads/' + s.uploads.length + '.jpg' }; };
  const work = s.drafts.sync(d.localId); await entered.promise;
  s.drafts.edit(d.localId, { media: s.drafts.get(d.localId).media.concat({ id: 'p2', path: '/persistent/2.jpg' }) });
  gate.resolve(); await work;
  assert.equal(s.uploads.length, 2); assert.equal(JSON.parse(s.server.photos).length, 2);
});
test('提交期间编辑不丢失，显示冲突而非全部同步', async () => {
  const s = setup(), d = create(s), gate = deferred(), entered = deferred(), request = s.api.request;
  s.api.request = async (...args) => { if (args[0].endsWith('/submit')) { entered.resolve(); await gate.promise; } return request(...args); };
  const work = s.drafts.submit(d.localId); await entered.promise;
  s.drafts.edit(d.localId, { body: Object.assign(body(), { construction: '提交期间新写' }) });
  gate.resolve(); const result = await work;
  assert.equal(result.state, '内容冲突'); assert.equal(result.body.construction, '提交期间新写');
});
test('后台不启动新同步，登录过期保留原账号草稿', async () => {
  const s = setup(), d = create(s); s.foreground = false; await s.drafts.syncQueued(); assert.equal(s.calls.length, 0);
  s.foreground = true; s.api.request = async () => { s.uid = null; throw error(401); };
  await assert.rejects(s.drafts.sync(d.localId)); s.uid = '1';
  assert.ok(s.drafts.get(d.localId).pending); assert.equal(s.drafts.get(d.localId).body.construction, '现场原文');
});
test('存储不足抛错且保留上次成功的草稿', () => {
  const s = setup(), d = create(s); s.quota = true;
  assert.throws(() => s.drafts.edit(d.localId, { body: Object.assign(body(), { construction: '未落盘内容' }) }), /存储不足/);
  s.quota = false; assert.equal(s.drafts.get(d.localId).body.construction, '现场原文');
});
test('照片存入持久目录，清理已同步稿不删冲突副本照片', async () => {
  const s = setup(), d = create(s), photo = await s.drafts.persistPhoto('/temp/a.jpg');
  assert.match(photo.path, /^\/persistent\/field-/);
  s.drafts.edit(d.localId, { media: [photo] }); await s.drafts.sync(d.localId);
  const fork = s.drafts.fork(d.localId); s.drafts.forget(d.localId);
  assert.equal(s.removed.length, 0); assert.equal(s.drafts.get(fork.localId).media[0].path, photo.path);
});

test('刷新服务器草稿后不能恢复 PC 已移除的照片', async () => {
  const s = setup(), d = create(s);
  s.drafts.edit(d.localId, { media: [{ id: 'p1', path: '/persistent/a.jpg' }] });
  await s.drafts.sync(d.localId);
  s.drafts.create(d.kind, body(), { id: 10, status: 'draft', lockVersion: 1 });
  assert.equal(s.drafts.get(d.localId).media.length, 0);
  s.drafts.edit(d.localId, { body: body() }); await s.drafts.sync(d.localId);
  assert.deepEqual(JSON.parse(s.server.photos), []);
});
test('刷新服务器草稿同步照片说明，不以本机旧说明覆盖', async () => {
  const s = setup(), d = create(s);
  s.drafts.edit(d.localId, { media: [{ id: 'p1', path: '/persistent/a.jpg', description: '旧说明' }] });
  await s.drafts.sync(d.localId);
  const updated = Object.assign(body(), { photos: JSON.stringify([{ url: '/api/uploads/a.jpg', description: 'PC补充' }]) });
  s.drafts.create(d.kind, updated, { id: 10, status: 'rejected', lockVersion: 1, rejectReason: '补充部位' });
  assert.equal(s.drafts.get(d.localId).media[0].description, 'PC补充');
  assert.equal(s.drafts.get(d.localId).rejectReason, '补充部位');
  s.drafts.edit(d.localId, { body: updated }); await s.drafts.sync(d.localId);
  assert.equal(JSON.parse(s.server.photos)[0].description, 'PC补充');
});
test('页面存储失败暂停自动同步，重新落盘后继续', async () => {
  const s = setup(), d = create(s), changed = Object.assign(body(), { construction: '内存新内容' });
  s.quota = true; assert.throws(() => s.drafts.edit(d.localId, { body: changed }));
  s.quota = false; await s.drafts.syncQueued(); assert.equal(s.calls.length, 0);
  await assert.rejects(s.drafts.sync(d.localId), /未保存修改/);
  s.drafts.edit(d.localId, { body: changed }); await s.drafts.syncQueued();
  assert.equal(s.server.construction, '内存新内容');
});
test('在途响应不能把存储失败的新编辑标成已同步或清除', async () => {
  const s = setup(), d = create(s), gate = deferred(), entered = deferred(), request = s.api.request;
  s.api.request = async (...args) => { entered.resolve(); await gate.promise; return request(...args); };
  const work = s.drafts.sync(d.localId); await entered.promise;
  s.quota = true; assert.throws(() => s.drafts.edit(d.localId, { body: Object.assign(body(), { construction: '尚未落盘' }) }));
  s.quota = false; gate.resolve(); await work;
  assert.equal(s.drafts.get(d.localId).dirty, true);
  assert.throws(() => s.drafts.forget(d.localId), /未保存修改/);
  await s.drafts.syncQueued(); assert.equal(s.calls.length, 1);
});

test('已通过和已退回本机副本保留真实业务状态提示', () => {
  const s = setup();
  const d = s.drafts.create('supervision-diaries', body(), { id: 10, status: 'approved', lockVersion: 2 });
  assert.equal(d.state, '审核通过');
  const refreshed = s.drafts.create(d.kind, body(), { id: 10, status: 'rejected', lockVersion: 3, rejectReason: '补充' });
  assert.equal(refreshed.state, '已退回'); assert.equal(refreshed.rejectReason, '补充');
});
test('提交期间新编辑存储失败不能误报本机内容全部已提交', async () => {
  const s = setup(), d = create(s), gate = deferred(), entered = deferred(), request = s.api.request;
  s.api.request = async (...args) => { if (args[0].endsWith('/submit')) { entered.resolve(); await gate.promise; } return request(...args); };
  const work = s.drafts.submit(d.localId); await entered.promise;
  s.quota = true; assert.throws(() => s.drafts.edit(d.localId, { body: Object.assign(body(), { construction: '提交时新编辑' }) }));
  s.quota = false; gate.resolve(); const result = await work;
  assert.equal(result.state, '内容冲突'); assert.equal(result.dirty, true);
  assert.throws(() => s.drafts.create(d.kind, body(), s.server), /未保存修改/);
});

// 在隔离 DOM 桩中执行电脑端真实组件；不请求本地业务服务、不写真实浏览器草稿。
async function setupPc(kind = 'supervision-diaries', search = '', projects = [{ id: 2, name: '测试工程' }], record = null) {
  const nodes = {}, values = new Map(), state = { calls: [], records: [], uploads: [], projects, record, uid: 1 };
  let elementSeq = 0;
  function node(id) {
    return nodes[id] || (nodes[id] = { id, value: '', dataset: {}, style: {}, hidden: false, innerHTML: '', textContent: '', children: [],
      classList: { add() {}, remove() {} }, listeners: {},
      addEventListener(event, fn) { this.listeners[event] = fn; }, insertAdjacentHTML() {}, focus() { state.focus = id; },
      appendChild(child) { this.children.push(child); }, querySelectorAll() { return []; }, querySelector() { return null; }, click() {} });
  }
  const root = node('fieldWorkspace'); root.dataset.kind = kind;
  root.querySelector = selector => selector === 'thead th:nth-child(4)' ? node('authorHeading') : null;
  state.enableControls = () => {
    let html = '', controls = [];
    const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, c => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[c]);
    Object.defineProperty(node('fwForm'), 'innerHTML', { get: () => html, set(value) {
      html = value; controls = [];
      for (const match of value.matchAll(/<(input|textarea)\b([^>]*data-field="([^"]+)"[^>]*)>([^<]*)/g)) {
        const field = match[3], control = node('fwF-' + field);
        control.dataset = { field }; control.listeners = {};
        control.value = decode(match[1] === 'textarea' ? match[4] : ((match[2].match(/\bvalue="([^"]*)"/) || [])[1] || ''));
        controls.push(control);
      }
    } });
    root.querySelectorAll = selector => selector === '[data-field]' ? controls : [];
    state.input = (field, value) => { const control = node('fwF-' + field); control.value = value; control.listeners.input(); };
  };
  const App = { escape: value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    requireAuth: () => true, initTopbar() {}, getUser: () => ({ userId: state.uid, userName: '当前账号' }),
    getToken: () => 'test', confirm: async () => true, buildQuery: p => new URLSearchParams(p).toString(),
    uploadFile: async file => {
      state.uploads.push(file.name);
      if (state.uploadFailure === file.name) throw new Error('附件上传失败');
      return { url: '/api/uploads/' + encodeURIComponent(file.name), name: file.name, size: 10 };
    },
    apiGetPage: async path => ({ list: path === '/projects' ? state.projects : state.records, total: path === '/projects' ? state.projects.length : state.records.length }),
    apiFetch: async (path, opts) => {
      state.calls.push({ path, opts });
      if (path.startsWith('/field/summary')) {
        if (state.summaryGate) await state.summaryGate.promise;
        if (state.summaryError) throw new Error(state.summaryError);
        return { canReview: true, [kind]: { draft: 0, submitted: 0, approved: 0, rejected: 0 } };
      }
      if (path.startsWith('/field/diary-prefill')) return state.prefill ? state.prefill(path) : copy(state.prefillSource || {});
      if (path.startsWith('/field/diary-source')) return state.source;
      if (path.startsWith('/files/access')) return { url: 'signed:file' };
      if (!opts) return state.record;
      state.saved = path.endsWith('/submit')
        ? Object.assign({}, state.saved, { status: 'submitted', lockVersion: state.saved.lockVersion + 1 })
        : Object.assign({}, opts.body, { id: 10, lockVersion: 1, authorId: 1, authorName: '实际记录人', status: 'draft' });
      return state.saved;
    }
  };
  const context = { App, document: { getElementById: node, body: node('body'), createElement: () => node('generated-' + ++elementSeq) },
    location: { origin: 'https://test.invalid', search }, crypto: require('node:crypto').webcrypto, URLSearchParams,
    sessionStorage: { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: k => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) },
    Blob, URL: { createObjectURL: blob => { state.blob = blob; return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout: () => 0, console, addEventListener() {}, print() { if (state.onPrint) state.onPrint(); } };
  context.window = context; context.FieldSchema = schema;
  const code = fs.readFileSync(path.join(__dirname, '../../assets/field-records.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'window.testActions = { create, open, show, save, exportRows, prefillLog, closeEditor, getDraft: () => draft };})();');
  vm.runInNewContext(code, context);
  await new Promise(resolve => setImmediate(resolve));
  return Object.assign(state, { nodes, values, actions: context.testActions });
}
test('电脑端日记九项正文直显、项目日期带入、提示不自动成为正文', async () => {
  const s = await setupPc(); await s.actions.create();
  const html = s.nodes.fwForm.innerHTML;
  assert.match(html, /工程名称/); assert.match(html, /测试工程/); assert.match(html, /记录人/); assert.match(html, /审核人/);
  assert.doesNotMatch(html, /<details/);
  for (const [key, label] of schema.schemas['supervision-diaries'].fields) {
    assert.ok(html.includes('data-field="' + key + '"'), key); assert.ok(html.includes(label));
    const control = html.match(new RegExp('<(?:input|textarea)[^>]*data-field="' + key + '"[^>]*>'))[0];
    const hint = schema.schemas['supervision-diaries'].hints[key];
    assert.ok(control.includes('placeholder="' + hint + '"'), key + ' 使用原框下规范作为框内提示');
    assert.ok(control.includes('title="' + hint + '"'), key + ' 可悬停查看完整提示');
    assert.ok(!html.includes('id="fwHint-' + key + '"'), key + ' 不重复显示框下说明');
    assert.ok(!control.includes(schema.schemas['supervision-diaries'].placeholders[key]), key + ' 移除原示例');
    assert.equal(s.actions.getDraft().body[key], undefined);
  }
  for (const key of ['projectId', 'diaryDate', 'author', 'reviewer']) assert.ok(html.includes('id="fwHint-' + key + '"'), key + ' 保留自动显示项说明');
  assert.match(html, /data-field="code"[^>]*placeholder="留空由系统生成，可按需修改。"/);
  assert.match(html, /type="date"[^>]*readonly/);
  assert.equal(s.actions.getDraft().body.diaryDate, schema.today());
  Object.assign(s.actions.getDraft().body, { otherWork: '专题会议', newIssues: '新问题', materialInspection: '送检中' });
  await s.actions.save(false);
  const write = s.calls.find(c => c.opts && c.opts.method === 'POST');
  assert.equal(write.opts.body.otherWork, '专题会议'); assert.equal(write.opts.body.projectId, 2);
  assert.equal(write.opts.body.reviewerId, undefined); assert.equal(write.opts.body.authorName, undefined);
});
test('电脑端多项目先明确归属，只读详情取服务器原记录并隐藏写按钮', async () => {
  const s = await setupPc('supervision-diaries', '', [{ id: 2, name: '测试工程' }, { id: 3, name: '另一工程' }]);
  await assert.rejects(s.actions.create(), /先在上方选择/);
  assert.equal(s.focus, 'fwProject');
  s.record = { id: 9, projectId: 2, diaryDate: '2020-01-01', authorId: 5, authorName: '原记录人', reviewerId: 6, reviewerName: '总监', reviewedAt: '2020-01-01T18:00:00', status: 'approved', otherWork: '旧正文' };
  const cached = JSON.stringify({ record: s.record, body: { projectId: 2, otherWork: '未同步内容' } });
  s.values.set('field-pc:https://test.invalid:1:supervision-diaries:draft:old', cached);
  await s.actions.open(9, true);
  assert.doesNotMatch(s.nodes.fwForm.innerHTML, /未同步内容/);
  assert.equal([...s.values.values()][0], cached);
  assert.match(s.nodes.fwForm.innerHTML, /原记录人/); assert.match(s.nodes.fwForm.innerHTML, /总监/);
  assert.match(s.nodes.fwForm.innerHTML, /旧正文/); assert.match(s.nodes.fwForm.innerHTML, /2020-01-01/);
  for (const id of ['fwSave', 'fwSubmit', 'fwApprove', 'fwReject', 'fwFork', 'fwRevise']) assert.equal(s.nodes[id].hidden, true, id);
});
test('未选项目的新建提示在选择有效项目后清除，未选择时仍拦截', async () => {
  const s = await setupPc('supervision-diaries', '', [{ id: 2, name: '测试工程' }, { id: 3, name: '另一工程' }]);
  await s.nodes.fwNew.onclick();
  assert.match(s.nodes.fieldError.textContent, /请先在上方选择/);
  assert.equal(s.nodes.fwError.textContent, s.nodes.fieldError.textContent);
  assert.equal(s.actions.getDraft(), null); assert.equal(s.values.size, 0);
  assert.equal(typeof s.nodes.fwProject.onchange, 'function');
  await s.nodes.fwProject.onchange();
  assert.match(s.nodes.fieldError.textContent, /请先在上方选择/);
  s.nodes.fwProject.value = '3';
  await s.nodes.fwProject.onchange();
  assert.equal(s.nodes.fieldError.textContent, ''); assert.equal(s.nodes.fwError.textContent, '');
  await s.nodes.fwNew.onclick();
  assert.equal(s.nodes.fwEditor.hidden, false);
  assert.equal(s.actions.getDraft().body.projectId, 3);
  assert.match(s.nodes.fwForm.innerHTML, /另一工程/);
  assert.equal(s.nodes.fwError.textContent, '');
});
test('新建成功前清除旧项目提示，不依赖下拉框变更事件', async () => {
  const s = await setupPc('supervision-diaries', '', [{ id: 2, name: '测试工程' }, { id: 3, name: '另一工程' }]);
  await s.nodes.fwNew.onclick();
  s.nodes.fwProject.value = '2';
  await s.nodes.fwNew.onclick();
  assert.equal(s.nodes.fieldError.textContent, ''); assert.equal(s.nodes.fwError.textContent, '');
  assert.equal(s.actions.getDraft().body.projectId, 2);
});
test('项目提示清理不掩盖其他错误或随后发生的请求失败', async () => {
  const s = await setupPc('supervision-diaries', '', [{ id: 2, name: '测试工程' }, { id: 3, name: '另一工程' }]);
  s.nodes.fieldError.textContent = '已有网络错误'; s.nodes.fwError.textContent = '已有网络错误';
  s.nodes.fwProject.value = '2';
  assert.equal(typeof s.nodes.fwProject.onchange, 'function');
  await s.nodes.fwProject.onchange();
  assert.equal(s.nodes.fieldError.textContent, '已有网络错误'); assert.equal(s.nodes.fwError.textContent, '已有网络错误');
  s.nodes.fwProject.value = ''; await s.nodes.fwNew.onclick();
  assert.match(s.nodes.fwError.textContent, /请先在上方选择/);
  s.nodes.fwProject.value = '3'; s.summaryError = '项目权限查询失败';
  await s.nodes.fwNew.onclick();
  assert.equal(s.nodes.fieldError.textContent, '项目权限查询失败'); assert.equal(s.nodes.fwError.textContent, '项目权限查询失败');
});
test('电脑端 CSV 含三项新增正文和真实人员，日志栏目不受影响', async () => {
  const s = await setupPc();
  s.records.push({ projectId: 2, authorId: 5, authorName: '原记录人', otherWork: '=危险公式', newIssues: '质量问题', materialInspection: '钢筋送检', status: 'draft' });
  await s.actions.exportRows();
  const csv = await s.blob.text();
  for (const text of ['工程名称', '记录人', '审核人', '其他工作', '工作中的新问题', '材料进场检查', '原记录人', '质量问题', '钢筋送检', "'=危险公式"]) assert.ok(csv.includes(text), text);
  const log = await setupPc('supervision-logs'); await log.actions.create();
  assert.match(log.nodes.fwForm.innerHTML, /工作内容/); assert.doesNotMatch(log.nodes.fwForm.innerHTML, /材料进场检查/);
});

test('电脑端日志四项正文直显、气象短输入和规范占位，不写入提示内容', async () => {
  const s = await setupPc('supervision-logs'); await s.actions.create();
  const html = s.nodes.fwForm.innerHTML, log = schema.schemas['supervision-logs'];
  for (const text of ['工程名称', '测试工程', '填写人', '项目安全监理工程师']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /data-field="projectId"/);
  assert.match(html, /data-field="logDate"[^>]*readonly/);
  assert.equal(s.actions.getDraft().body.logDate, schema.today());
  for (const [key, label] of log.fields) {
    assert.ok(html.includes(label));
    const control = html.match(new RegExp('<(?:input|textarea)[^>]*data-field="' + key + '"[^>]*>'))[0];
    assert.ok(control.includes('placeholder="' + log.hints[key] + '"'), key);
    assert.ok(!html.includes('id="fwHint-' + key + '"'));
    assert.equal(s.actions.getDraft().body[key], undefined);
    if (['weather', 'wind', 'temperature'].includes(key)) assert.match(control, /^<input.*maxlength="30"/);
  }
  for (const key of ['construction', 'inspection', 'safetyIssues', 'otherMatters']) assert.ok(html.indexOf('data-field="' + key + '"') < html.indexOf('<details'), key);
  assert.match(s.nodes.fwGuide.innerHTML, /9 项规范/);
  assert.ok(s.nodes.fieldWorkspace.innerHTML.includes(log.attachmentHint));
  assert.match(s.nodes.fieldWorkspace.innerHTML, /id="fwSubmit"[^>]*>提交</);
  assert.doesNotMatch(s.nodes.fieldWorkspace.innerHTML, /监理类型|参会人员|明日计划/);
  Object.assign(s.actions.getDraft().body, { construction: '二层脚手架搭设', safetyIssues: '防护缺失已整改', inspection: '验收资料核查', otherMatters: '重要会议' });
  await s.actions.save(true);
  const write = s.calls.find(c => c.opts && c.opts.body);
  assert.equal(write.opts.body.construction, '二层脚手架搭设'); assert.equal(write.opts.body.safetyIssues, '防护缺失已整改');
  assert.equal(write.opts.body.authorName, undefined); assert.equal(write.opts.body.reviewerId, undefined);
  assert.ok(write.opts.headers['Idempotency-Key']);
  assert.ok(s.calls.some(c => c.path.endsWith('/submit') && c.opts.headers['X-Record-Version'] === 1));
  assert.equal(s.actions.getDraft().record.status, 'submitted');
});
test('日志项目选择清除残留提示，新旧草稿、只读与修订均保留原日期和正文', async () => {
  const s = await setupPc('supervision-logs', '', [{ id: 2, name: '工程甲' }, { id: 3, name: '工程乙' }]);
  await s.nodes.fwNew.onclick(); assert.match(s.nodes.fwError.textContent, /请先在上方选择/);
  s.nodes.fwProject.value = '3'; s.nodes.fwProject.onchange();
  assert.equal(s.nodes.fwError.textContent, ''); await s.nodes.fwNew.onclick();
  assert.equal(s.actions.getDraft().body.projectId, 3);
  const record = { id: 9, projectId: 3, logDate: '2020-01-01', authorId: 1, authorName: '原填写人', status: 'approved', content: '原工作正文', management: '原管理情况', construction: '原施工进度', safetyIssues: '原处理结果' };
  s.record = record;
  const cached = JSON.stringify({ record, body: { ...record, safetyIssues: '未同步安全问题' }, requestId: 'old' });
  s.values.set('field-pc:https://test.invalid:1:supervision-logs:draft:old', cached);
  await s.actions.open(9, true);
  assert.match(s.nodes.fwForm.innerHTML, /原工作正文/); assert.match(s.nodes.fwForm.innerHTML, /<details class="fd-compat" open/);
  assert.doesNotMatch(s.nodes.fwForm.innerHTML, /未同步安全问题/);
  for (const id of ['fwSave', 'fwSubmit', 'fwSource', 'fwApprove', 'fwReject', 'fwFork', 'fwRevise', 'fwUploadField']) assert.equal(s.nodes[id].hidden, true, id);
  s.values.delete('field-pc:https://test.invalid:1:supervision-logs:draft:old');
  await s.actions.open(9); await s.nodes.fwRevise.onclick();
  assert.equal(s.actions.getDraft().body.logDate, '2020-01-01');
  assert.equal(s.actions.getDraft().body.safetyIssues, '原处理结果');
  assert.equal(s.actions.getDraft().body.sourceRecordId, 9);
  assert.equal(s.actions.getDraft().body.content, '原工作正文');
});
test('日志日记整编仅补空白栏，来源保留且不生成安全结论', async () => {
  const s = await setupPc('supervision-logs'); await s.actions.create();
  s.source = { construction: '日记施工进度', content: '综合整编原文', inspection: '日记巡查记录', sources: [{ id: 7, code: 'D7', date: schema.today(), lockVersion: 2 }] };
  s.actions.getDraft().body.inspection = '手写验收情况';
  await s.nodes.fwSource.onclick();
  const body = s.actions.getDraft().body;
  assert.equal(body.construction, '日记施工进度'); assert.equal(body.content, '综合整编原文');
  assert.equal(body.inspection, '手写验收情况'); assert.equal(body.safetyIssues, undefined);
  assert.equal(JSON.parse(body.diarySources)[0].id, 7);
  assert.match(s.nodes.fwForm.innerHTML, /<details class="fd-compat" open/);
  assert.match(s.nodes.fwGuide.innerHTML, /9 项规范/);
});
test('日志导出含新旧正文、真实人员、附件与来源，公式和引号转义保留', async () => {
  const s = await setupPc('supervision-logs');
  s.records.push({ projectId: 2, logDate: '2020-01-01', authorId: 5, authorName: '原填写人', reviewerName: '实际审核人', reviewerId: 6, status: 'approved', construction: '施工进度', safetyIssues: '=安全问题', inspection: '验收"合格"\n原文', otherMatters: '停工记录', content: '旧综合内容', attachments: '["验收单.pdf"]', diarySources: '[{"id":7}]' });
  await s.actions.exportRows(); const csv = await s.blob.text();
  for (const [, label] of schema.schemas['supervision-logs'].fields) assert.ok(csv.includes(label), label);
  for (const text of ['填写人', '测试工程', '原填写人', '实际审核人', '施工进度', "'=安全问题", '验收""合格""\n原文', '停工记录', '旧综合内容', '验收单.pdf', '引用日记']) assert.ok(csv.includes(text), text);
});
test('日志表单收集及恢复本机草稿保留新旧字段和原日期', async () => {
  const s = await setupPc('supervision-logs'); await s.actions.create();
  const body = { logDate: '2020-01-01', construction: '施工部位原文', safetyIssues: '已处理安全问题', inspection: '资料核查完成', content: '旧整编内容' };
  const controls = Object.entries(body).map(([field, value]) => ({ dataset: { field }, value, addEventListener() {} }));
  s.nodes.fieldWorkspace.querySelectorAll = selector => selector === '[data-field]' ? controls : [];
  await s.nodes.fwCancel.onclick();
  const localId = s.actions.getDraft().localId;
  const cached = JSON.parse([...s.values.values()][0]);
  for (const [key, value] of Object.entries(body)) assert.equal(cached.body[key], value, key);
  s.nodes.fieldWorkspace.querySelectorAll = () => [];
  await s.nodes.fwResume.onclick();
  await s.nodes.fwDraftList.children[0].onclick();
  assert.equal(s.actions.getDraft().localId, localId);
  for (const [key, value] of Object.entries(body)) assert.equal(s.actions.getDraft().body[key], value, key);
  await s.actions.save(false);
  for (const [key, value] of Object.entries(body)) assert.equal(s.saved[key], value, key);
});
test('日志附件失败时拦截提交，重试仅上传失败文件并保留正文', async () => {
  const s = await setupPc('supervision-logs'); await s.actions.create();
  s.actions.getDraft().body.safetyIssues = '安全问题整改复查';
  s.uploadFailure = '验收单.pdf';
  await s.nodes.fwUpload.onchange({ target: { files: [{ name: '现场.jpg', type: 'image/jpeg' }, { name: '验收单.pdf', type: 'application/pdf' }], value: '文件' } });
  assert.equal(s.nodes.fwRetryUpload.hidden, false); assert.match(s.nodes.fwUploadState.textContent, /附件上传失败/);
  assert.equal(JSON.parse(s.actions.getDraft().body.photos).length, 1);
  assert.equal(JSON.parse(s.actions.getDraft().body.attachments).length, 0);
  await assert.rejects(s.actions.save(true), /未成功上传的文件/);
  assert.ok(!s.calls.some(c => c.opts && c.opts.body));
  s.uploadFailure = null; await s.nodes.fwRetryUpload.onclick();
  assert.deepEqual(s.uploads, ['现场.jpg', '验收单.pdf', '验收单.pdf']);
  assert.equal(s.nodes.fwRetryUpload.hidden, true); assert.match(s.nodes.fwUploadState.textContent, /继续保存/);
  await s.actions.save(true);
  assert.equal(s.saved.safetyIssues, '安全问题整改复查');
  assert.equal(JSON.parse(s.saved.photos).length, 1);
  assert.equal(JSON.parse(s.saved.attachments)[0].name, '验收单.pdf');
  assert.equal(s.saved.status, 'submitted');
});
test('日志只读链接初始化加载原记录，非法编号不请求详情', async () => {
  const record = { id: 9, projectId: 2, authorId: 1, authorName: '原填写人', logDate: '2020-01-01', status: 'draft', construction: '服务器施工原文', safetyIssues: '服务器处理结果' };
  const s = await setupPc('supervision-logs', '?readonly=true&id=9', undefined, record);
  assert.equal(s.actions.getDraft().readOnly, true); assert.equal(s.values.size, 0);
  assert.equal(s.actions.getDraft().body.safetyIssues, '服务器处理结果');
  assert.ok(s.calls.some(c => c.path === '/supervision-logs/9' && !c.opts));
  assert.equal(s.nodes.fwSubmit.hidden, true); assert.equal(s.nodes.fwSave.hidden, true);
  const invalid = await setupPc('supervision-logs', '?readonly=true&id=9abc');
  assert.match(invalid.nodes.fieldError.textContent, /监理日志编号参数无效/);
  assert.ok(!invalid.calls.some(c => c.path.startsWith('/supervision-logs/')));
});
test('日志打印临时展开兼容栏目并恢复，不改变表单值', async () => {
  const s = await setupPc('supervision-logs'); await s.actions.create();
  const details = { open: false };
  const field = { value: '施工进度与安全问题原文', hidden: false, tagName: 'TEXTAREA', after(node) { this.printed = node.textContent; } };
  s.nodes.fwForm.querySelectorAll = selector => selector.startsWith('details') ? [details] : [field];
  s.onPrint = () => { assert.equal(details.open, true); assert.equal(field.hidden, true); assert.equal(field.printed, field.value); };
  s.nodes.fwPrint.onclick();
  assert.equal(details.open, false); assert.equal(field.hidden, false);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
const prefillCalls = s => s.calls.filter(c => (c.path || c.url).startsWith('/field/diary-prefill'));
test('共享字段补丁只补空白原值、不修改输入且拒绝元数据和超长值', () => {
  const original = { construction: '手写', inspection: '  ', content: '历史正文', safetyIssues: '' };
  const values = { construction: '日记', inspection: '检查\n原文', safetyIssues: '待处理', weather: '长'.repeat(31), management: '长'.repeat(60001),
    morningMeeting: 123, otherMatters: ' ', authorId: 99, photos: '["外部附件"]', content: '不能写入', sources: [{ id: 7 }] };
  const before = copy(original);
  assert.deepEqual(schema.logPrefillPatch(original, values, ['safetyIssues']), { inspection: '检查\n原文' });
  assert.deepEqual(original, before);
});
test('电脑端新建日志自动预填到控件与草稿，仅复制对应字段值', async () => {
  const s = await setupPc('supervision-logs'); s.enableControls();
  s.prefillSource = { construction: 'A区施工', inspection: '巡视与资料审核', safetyIssues: '临边待整改', weather: '晴', management: '管理在岗',
    code: '不可复制', projectId: 99, logDate: '2000-01-01', authorName: '日记作者', photos: '["photo"]', attachments: '["file"]', diarySources: '[{"id":9}]', content: '不复制综合正文' };
  await s.actions.create(); await tick();
  const d = s.actions.getDraft(), request = new URL(prefillCalls(s)[0].path, 'https://test.invalid');
  assert.equal(request.searchParams.get('projectId'), '2'); assert.equal(request.searchParams.get('date'), schema.today());
  for (const field of ['construction', 'inspection', 'safetyIssues', 'weather', 'management']) {
    assert.equal(s.nodes['fwF-' + field].value, s.prefillSource[field]);
    assert.equal(JSON.parse([...s.values.values()][0]).body[field], s.prefillSource[field]);
  }
  assert.equal(d.body.projectId, 2); assert.equal(d.body.logDate, schema.today()); assert.equal(d.body.code, '');
  assert.equal(d.body.authorName, undefined); assert.equal(d.body.diarySources, undefined); assert.equal(d.body.content, '');
  assert.equal(d.body.photos, '[]'); assert.equal(d.body.attachments, '[]');
  assert.ok(!s.calls.some(c => c.opts));
  s.input('safetyIssues', '已核实并整改'); await s.actions.save(false);
  assert.equal(s.saved.safetyIssues, '已核实并整改'); assert.equal(s.saved.construction, 'A区施工');
  assert.equal(prefillCalls(s).length, 1);
});
test('电脑端编辑历史日志按原日期取数并保护手写、附件及既有来源', async () => {
  const s = await setupPc('supervision-logs'); s.enableControls();
  s.record = { id: 7, projectId: 2, logDate: '2020-01-01', status: 'rejected', authorId: 1, lockVersion: 3,
    construction: '领导手写施工', content: '旧整编正文', attachments: '[{"url":"old.pdf"}]', diarySources: '[{"id":8}]' };
  s.prefillSource = { construction: '不覆盖', inspection: '日记巡视', safetyIssues: '日记新问题' };
  await s.actions.open(7); await tick();
  const d = s.actions.getDraft();
  assert.match(prefillCalls(s)[0].path, /date=2020-01-01/);
  assert.equal(d.body.construction, '领导手写施工'); assert.equal(d.body.inspection, '日记巡视');
  assert.equal(d.body.content, '旧整编正文'); assert.equal(d.body.diarySources, '[{"id":8}]');
  assert.deepEqual(JSON.parse(d.body.attachments), [{ url: 'old.pdf' }]); assert.equal(d.record.lockVersion, 3);
});
test('电脑端预填请求期间输入或主动清空不被覆盖，手动重试仍保护在途编辑', async () => {
  const s = await setupPc('supervision-logs'); s.enableControls(); const gate = deferred();
  s.prefill = () => gate.promise; await s.actions.create();
  s.input('construction', '输入中的施工'); s.input('inspection', '先填写'); s.input('inspection', '');
  gate.resolve({ construction: '日记施工', inspection: '日记巡视', safetyIssues: '日记问题' }); await tick();
  assert.equal(s.nodes['fwF-construction'].value, '输入中的施工'); assert.equal(s.nodes['fwF-inspection'].value, '');
  assert.equal(s.nodes['fwF-safetyIssues'].value, '日记问题');
  s.prefill = null; s.prefillSource = { inspection: '重新选取巡视' };
  await s.actions.prefillLog(true); assert.equal(s.nodes['fwF-inspection'].value, '');
  await s.nodes.fwPrefill.onclick(); assert.equal(s.nodes['fwF-inspection'].value, '重新选取巡视');
  s.input('inspection', ''); await s.actions.save(false); await tick();
  assert.equal(s.nodes['fwF-inspection'].value, ''); assert.equal(prefillCalls(s).length, 3);
});
test('电脑端关闭、切换记录、保存或切账号后丢弃迟到预填响应', async () => {
  for (const transition of ['close', 'switch', 'save', 'account']) {
    const s = await setupPc('supervision-logs'); s.enableControls(); const gate = deferred();
    s.prefill = () => gate.promise; await s.actions.create();
    const old = s.actions.getDraft();
    if (transition === 'close') s.actions.closeEditor();
    if (transition === 'switch') {
      s.prefill = null; s.record = { id: 8, projectId: 2, logDate: '2020-01-01', authorId: 1, status: 'draft' };
      await s.actions.open(8);
    }
    if (transition === 'save') await s.actions.save(false);
    if (transition === 'account') s.uid = 2;
    gate.resolve({ safetyIssues: '旧请求不可写入' }); await tick();
    assert.notEqual(old.body.safetyIssues, '旧请求不可写入', transition);
    assert.notEqual(s.actions.getDraft().body.safetyIssues, '旧请求不可写入', transition);
  }
});
test('电脑端只读、非本人、已提交及待确认请求不触发预填', async () => {
  for (const mode of ['readonly', 'other', 'submitted', 'approved', 'pending']) {
    const s = await setupPc('supervision-logs');
    const local = { record: { id: 7, status: ['submitted', 'approved'].includes(mode) ? mode : 'draft', authorId: mode === 'other' ? 3 : 1 },
      body: { projectId: 2, logDate: '2020-01-01' }, readOnly: mode === 'readonly', pending: mode === 'pending' ? { body: { construction: '原请求' } } : null };
    await s.actions.show(local, true); await tick();
    assert.equal(prefillCalls(s).length, 0, mode);
  }
  const diary = await setupPc(); await diary.actions.create(); assert.equal(prefillCalls(diary).length, 0);
});
test('电脑端恢复本机草稿自动补空白，失败独立提示且可重试', async () => {
  const s = await setupPc('supervision-logs'); s.enableControls();
  s.prefill = async () => { throw new Error('模拟断网'); };
  await s.actions.create(); await tick();
  assert.match(s.nodes.fwPrefillState.textContent, /模拟断网/); assert.equal(s.nodes.fwError.textContent, '');
  s.input('construction', '离线手写'); await s.nodes.fwCancel.onclick();
  s.prefill = null; s.prefillSource = { construction: '不覆盖', safetyIssues: '日记问题' };
  await s.nodes.fwResume.onclick(); await s.nodes.fwDraftList.children[0].onclick(); await tick();
  assert.equal(s.nodes['fwF-construction'].value, '离线手写'); assert.equal(s.nodes['fwF-safetyIssues'].value, '日记问题');
  assert.equal(prefillCalls(s).length, 2);
});
test('电脑端预填不等待统计接口，统计迟到不能在保存后重新回填', async () => {
  const s = await setupPc('supervision-logs'); s.enableControls(); const gate = deferred();
  s.summaryGate = gate; s.prefillSource = { inspection: '当日巡视' };
  const opening = s.actions.create(); await tick();
  assert.equal(prefillCalls(s).length, 1); assert.equal(s.nodes['fwF-inspection'].value, '当日巡视');
  s.input('inspection', ''); s.summaryGate = null; await s.actions.save(false);
  gate.resolve(); await opening; await tick();
  assert.equal(s.nodes['fwF-inspection'].value, ''); assert.equal(prefillCalls(s).length, 1);
});

const voiceSource = fs.readFileSync(path.join(__dirname, '../utils/voice.js'), 'utf8');
function setupVoice(enabled = true) {
  const s = { network: [], auth: [], starts: 0, stops: 0, texts: [], errors: [], ends: 0 };
  s.manager = { start(options) { s.starts++; s.options = options; }, stop() { s.stops++; } };
  const context = { module: { exports: {} }, require: () => ({ voiceEnabled: enabled }),
    requirePlugin: () => { if (s.pluginError) throw new Error('插件不可用'); return { getRecordRecognitionManager: () => s.manager }; },
    wx: { getNetworkType: options => s.network.push(options), authorize: options => s.auth.push(options) } };
  vm.runInNewContext(voiceSource, context, { filename: 'voice.js' });
  s.voice = context.module.exports;
  s.start = () => s.voice.start(text => s.texts.push(text), e => s.errors.push(e.message), () => s.ends++);
  s.authorize = () => { s.network.at(-1).success({ networkType: 'wifi' }); s.auth.at(-1).success(); };
  return s;
}
test('网络检查期间取消录音，迟到响应不能再申请录音授权', () => {
  const s = setupVoice(); s.start(); s.voice.stop(true);
  s.network[0].success({ networkType: 'wifi' });
  assert.equal(s.auth.length, 0); assert.equal(s.starts, 0); assert.equal(s.ends, 1);
});
test('授权等待期间取消，重新进入页面也不会被旧授权启动录音', () => {
  const s = setupVoice(); s.start(); s.network[0].success({ networkType: 'wifi' });
  s.voice.stop(true); s.start(); s.auth[0].success(); assert.equal(s.starts, 0);
  s.authorize(); assert.equal(s.starts, 1);
});
test('录音准备期间重复点击只能创建一个授权流程', () => {
  const s = setupVoice(); s.start(); s.start();
  assert.equal(s.network.length, 1); assert.match(s.errors[0], /稍后重试/);
  s.authorize(); assert.equal(s.starts, 1);
});
test('插件启动过程中隐藏页面，在启动确认后停止且不回填文字', () => {
  const s = setupVoice(); s.start(); s.authorize(); s.voice.stop(true);
  assert.equal(s.stops, 0); s.manager.onStart(); assert.equal(s.stops, 1);
  s.manager.onStop({ result: '不应回填' }); assert.deepEqual(s.texts, []); assert.equal(s.ends, 1);
});
test('手动结束正常录音，识别结果只回调一次', () => {
  const s = setupVoice(); s.start(); s.authorize(); s.manager.onStart();
  s.voice.stop(); s.voice.stop(); assert.equal(s.stops, 1);
  const callback = s.manager.onStop; callback({ result: 'C30，轴线A' }); callback({ result: '重复' });
  assert.deepEqual(s.texts, ['C30，轴线A']); assert.equal(s.ends, 1); assert.equal(s.options.duration, 60000);
});
test('停止回调前禁止新录音覆盖旧插件处理器', () => {
  const s = setupVoice(); s.start(); s.authorize(); s.manager.onStart();
  s.voice.stop(true); s.start(); assert.equal(s.network.length, 1);
  s.manager.onStop({ result: '旧结果' }); s.start(); s.authorize();
  assert.equal(s.starts, 2); assert.deepEqual(s.texts, []);
});
test('插件关闭、断网、授权拒绝及插件错误都有文字回退', () => {
  const disabled = setupVoice(false); disabled.start(); assert.equal(disabled.ends, 1); assert.equal(disabled.errors.length, 1);
  const offline = setupVoice(); offline.start(); offline.network[0].success({ networkType: 'none' }); assert.equal(offline.ends, 1); assert.equal(offline.auth.length, 0);
  const denied = setupVoice(); denied.start(); denied.network[0].success({ networkType: 'wifi' }); denied.auth[0].fail(); assert.equal(denied.ends, 1); assert.equal(denied.starts, 0);
  const broken = setupVoice(); broken.pluginError = true; broken.start(); broken.authorize(); assert.equal(broken.ends, 1); assert.equal(broken.errors.length, 1);
  const failed = setupVoice(); failed.start(); failed.authorize(); failed.manager.onError(); assert.equal(failed.ends, 1); assert.equal(failed.errors.length, 1);
});

const pageSource = fs.readFileSync(path.join(__dirname, '../pages/record/index.js'), 'utf8');
function setupPage(s) {
  let page;
  const voice = { start(onText) { s.onText = onText; }, stop(cancel) { s.voiceCancelled = cancel; } };
  s.api.fileUrl = async url => 'signed:' + url;
  s.wx.showModal = options => { s.modal = options; };
  s.wx.redirectTo = options => { s.redirect = options.url; };
  s.wx.setNavigationBarTitle = () => {}; s.wx.showToast = options => { s.toast = options.title; };
  vm.runInNewContext(pageSource, { Page: value => { page = value; }, wx: s.wx,
    require: name => ({ '../../utils/api': s.api, '../../utils/drafts': s.drafts, '../../utils/voice': voice, '../../utils/schema': schema })[name] });
  page.data = copy(page.data); page.uid = s.uid; page.kind = 'supervision-diaries'; page.visible = true;
  page.setData = values => Object.assign(page.data, copy(values));
  return page;
}
test('小程序日记气象短输入、正文提示、日期保留与详情人员', () => {
  const s = setup(), p = setupPage(s), d = create(s);
  p.localId = d.localId; p.showDraft(d);
  assert.equal(p.data.fields.filter(f => f.short).length, 3);
  assert.equal(p.data.fields.find(f => f.key === 'materialInspection').hint, schema.schemas[p.kind].hints.materialInspection);
  p.input({ currentTarget: { dataset: { field: 'diaryDate' } }, detail: { value: '2030-01-01' } });
  assert.equal(p.data.body.diaryDate, '2026-09-23');
  p.input({ currentTarget: { dataset: { field: 'otherWork' } }, detail: { value: '配合业主检查' } });
  assert.equal(s.drafts.get(d.localId).body.otherWork, '配合业主检查');
  p.showRecord(Object.assign(body(), { id: 20, authorId: 2, authorName: '其他记录人', status: 'approved', reviewerId: 3, reviewerName: '审核负责人', reviewedAt: '2026-09-23T18:00:00' }));
  assert.equal(p.data.people.author, '其他记录人'); assert.match(p.data.people.reviewer, /审核负责人/);
  assert.equal(p.data.editable, false);
  p.kind = 'daily-inspections'; assert.equal(p.fields({}).some(f => f.short), false);
});
test('小程序日志规范提示、自动项保护、旧记录及新字段离线同步', async () => {
  const s = setup(), p = setupPage(s); p.kind = 'supervision-logs';
  const values = { projectId: 2, logDate: '2020-01-01', content: '旧综合正文', construction: '现场施工进度', safetyIssues: '安全问题处理', photos: '[]', attachments: '["验收单.pdf"]' };
  const d = s.drafts.create(p.kind, values, { id: 10, status: 'draft', authorId: 1, authorName: '安全工程师', lockVersion: 1 });
  p.localId = d.localId; p.showDraft(d);
  assert.equal(p.data.people.author, '安全工程师');
  assert.equal(p.data.fields.filter(f => f.short).length, 3);
  for (const f of p.data.fields) assert.equal(f.placeholder, schema.schemas[p.kind].hints[f.key]);
  for (const field of ['projectId', 'logDate']) p.input({ currentTarget: { dataset: { field } }, detail: { value: '不应修改' } });
  assert.equal(p.data.body.projectId, 2); assert.equal(p.data.body.logDate, '2020-01-01');
  p.input({ currentTarget: { dataset: { field: 'safetyIssues' } }, detail: { value: '整改复查完成' } });
  s.reload(); assert.equal(s.drafts.get(d.localId).body.safetyIssues, '整改复查完成');
  await s.drafts.sync(d.localId);
  assert.equal(s.calls[0].body.content, '旧综合正文'); assert.equal(s.calls[0].body.construction, '现场施工进度');
  assert.equal(s.calls[0].body.attachments, '["验收单.pdf"]'); assert.equal(s.calls[0].body.authorName, undefined);
  await s.drafts.submit(d.localId); assert.equal(s.drafts.get(d.localId).body.safetyIssues, '整改复查完成');
  p.showRecord({ ...values, id: 20, authorId: 3, authorName: '原填写人', status: 'approved' });
  assert.equal(p.data.people.author, '原填写人'); assert.equal(p.data.editable, false);
});

const logBody = () => ({ projectId: 2, logDate: '2020-01-01', photos: '[]', attachments: '[]' });
function setupLogPage() {
  const s = setup(), p = setupPage(s); p.kind = 'supervision-logs';
  const d = s.drafts.create(p.kind, logBody()); p.localId = d.localId; p.showDraft(d);
  return { s, p, d };
}
const pageInput = (p, field, value) => p.input({ currentTarget: { dataset: { field } }, detail: { value } });
test('小程序新建及编辑加载自动预填，正文可修改且不复制作者附件来源', async () => {
  for (const mode of ['local', 'server']) {
    const { s, p, d } = setupLogPage();
    s.prefillSource = { construction: '日记施工', inspection: '日记巡视', safetyIssues: '待核实问题', projectId: 99, authorName: '不可复制', diarySources: '[{"id":9}]', attachments: '["file"]' };
    s.server = { ...logBody(), id: 10, authorId: 1, authorName: '领导', status: 'draft', lockVersion: 2, construction: '原有手写' };
    await p.onLoad(mode === 'local' ? { localId: d.localId } : { kind: p.kind, id: 10 }); await tick();
    const request = prefillCalls(s)[0]; assert.deepEqual(request.body, { projectId: 2, date: '2020-01-01' });
    assert.equal(p.data.body.inspection, '日记巡视'); assert.equal(p.data.fields.find(f => f.key === 'inspection').value, '日记巡视');
    assert.equal(p.data.body.construction, mode === 'local' ? '日记施工' : '原有手写');
    assert.equal(p.data.body.attachments, '[]'); assert.equal(p.data.body.diarySources, undefined); assert.equal(p.data.body.authorName, undefined);
    assert.equal(s.calls.some(c => c.method !== 'GET'), false);
    pageInput(p, 'safetyIssues', '核查后补充整改结果');
    await p.action({ currentTarget: { dataset: { action: 'save' } } });
    assert.equal(s.server.safetyIssues, '核查后补充整改结果'); assert.equal(prefillCalls(s).length, 1);
  }
});
test('小程序在途输入和主动清空受保护，按钮事件允许手动重试空栏', async () => {
  const { s, p } = setupLogPage(), gate = deferred(); s.prefill = () => gate.promise;
  const work = p.prefillLog(true);
  pageInput(p, 'construction', '手写'); pageInput(p, 'inspection', '先输入'); pageInput(p, 'inspection', '');
  gate.resolve({ construction: '不覆盖', inspection: '日记巡视', safetyIssues: '原文问题' }); await work;
  assert.equal(p.data.body.construction, '手写'); assert.equal(p.data.body.inspection, ''); assert.equal(p.data.body.safetyIssues, '原文问题');
  s.prefill = null; s.prefillSource = { inspection: '日记巡视' };
  await p.prefillLog(true); assert.equal(p.data.body.inspection, '');
  await p.prefillLog({ type: 'tap' }); assert.equal(p.data.body.inspection, '日记巡视');
});
test('小程序切后台、卸载、切账号或展示另一记录后丢弃迟到响应', async () => {
  for (const transition of ['hide', 'unload', 'account', 'record']) {
    const { s, p, d } = setupLogPage(), gate = deferred(); s.prefill = () => gate.promise;
    const work = p.prefillLog(true);
    if (transition === 'hide') p.onHide();
    if (transition === 'unload') p.onUnload();
    if (transition === 'account') s.uid = '2';
    if (transition === 'record') p.showRecord({ ...logBody(), id: 99, authorId: 2, status: 'approved' });
    gate.resolve({ inspection: '迟到原文' }); await work;
    assert.equal(p.data.body.inspection, undefined, transition);
    s.uid = '1'; assert.equal(s.drafts.get(d.localId).body.inspection, undefined, transition);
  }
});
test('小程序自动同步改变版本或存在待确认请求时不更改草稿与请求正文', async () => {
  for (const mode of ['version', 'pending']) {
    const { s, p, d } = setupLogPage(), gate = deferred(); s.prefill = () => gate.promise;
    const work = p.prefillLog(true);
    if (mode === 'pending') {
      const request = s.api.request;
      s.api.request = async (...args) => { if (args[1] === 'POST') { await request(...args); throw error(undefined, '响应丢失'); } return request(...args); };
      await assert.rejects(s.drafts.sync(d.localId));
    } else await s.drafts.sync(d.localId);
    const before = copy(s.drafts.get(d.localId));
    gate.resolve({ inspection: '不能覆盖同步状态' }); await work;
    assert.deepEqual(copy(s.drafts.get(d.localId)), before); assert.match(p.data.prefillState, /同步状态已变化/);
    if (mode === 'pending') { const count = prefillCalls(s).length; await p.prefillLog(true); assert.equal(prefillCalls(s).length, count); }
  }
});
test('小程序预填网络失败可继续填写重试，存储失败保留内存不谎报保存', async () => {
  const { s, p, d } = setupLogPage(); s.prefill = async () => { throw new Error('断网'); };
  await p.prefillLog(true); assert.match(p.data.prefillState, /断网/); pageInput(p, 'construction', '手写内容');
  s.prefill = null; s.prefillSource = { inspection: '巡视原文' }; s.quota = true;
  await p.prefillLog(false);
  assert.equal(p.data.body.inspection, '巡视原文'); assert.match(p.data.prefillState, /尚未保存到本机/);
  assert.equal(p.data.storageFailed, true); s.quota = false;
  assert.equal(s.drafts.get(d.localId).body.inspection, undefined); assert.equal(p.persist(), true);
  assert.equal(s.drafts.get(d.localId).body.inspection, '巡视原文');
});
test('小程序只读日志和日记不自动取数，保存后不补回清空字段', async () => {
  const { s, p, d } = setupLogPage(); s.prefillSource = { inspection: '参考原文' };
  await p.onLoad({ localId: d.localId }); await tick(); pageInput(p, 'inspection', '');
  await p.action({ currentTarget: { dataset: { action: 'save' } } }); await tick();
  assert.equal(p.data.body.inspection, ''); assert.equal(prefillCalls(s).length, 1);
  s.server = { ...logBody(), id: 99, authorId: 2, status: 'approved' };
  await p.onLoad({ kind: p.kind, id: 99 }); await tick(); assert.equal(prefillCalls(s).length, 1);
  const diary = create(s); await p.onLoad({ localId: diary.localId }); await tick(); assert.equal(prefillCalls(s).length, 1);
});
test('小程序录音开始取消在途预填并结束等待提示，语音核对后可继续编辑', async () => {
  const { s, p } = setupLogPage(), gate = deferred(); s.prefill = () => gate.promise;
  const work = p.prefillLog(true); p.recordVoice({ currentTarget: { dataset: { field: 'inspection' } } });
  gate.resolve({ inspection: '迟到巡视' }); await work;
  assert.doesNotMatch(p.data.prefillState, /正在读取/);
  const confirm = s.onText('语音巡视'); s.modal.success({ confirm: true, content: '核对后巡视' }); await confirm;
  assert.equal(p.data.body.inspection, '核对后巡视'); assert.equal(p.fieldEdits.inspection, 1);
});

test('照片链接迟到时不覆盖刚输入的说明', async () => {
  const s = setup(), p = setupPage(s), d = create(s), gate = deferred();
  p.localId = d.localId; p.showDraft(d);
  p.data.body.photos = JSON.stringify([{ url: '/api/uploads/a.jpg', description: '旧' }]);
  p.data.photos = [{ url: '/api/uploads/a.jpg', description: '旧' }];
  s.api.fileUrl = () => gate.promise;
  const work = p.loadFiles(p.data.body);
  p.remotePhotoDescription({ currentTarget: { dataset: { url: '/api/uploads/a.jpg' } }, detail: { value: '新说明' } });
  assert.equal(p.data.photos[0].description, '新说明'); gate.resolve('signed:a'); await work;
  assert.equal(p.data.photos[0].description, '新说明');
});
test('移除照片后迟到的签名链接不能恢复照片', async () => {
  const s = setup(), p = setupPage(s), d = create(s), gate = deferred();
  p.localId = d.localId; p.showDraft(d); p.data.body.photos = '["/api/uploads/a.jpg"]';
  s.api.fileUrl = () => gate.promise; const work = p.loadFiles(p.data.body);
  p.removeRemotePhoto({ currentTarget: { dataset: { url: '/api/uploads/a.jpg' } } });
  gate.resolve('signed:a'); await work;
  assert.equal(p.data.photos.length, 0); assert.equal(JSON.parse(p.data.body.photos).length, 0);
});
test('只读详情不沿用冲突和清理按钮，草稿不沿用修订按钮', () => {
  const s = setup(), p = setupPage(s), d = create(s);
  p.data.conflict = true; p.data.canClear = true;
  p.showRecord(Object.assign(body(), { id: 10, authorId: 1, status: 'approved' }));
  assert.equal(p.data.conflict, false); assert.equal(p.data.canClear, false); assert.equal(p.data.canRevise, true);
  p.localId = d.localId; p.showDraft(d); assert.equal(p.data.canRevise, false); assert.equal(p.data.canClear, false);
});
test('本机已通过稿修订从服务器取原件，不依赖失效页面对象', async () => {
  const s = setup(), p = setupPage(s);
  const record = Object.assign(body(), { id: 10, authorId: 1, status: 'approved', lockVersion: 2 });
  const d = s.drafts.create(p.kind, body(), record); p.localId = d.localId; p.showDraft(d); s.server = record;
  assert.equal(p.data.canRevise, true); assert.equal(p.server, undefined);
  const work = p.revise(); s.modal.success({ confirm: true }); await work;
  assert.ok(s.redirect); assert.equal(s.drafts.list().find(x => x.localId !== d.localId).body.sourceRecordId, 10);
});
test('语音核对弹窗期间换账号或隐藏页面，不能写入旧稿', async () => {
  for (const transition of ['account', 'hide']) {
    const s = setup(), p = setupPage(s), d = create(s); p.localId = d.localId; p.showDraft(d);
    p.recordVoice({ currentTarget: { dataset: { field: 'construction' } } });
    const work = s.onText('新语音');
    if (transition === 'account') s.uid = '2'; else p.onHide();
    s.modal.success({ confirm: true, content: '已核对' }); await work;
    assert.equal(p.data.body.construction, '现场原文');
    if (transition === 'hide') assert.equal(s.voiceCancelled, true);
  }
});
