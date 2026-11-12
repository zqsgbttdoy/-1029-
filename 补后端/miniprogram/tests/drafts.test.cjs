// 运行：node --test 补后端/miniprogram/tests/drafts.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const schema = require('../utils/schema');
const C = require('../utils/inspection-checklist');
const DailySync = require('../utils/daily-inspection-sync');
const source = fs.readFileSync(path.join(__dirname, '../utils/drafts.js'), 'utf8');
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const error = (code, message = '请求失败') => Object.assign(new Error(message), { code });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function revisionOf(record) {
  return { ...copy(record), id: record.id + 100, code: 'REV-' + record.id, sourceRecordId: record.id,
    version: (record.version || 1) + 1, lockVersion: 0, status: 'draft',
    submittedAt: null, submittedBy: null, reviewerId: null, reviewedAt: null, rejectReason: null };
}
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
      if (url === '/field/diary-day-workbench') return copy(state.workbench || { dailyInspections: [] });
      if (url.startsWith('/projects/')) return { id: 2, name: '测试工程' };
      if (url === '/field/summary') return { canReview: true };
      if (url.endsWith('/new-version') && method === 'POST') return copy(state.revision || (state.revision = revisionOf(state.server)));
      if (url.endsWith('/versions')) return copy(state.versions || [state.server]);
      if (url.endsWith('/history')) return copy(state.history || []);
      if (method === 'GET') return copy(state.revision && url.endsWith('/' + state.revision.id) ? state.revision : state.server);
      // 写入后回显客户端请求的状态：巡检以 recorded 表示已保存，不再由服务端改写为草稿
      const requested = !url.endsWith('/submit') && body && body.status;
      state.server = Object.assign({}, body, { id: 10, lockVersion: state.server ? state.server.lockVersion + 1 : 0, status: url.endsWith('/submit') ? 'submitted' : requested || 'draft' });
      return copy(state.server);
    }
  };
  function load() {
    const context = { module: { exports: {} }, require: name => ({ './api': api, './schema': schema, './inspection-checklist': C })[name], wx, getApp: () => ({ globalData: { foreground: state.foreground } }), console };
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
  s.drafts.create(d.kind, updated, { id: 10, status: 'draft', lockVersion: 1 });
  assert.equal(s.drafts.get(d.localId).media[0].description, 'PC补充');
  s.drafts.edit(d.localId, { body: updated }); await s.drafts.sync(d.localId);
  assert.equal(JSON.parse(s.server.photos)[0].description, 'PC补充');
});
test('日记日志冻结本机副本不上传覆盖，版本元数据保留且不混入正文', async () => {
  for (const kind of ['supervision-diaries', 'supervision-logs']) {
    for (const status of ['submitted', 'rejected', 'approved']) {
      const s = setup(), record = { id: 7, status, authorId: 1, lockVersion: 3, version: 2, sourceRecordId: 6, submittedAt: '2026-10-30T08:00:00' };
      const d = s.drafts.create(kind, body(), record);
      s.drafts.edit(d.localId, { body: { ...body(), construction: '旧客户端改写' } });
      await assert.rejects(s.drafts.sync(d.localId), /不可覆盖/);
      assert.equal(s.calls.length, 0); assert.equal(s.drafts.get(d.localId).dirty, true);
      assert.equal(d.recordMeta.version, 2); assert.equal(d.recordMeta.sourceRecordId, 6);
      assert.equal(d.body.version, undefined); assert.equal(d.body.sourceRecordId, undefined);
      assert.equal(schema.canEditStatus(kind, status), false);
      assert.equal(schema.canReviseStatus(kind, status), status !== 'submitted');
    }
  }
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
  const nodes = {}, values = new Map(), state = { calls: [], queries: [], records: [], uploads: [], projects, record, uid: 1 };
  let elementSeq = 0;
  function node(id) {
    return nodes[id] || (nodes[id] = { id, value: '', dataset: {}, style: {}, hidden: false, innerHTML: '', textContent: '', children: [],
      classList: { add() {}, remove() {} }, listeners: {},
      get firstElementChild() { return this.children[0] || node(this.id + ':first-child'); },
      addEventListener(event, fn) { this.listeners[event] = fn; }, insertAdjacentHTML() {}, focus() { state.focus = id; }, scrollIntoView() { state.scrolled = id; },
      appendChild(child) { this.children.push(child); return child; }, querySelectorAll() { return []; }, querySelector() { return null; }, click() {} });
  }
  const root = node('fieldWorkspace'); root.dataset.kind = kind;
  root.querySelector = selector => selector === 'thead th:nth-child(4)' ? node('authorHeading') : selector === '[data-field="projectId"]' ? node('fwF-projectId') : null;
  state.enableControls = () => {
    let html = '', controls = [];
    const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, c => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[c]);
    Object.defineProperty(node('fwForm'), 'innerHTML', { get: () => html, set(value) {
      html = value; controls = [];
      for (const match of value.matchAll(/<(input|textarea|select)\b([^>]*data-field="([^"]+)"[^>]*)>([^<]*)/g)) {
        const tag = match[1], field = match[3], control = node('fwF-' + field);
        control.dataset = { field }; control.listeners = {};
        control.value = tag === 'select' ? '' : decode(tag === 'textarea' ? match[4] : ((match[2].match(/\bvalue="([^"]*)"/) || [])[1] || ''));
        controls.push(control);
      }
    } });
    root.querySelectorAll = selector => selector === '[data-field]' ? controls : selector === '[data-participant-id]:checked' ? (state.participantChecks || []) : [];
    state.input = (field, value) => { const control = node('fwF-' + field); control.value = value; control.listeners.input(); };
  };
  const App = { escape: value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    requireAuth: () => true, initTopbar() {}, getUser: () => ({ userId: state.uid, userName: '当前账号' }),
    getToken: () => 'test', confirm: async (...args) => { state.confirms = (state.confirms || []).concat(args); return state.confirmResult !== false; }, buildQuery: p => new URLSearchParams(p).toString(),
    uploadFile: async file => {
      state.uploads.push(file.name);
      if (state.uploadFailure === file.name) throw new Error('附件上传失败');
      return { url: '/api/uploads/' + encodeURIComponent(file.name), name: file.name, size: 10 };
    },
    apiGetPage: async (path, params = {}) => {
      state.queries.push({ path, params: copy(params) });
      if (path === '/projects') return { list: state.projects, total: state.projects.length };
      if (state.pageFetch) return state.pageFetch(path, params);
      if (state.listError) throw new Error(state.listError);
      const records = state.records.filter(r => !params.status || r.status === params.status);
      const start = ((params.pageNum || 1) - 1) * (params.pageSize || 20);
      return { list: records.slice(start, start + (params.pageSize || 20)), total: records.length };
    },
    apiFetch: async (path, opts) => {
      state.calls.push({ path, opts });
      if (path.startsWith('/field/summary')) {
        if (state.summaryGate) await state.summaryGate.promise;
        if (state.summaryError) throw new Error(state.summaryError);
        return { canReview: true, [kind]: { draft: 0, submitted: 0, approved: 0, rejected: 0 } };
      }
      if (path.startsWith('/field/diary-prefill')) return state.prefill ? state.prefill(path) : copy(state.prefillSource || {});
      if (path.startsWith('/field/diary-source')) return state.source;
      if (path.startsWith('/field/diary-day-workbench')) return copy(state.workbench || { dailyInspections: [] });
      if (path.endsWith('/member-options')) return copy(state.memberOptions || [{ userId: 1, userName: '当前账号', position: '专业监理' }, { userId: 2, userName: '项目同事', position: '监理员' }]);
      if (path.startsWith('/files/access')) return { url: 'signed:file' };
      if (path.endsWith('/new-version') && opts && opts.method === 'POST') return state.revision || (state.revision = revisionOf(state.record));
      if (path.endsWith('/versions')) return copy(state.versions || [state.record]);
      if (path.endsWith('/history')) return copy(state.history || []);
      if (!opts) return state.revision && path.endsWith('/' + state.revision.id) ? state.revision : state.record;
      if (state.writeError) throw state.writeError;
      state.saved = path.endsWith('/submit')
        // 服务端对巡检的提交请求同样返回“已保存”，不进入待审核
        ? Object.assign({}, state.saved, { status: kind === 'daily-inspections' ? 'recorded' : 'submitted', lockVersion: state.saved.lockVersion + 1 })
        // 巡检“保存修改”落库为已保存，服务端不会再把它改回草稿
        : Object.assign({}, opts.body, { id: 10, lockVersion: 1, authorId: 1, authorName: '实际记录人', status: kind === 'daily-inspections' && (opts.body || {}).status === 'recorded' ? 'recorded' : 'draft' });
      return state.saved;
    }
  };
  const context = { App, document: { getElementById: node, body: node('body'), createElement: () => node('generated-' + ++elementSeq) },
    location: { origin: 'https://test.invalid', search }, crypto: require('node:crypto').webcrypto, URLSearchParams,
    sessionStorage: { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: k => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) },
    Blob, URL: { createObjectURL: blob => { state.blob = blob; return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout: () => 0, console, addEventListener(name, fn) { state[name] = fn; }, print() { if (state.onPrint) state.onPrint(); } };
  context.window = context; context.FieldSchema = schema; context.InspectionChecklist = C; context.DailyInspectionSync = DailySync;
  context.DiaryLinks = require('../utils/diary-links');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../assets/inspection-checklist.js'), 'utf8'), context);
  const code = fs.readFileSync(path.join(__dirname, '../../assets/field-records.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'window.testActions = { create, open, show, save, exportRows, prefillLog, closeEditor, load, resumeLocal, syncDailyInspection, getDraft: () => draft };})();');
  vm.runInNewContext(code, context);
  await new Promise(resolve => setImmediate(resolve));
  return Object.assign(state, { nodes, values, actions: context.testActions });
}

// 执行安全日志页面的真实脚本，验证独立版本链和保存目标，不依赖静态示例数据。
function setupSafety() {
  const html = fs.readFileSync(path.join(__dirname, '../../safety-log.html'), 'utf8');
  const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('function mapLog'));
  const nodes = {}, state = { calls: [], uid: 1 };
  let elementSeq = 0;
  function node(id) {
    return nodes[id] || (nodes[id] = { id, value: '', textContent: '', innerHTML: '', style: {}, dataset: {}, children: [],
      classList: { add() {}, remove() {}, toggle() {} }, setAttribute(name, value) { this[name] = value; }, getAttribute(name) { return this[name]; },
      addEventListener() {}, insertAdjacentHTML(where, value) { this.innerHTML += value; }, appendChild(child) { this.children.push(child); return child; },
      insertBefore(child) { this.children.unshift(child); return child; }, querySelector() { return null; }, querySelectorAll() { return []; }, remove() {}, focus() {} });
  }
  const document = { getElementById: node, body: node('body'), createElement: () => node('created-' + ++elementSeq),
    querySelector(selector) {
      if (selector.includes('.photo-item:not') || selector === '#createModal .version-tab.active') return null;
      return node('query:' + selector);
    }, querySelectorAll() { return []; } };
  const context = { document, location: { search: '' }, URLSearchParams, console, setTimeout: () => 0 };
  context.window = context;
  vm.runInNewContext(source + '\n;window.testSafety = { mapLog, loadSafetyVersions, buildViewVersionPanel, openEditModal, saveLog,' +
    ' setRecords(value) { tableData = value; filteredData = value; }, setEditing(value) { editingRecord = value; }, getEditing: () => editingRecord };', context, { filename: 'safety-log.html' });
  const App = { getUser: () => ({ userId: state.uid, userName: '当前账号' }), confirm: async () => true, toast() {}, tableLoading() {},
    escape: value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    apiGetPage: async () => ({ list: [], total: 0 }),
    async apiFetch(path, opts) {
      state.calls.push({ path, opts: copy(opts) });
      if (path.endsWith('/new-version')) return copy(state.revision);
      if (path.endsWith('/versions')) return copy(state.versions);
      if (opts && opts.method === 'PUT') return copy(opts.body);
      return {};
    } };
  context.App = App; context.loadData = () => Promise.resolve();
  return Object.assign(state, { nodes, actions: context.testSafety });
}
function safetyVersions() {
  const first = { id: 1, projectId: 2, logDate: '2026-10-30', authorId: 1, authorName: '记录人', status: 'rejected', version: 1,
    content: 'V1安全正文', photos: '[]', rejectReason: '补充防护记录', submittedBy: '记录人',
    attachments: JSON.stringify([{ url: '/api/uploads/20261030/v1.pdf', name: 'V1附件.pdf', size: '12 KB', time: '10:00' }]) };
  const second = { ...first, id: 2, status: 'draft', version: 2, sourceRecordId: 1, content: 'V2安全正文', attachments: '[]',
    rejectReason: null, submittedBy: null, lockVersion: 0 };
  return [first, second];
}
test('电脑安全日志历史附件可打开，空版本不借用其他版本内容', async () => {
  const s = setupSafety(); s.versions = safetyVersions();
  const d = await s.actions.loadSafetyVersions(2);
  const first = s.actions.buildViewVersionPanel(d, d.versions[0]), second = s.actions.buildViewVersionPanel(d, d.versions[1]);
  assert.ok(first.includes('<a class="vc-attachment-item" href="/api/uploads/20261030/v1.pdf" title="查看附件">'));
  assert.ok(first.includes('V1安全正文')); assert.ok(first.includes('补充防护记录'));
  assert.ok(second.includes('V2安全正文')); assert.ok(second.includes('暂无附件')); assert.ok(!second.includes('v1.pdf'));
});
test('电脑安全日志驳回后打开真实V2并只写新ID，冻结原件不能保存', async () => {
  const s = setupSafety(); s.versions = safetyVersions(); s.revision = s.versions[1];
  s.actions.setRecords([s.actions.mapLog(s.versions[0])]);
  await s.actions.openEditModal(1);
  assert.equal(s.actions.getEditing().id, 2); assert.equal(s.actions.getEditing().status, 'draft');
  assert.equal(s.calls[0].path, '/safety-logs/1/new-version');
  await s.actions.saveLog('pending', '已提交');
  const put = s.calls.find(c => c.opts && c.opts.method === 'PUT');
  assert.equal(put.path, '/safety-logs/2'); assert.equal(put.opts.body.status, 'submitted');
  assert.equal(s.calls.some(c => c.path === '/safety-logs/1' && c.opts && c.opts.method === 'PUT'), false);
  s.calls.length = 0; s.actions.setEditing(s.actions.mapLog(s.versions[0]));
  await s.actions.saveLog('draft', '不应保存');
  assert.match(s.nodes.safetyFormError.textContent, /原版本已冻结/); assert.equal(s.calls.length, 0);
  assert.equal(s.versions[0].content, 'V1安全正文');
});

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
test('电脑端日记项目可在表单内选择，只读详情取服务器原记录并隐藏写按钮', async () => {
  const s = await setupPc('supervision-diaries', '', [{ id: 2, name: '测试工程' }, { id: 3, name: '另一工程' }]);
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
test('监理日记未选工具栏项目也能新建，在表单内选择工程名称后才能保存', async () => {
  const s = await setupPc('supervision-diaries', '', [{ id: 2, name: '测试工程' }, { id: 3, name: '另一工程' }]);
  s.enableControls();
  assert.equal(s.nodes.fwProject.value, '');
  await s.actions.create();
  assert.equal(s.nodes.fwEditor.hidden, false, '未选工具栏项目也应直接打开新建');
  assert.equal(s.nodes.fwError.textContent, '', '新建不应提示先选项目');
  assert.match(s.nodes.fwForm.innerHTML, /id="fwF-projectId"/);
  assert.match(s.nodes.fwForm.innerHTML, /请选择项目名称/);
  assert.equal(s.nodes['fwF-projectId'].value, '');
  assert.equal(s.actions.getDraft().body.projectId, 0, '多项目未选择时不自动猜测归属');
  assert.ok(!s.calls.some(c => c.path.startsWith('/field/summary')), '项目未选不请求统计');
  await assert.rejects(s.actions.save(false), /请选择项目名称/);
  assert.equal(s.nodes['fwF-projectId'].value, '');
  s.input('projectId', '3');
  assert.equal(s.actions.getDraft().body.projectId, 3);
  await s.actions.save(false);
  const write = s.calls.find(c => c.opts && c.opts.method === 'POST' && c.opts.body);
  assert.equal(write.opts.body.projectId, 3);
  assert.equal(s.nodes['fwF-projectId'].disabled, true, '保存成服务器草稿后项目归属锁定');
});
test('监理日志未选工具栏项目仍要求先明确工程名称', async () => {
  const s = await setupPc('supervision-logs', '', [{ id: 2, name: '测试工程' }, { id: 3, name: '另一工程' }]);
  await s.nodes.fwNew.onclick();
  assert.match(s.nodes.fieldError.textContent, /请先在上方选择/);
  assert.equal(s.nodes.fwError.textContent, s.nodes.fieldError.textContent);
  assert.equal(s.actions.getDraft(), null); assert.equal(s.values.size, 0);
});
test('未保存草稿就关闭或取消，列表不留下该条；保存草稿后才生成', async () => {
  const s = await setupPc('daily-inspections'); s.enableControls(); await s.actions.create();
  s.input('content', '关闭前填写');
  await s.nodes.fwClose.onclick();
  assert.equal(s.nodes.fwEditor.hidden, true, '右上角关闭应直接关闭编辑器');
  assert.deepEqual(s.confirms || [], [], '关闭不得弹出任何确认');
  assert.equal(s.calls.filter(c => c.opts && c.opts.method).length, 0, '关闭不得写入服务器草稿');
  assert.equal(s.values.size, 0, '未点保存草稿就关闭，不应留下本机草稿');
  await s.actions.load();
  assert.equal(s.nodes.fwLocalRows.innerHTML, '', '列表不应出现本次未保存的新建');
  await s.nodes.fwNew.onclick(); s.input('content', '取消前填写');
  await s.nodes.fwCancel.onclick();
  assert.equal(s.nodes.fwEditor.hidden, true, '取消应直接关闭编辑器');
  assert.deepEqual(s.confirms || [], [], '取消不得弹出任何确认');
  assert.equal(s.values.size, 0, '取消同样不留下本机草稿');
  await s.nodes.fwNew.onclick(); s.input('content', '确认保存'); await s.nodes.fwSave.onclick();
  assert.ok(s.calls.some(c => c.opts && c.opts.method === 'POST'), '保存草稿按钮仍应按显式操作写入服务器草稿');
});
test('日常巡检未选工具栏项目也能新建，在表单内选择项目后才能保存', async () => {
  const s = await setupPc('daily-inspections', '', [{ id: 2, name: '测试工程' }, { id: 3, name: '另一工程' }]);
  s.enableControls();
  assert.equal(s.nodes.fwProject.value, '');
  await s.actions.create();
  assert.equal(s.nodes.fwEditor.hidden, false, '未选工具栏项目也应直接打开新建');
  assert.equal(s.nodes.fwError.textContent, '', '新建不应提示先选项目');
  assert.match(s.nodes.fwForm.innerHTML, /id="fwF-projectId"/);
  assert.match(s.nodes.fwForm.innerHTML, /请选择项目名称/);
  assert.equal(s.nodes['fwF-projectId'].value, '');
  assert.equal(s.actions.getDraft().body.projectId, 0);
  assert.ok(!s.calls.some(c => c.path.startsWith('/field/summary')), '项目未选不请求统计');
  await assert.rejects(s.actions.save(false), /请选择项目名称/);
  assert.equal(s.nodes['fwF-projectId'].value, '');
  s.input('projectId', '3');
  assert.equal(s.actions.getDraft().body.projectId, 3);
  await s.actions.save(false);
  assert.doesNotMatch(s.nodes.fwForm.innerHTML, /请选择项目名称/);
  const write = s.calls.find(c => c.opts && c.opts.method === 'POST' && c.opts.body);
  assert.equal(write.opts.body.projectId, 3);
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
  const s = await setupPc('supervision-logs', '', [{ id: 2, name: '测试工程' }, { id: 3, name: '另一工程' }]);
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
  assert.doesNotMatch(html, /id="fwGuide"|fd-info|fd-guide-title|填写指引/);
  assert.ok(s.nodes.fieldWorkspace.innerHTML.includes(log.attachmentHint));
  assert.match(s.nodes.fieldWorkspace.innerHTML, /id="fwSubmit"[^>]*>提交</);
  assert.doesNotMatch(s.nodes.fieldWorkspace.innerHTML, /监理类型|明日计划/);
  Object.assign(s.actions.getDraft().body, { construction: '二层脚手架搭设', safetyIssues: '防护缺失已整改', inspection: '验收资料核查', otherMatters: '重要会议' });
  await s.actions.save(true);
  const write = s.calls.find(c => c.opts && c.opts.body);
  assert.equal(write.opts.body.construction, '二层脚手架搭设'); assert.equal(write.opts.body.safetyIssues, '防护缺失已整改');
  assert.equal(write.opts.body.authorName, undefined); assert.equal(write.opts.body.reviewerId, undefined);
  assert.ok(write.opts.headers['Idempotency-Key']);
  assert.ok(s.calls.some(c => c.path.endsWith('/submit') && c.opts.headers['X-Record-Version'] === 1));
  assert.equal(s.actions.getDraft().record.status, 'submitted');
});
test('电脑端监理日志编号后勾选本项目参会人员，保存回显只读导出并隔离其他记录', async () => {
  const s = await setupPc('supervision-logs'); s.enableControls(); await s.actions.create(); await tick();
  const html = s.nodes.fwForm.innerHTML;
  assert.ok(html.indexOf('data-field="code"') < html.indexOf('id="fwF-participants"'), '参会人员紧跟编号');
  assert.match(s.nodes['fwF-participants'].innerHTML, /data-participant-id="1"[\s\S]*当前账号/);
  assert.match(s.nodes['fwF-participants'].innerHTML, /data-participant-id="2"[\s\S]*项目同事/);
  assert.equal(schema.schemas['supervision-logs'].fields.some(f => f[0] === 'participants'), false, '不改变小程序共用字段');
  s.participantChecks = [1, 2].map(id => ({ dataset: { participantId: String(id) } }));
  await s.actions.save(false); assert.equal(s.saved.participants, '[1,2]');
  assert.equal(JSON.parse(s.saved.participants).length, 2);
  s.record = { ...s.saved, id: 10, status: 'approved', participants: '[1,2]' };
  await s.actions.open(10, true); await tick();
  assert.match(s.nodes['fwF-participants'].innerHTML, /当前账号、项目同事/);
  assert.doesNotMatch(s.nodes['fwF-participants'].innerHTML, /data-participant-id=/);
  s.records = [s.record]; await s.actions.exportRows(); const csv = await s.blob.text();
  assert.match(csv, /参会人员/); assert.match(csv, /当前账号、项目同事/);
  const diary = await setupPc('supervision-diaries'); await diary.actions.create();
  assert.doesNotMatch(diary.nodes.fwForm.innerHTML, /fwF-participants|参会人员/);
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
  assert.equal(s.actions.getDraft().record.sourceRecordId, 9);
  assert.equal(s.actions.getDraft().record.version, 2);
  assert.equal(s.actions.getDraft().record.id, 109);
  assert.equal(s.actions.getDraft().body.content, '原工作正文');
  assert.equal(s.calls.filter(c => c.path === '/supervision-logs/9/new-version' && c.opts.method === 'POST').length, 1);
  assert.equal(record.status, 'approved');
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
  assert.doesNotMatch(s.nodes.fwForm.innerHTML, /id="fwGuide"|fd-info|fd-guide-title|填写指引/);
});
test('日志导出含新旧正文、真实人员、附件与来源，公式和引号转义保留', async () => {
  const s = await setupPc('supervision-logs');
  s.records.push({ projectId: 2, logDate: '2020-01-01', authorId: 5, authorName: '原填写人', reviewerName: '实际审核人', reviewerId: 6, status: 'approved', construction: '施工进度', safetyIssues: '=安全问题', inspection: '验收"合格"\n原文', otherMatters: '停工记录', content: '旧综合内容', attachments: '["验收单.pdf"]', diarySources: '[{"id":7}]' });
  await s.actions.exportRows(); const csv = await s.blob.text();
  for (const [, label] of schema.schemas['supervision-logs'].fields) assert.ok(csv.includes(label), label);
  for (const text of ['填写人', '测试工程', '原填写人', '实际审核人', '施工进度', "'=安全问题", '验收""合格""\n原文', '停工记录', '旧综合内容', '验收单.pdf', '引用日记']) assert.ok(csv.includes(text), text);
});
test('日志表单收集及恢复本机草稿保留新旧字段和原日期', async () => {
  const s = await setupPc('supervision-logs'); s.enableControls(); await s.actions.create();
  const body = { logDate: '2020-01-01', construction: '施工部位原文', safetyIssues: '已处理安全问题', inspection: '资料核查完成', content: '旧整编内容' };
  // 关闭不再代提交草稿：本机暂存由输入事件完成，关闭只是关编辑器
  for (const [field, value] of Object.entries(body)) s.input(field, value);
  const localId = s.actions.getDraft().localId;
  const cached = JSON.parse([...s.values.values()][0]);
  for (const [key, value] of Object.entries(body)) assert.equal(cached.body[key], value, key);
  s.nodes.fieldWorkspace.querySelectorAll = () => [];
  s.nodes.fwStatus.value = 'draft'; await s.nodes.fwStatus.onchange();
  await s.nodes.fwLocalRows.onclick({ target: { closest: () => ({ dataset: { local: [...s.values.keys()][0] } }) } });
  assert.equal(s.actions.getDraft().localId, localId);
  for (const [key, value] of Object.entries(body)) assert.equal(s.actions.getDraft().body[key], value, key);
  await s.actions.save(false);
  for (const [key, value] of Object.entries(body)) assert.equal(s.saved[key], value, key);
});
test('四类记录删除恢复按钮，草稿筛选请求服务器并可从行继续编辑', async () => {
  for (const kind of Object.keys(schema.schemas)) {
    const s = await setupPc(kind), date = schema.schemas[kind].date;
    assert.doesNotMatch(s.nodes.fieldWorkspace.innerHTML, /fwResume|恢复本机草稿|fwDraftPanel/);
    assert.match(s.nodes.fieldWorkspace.innerHTML, /value="draft">草稿/);
    s.record = { id: 9, projectId: 2, [date]: '2026-10-29', authorId: 1, status: 'draft', construction: '服务器正文', content: '服务器正文' };
    s.records = [s.record, { ...s.record, id: 10, status: 'submitted' }];
    s.nodes.fwStatus.value = 'draft'; await s.nodes.fwStatus.onchange();
    const query = s.queries.at(-1);
    assert.equal(query.path, '/records/' + kind); assert.equal(query.params.status, 'draft');
    assert.match(s.nodes.fwRows.innerHTML, /fw-chip draft/); assert.match(s.nodes.fwRows.innerHTML, /继续编辑/);
    // 日常巡检无业务版本概念：表头与行均不出现版本列；日记/日志/旁站保留
    if (kind === 'daily-inspections') {
      assert.doesNotMatch(s.nodes.fieldWorkspace.innerHTML, /业务版本/); assert.doesNotMatch(s.nodes.fwRows.innerHTML, /data-label="业务版本"/);
    } else {
      assert.match(s.nodes.fieldWorkspace.innerHTML, /<th>业务版本<\/th>/); assert.match(s.nodes.fwRows.innerHTML, /data-label="业务版本"/);
    }
    assert.doesNotMatch(s.nodes.fwRows.innerHTML, /data-id="10"/);
    await s.nodes.fwRows.onclick({ target: { closest: () => ({ dataset: { id: '9' } }) } });
    assert.match(s.nodes.fwForm.innerHTML, /服务器正文/); assert.equal(s.nodes.fwSave.hidden, false);
    s.nodes.fwStatus.value = kind === 'daily-inspections' ? 'recorded' : 'submitted';
    if (kind === 'daily-inspections') s.records = s.records.concat([{ ...s.record, id: 11, status: 'recorded' }]);
    await s.nodes.fwStatus.onchange();
    if (kind === 'daily-inspections') {
      // 巡检提交即保存：列表显示已保存，本人仍可继续编辑同一条
      assert.match(s.nodes.fwRows.innerHTML, /已保存/); assert.match(s.nodes.fwRows.innerHTML, /data-id="11"/);
    } else {
      assert.match(s.nodes.fwRows.innerHTML, /已提交（待审核）/); assert.doesNotMatch(s.nodes.fwRows.innerHTML, /继续编辑/);
    }
  }
});
test('日常巡检本机草稿行也不含业务版本列', async () => {
  const s = await setupPc('daily-inspections');
  const name = 'field-pc:https://test.invalid:1:daily-inspections';
  s.values.set(name, JSON.stringify({ record: { status: 'draft' }, body: { projectId: 2, inspectionDate: '2020-01-01', content: '离线原文' }, requestId: 'old-request' }));
  s.listError = '模拟断网'; s.nodes.fwStatus.value = 'draft'; await s.nodes.fwStatus.onchange();
  assert.match(s.nodes.fwLocalRows.innerHTML, /继续编辑本机内容/);
  assert.doesNotMatch(s.nodes.fwLocalRows.innerHTML, /业务版本/);
});
test('日常巡检本人草稿与已保存行（recorded 及遗留 submitted/pending）提供删除按钮，他人记录不提供', async () => {
  const s = await setupPc('daily-inspections');
  const base = { projectId: 2, inspectionDate: '2026-10-29', inspectorId: 1, content: '巡检原文' };
  s.records = [
    { ...base, id: 11, status: 'recorded', lockVersion: 4 },
    { ...base, id: 12, status: 'recorded', lockVersion: 2, inspectorId: 9 },
    { ...base, id: 13, status: 'draft', lockVersion: 1 },
    { ...base, id: 14, status: 'submitted', lockVersion: 5 },
    { ...base, id: 15, status: 'pending', lockVersion: 6, inspectorId: 9 }
  ];
  await s.actions.load();
  assert.match(s.nodes.fwRows.innerHTML, /data-del="11"/);
  assert.match(s.nodes.fwRows.innerHTML, /data-del="13"/);
  assert.match(s.nodes.fwRows.innerHTML, /data-del="14"/);
  assert.doesNotMatch(s.nodes.fwRows.innerHTML, /data-del="12"/);
  assert.doesNotMatch(s.nodes.fwRows.innerHTML, /data-del="15"/);
  // 草稿行保留原有编辑入口，删除入口与已保存行一致
  assert.match(s.nodes.fwRows.innerHTML, /data-id="13"[^>]*>继续编辑/);
});
test('日常巡检删除草稿行：确认文案区分草稿，确认后携当前版本 DELETE 并刷新列表', async () => {
  const s = await setupPc('daily-inspections');
  const row = { id: 13, projectId: 2, inspectionDate: '2026-10-29', inspectorId: 1, status: 'draft', lockVersion: 1, content: '本人草稿' };
  s.record = row; s.records = [row];
  s.nodes.fwStatus.value = 'draft'; await s.nodes.fwStatus.onchange();
  s.confirmResult = false;
  await s.nodes.fwRows.onclick({ target: { closest: () => ({ dataset: { del: '13' } }) } });
  assert.equal(s.calls.filter(c => c.opts && c.opts.method === 'DELETE').length, 0);
  assert.match(String(s.confirms.at(-1)), /草稿/, '草稿删除确认文案应与已保存记录区分');
  s.confirmResult = true;
  await s.nodes.fwRows.onclick({ target: { closest: () => ({ dataset: { del: '13' } }) } });
  const del = s.calls.find(c => c.opts && c.opts.method === 'DELETE');
  assert.ok(del, '确认后应发起删除请求');
  assert.equal(del.path, '/daily-inspections/13');
  assert.equal(del.opts.headers['X-Record-Version'], 1, '删除请求应携带当前乐观锁版本');
});
test('日常巡检删除：取消确认不发请求，确认后携当前版本 DELETE 并刷新列表', async () => {
  const s = await setupPc('daily-inspections');
  const row = { id: 11, projectId: 2, inspectionDate: '2026-10-29', inspectorId: 1, status: 'recorded', lockVersion: 4, content: '本人已保存' };
  s.record = row; s.records = [row];
  s.nodes.fwStatus.value = 'recorded'; await s.nodes.fwStatus.onchange();
  s.confirmResult = false;
  await s.nodes.fwRows.onclick({ target: { closest: () => ({ dataset: { del: '11' } }) } });
  assert.equal(s.calls.filter(c => c.opts && c.opts.method === 'DELETE').length, 0);
  assert.match(String(s.confirms.at(-1)), /删除/, '删除前应弹出确认对话框');
  s.confirmResult = true;
  await s.nodes.fwRows.onclick({ target: { closest: () => ({ dataset: { del: '11' } }) } });
  const del = s.calls.find(c => c.opts && c.opts.method === 'DELETE');
  assert.ok(del, '确认后应发起删除请求');
  assert.equal(del.path, '/daily-inspections/11');
  assert.equal(del.opts.headers['X-Record-Version'], 4, '删除请求应携带当前乐观锁版本');
  // 模拟服务器删除成功后刷新：行与按钮一并消失，其他类型不受影响
  s.records = []; await s.actions.load();
  assert.doesNotMatch(s.nodes.fwRows.innerHTML, /data-del=/);
});
test('日常巡检列表删除遇并发冲突展示服务器消息且保留行', async () => {
  const s = await setupPc('daily-inspections');
  const row = { id: 11, projectId: 2, inspectionDate: '2026-10-29', inspectorId: 1, status: 'recorded', lockVersion: 4, content: '本人已保存' };
  s.record = row; s.records = [row];
  await s.actions.load();
  s.writeError = new Error('记录已被其他端修改；本次内容未覆盖，请重新查询后核对');
  await s.nodes.fwRows.onclick({ target: { closest: () => ({ dataset: { del: '11' } }) } });
  assert.match(s.nodes.fwError.textContent, /记录已被其他端修改/);
  assert.equal(s.calls.filter(c => c.opts && c.opts.method === 'DELETE').length, 1);
  // 删除失败后列表不被本地假删：重新查询仍能看到该行
  s.writeError = null; await s.actions.load();
  assert.match(s.nodes.fwRows.innerHTML, /data-del="11"/);
});
test('日常巡检已保存徽标底色归一到 recorded，历史审核类不再显蓝绿红；草稿仍为 draft', async () => {
  const s = await setupPc('daily-inspections');
  const base = { projectId: 2, inspectionDate: '2026-10-29', inspectorId: 1, content: '巡检原文' };
  s.records = [
    { ...base, id: 21, status: 'recorded', lockVersion: 1 },
    { ...base, id: 22, status: 'submitted', lockVersion: 1 },
    { ...base, id: 23, status: 'pending', lockVersion: 1 },
    { ...base, id: 24, status: 'approved', lockVersion: 1 },
    { ...base, id: 25, status: 'rejected', lockVersion: 1 },
    { ...base, id: 26, status: 'draft', lockVersion: 1 }
  ];
  await s.actions.load();
  const html = s.nodes.fwRows.innerHTML;
  // 文案全部“已保存”，且服务器行的 data-status 保留原始状态供诊断
  assert.match(html, /data-status="submitted"[\s\S]*已保存/);
  assert.match(html, /data-status="approved"[\s\S]*已保存/);
  // 所有已保存态的 chip 类归一为 recorded，不再出现旧审核态配色类
  assert.match(html, /fw-chip recorded/);
  for (const legacy of ['submitted', 'pending', 'approved', 'rejected', 'fixed'])
    assert.doesNotMatch(html, new RegExp('fw-chip ' + legacy + '[">]'));
  // 草稿行保持灰色 draft
  assert.match(html, /fw-chip draft">草稿/);
});
test('旁站检查等待审核类型徽标仍按原始状态着色，不受巡检归一影响', async () => {
  const s = await setupPc('sideline-inspections');
  s.records = [
    { projectId: 2, inspectionDate: '2026-10-29', inspectorId: 1, content: '旁站原文', id: 31, status: 'submitted', lockVersion: 1 },
    { projectId: 2, inspectionDate: '2026-10-29', inspectorId: 1, content: '旁站原文', id: 32, status: 'approved', lockVersion: 1 }
  ];
  await s.actions.load();
  assert.match(s.nodes.fwRows.innerHTML, /fw-chip submitted">已提交（待审核）/);
  assert.match(s.nodes.fwRows.innerHTML, /fw-chip approved">审核通过/);
});
test('本机草稿按账号项目日期编号筛选，与服务器分页总数分开且不导出', async () => {
  const s = await setupPc('daily-inspections'); s.enableControls(); await s.actions.create();
  s.input('code', 'LOCAL-ONLY'); s.input('inspectionDate', '2026-10-29'); s.input('content', '本机原文');
  const name = [...s.values.keys()][0], cached = s.values.get(name);
  let warned = false;
  s.beforeunload({ preventDefault() { warned = true; } }); assert.equal(warned, true, '关闭编辑器后仍提醒未同步内容');
  s.values.set(name.replace(':1:', ':2:'), cached);
  s.values.set(name + '-denied', JSON.stringify({ record: {}, body: { projectId: 99, content: '无权项目' } }));
  await s.actions.load();
  assert.match(s.nodes.fwLocalRows.innerHTML, /LOCAL-ONLY/); assert.match(s.nodes.fwLocalRows.innerHTML, /本机未同步/);
  assert.equal((s.nodes.fwLocalRows.innerHTML.match(/data-local=/g) || []).length, 1);
  assert.match(s.nodes.fwPage.textContent, /服务器共 0 条/);
  for (const [id, value] of [['fwProject', '3'], ['fwFrom', '2026-10-30'], ['fwTo', '2026-10-28'], ['fwCode', 'OTHER'], ['fwStatus', 'submitted']]) {
    s.nodes[id].value = value; await s.actions.load(); assert.equal(s.nodes.fwLocalRows.innerHTML, '', id); s.nodes[id].value = '';
  }
  s.records = Array.from({ length: 21 }, (_, i) => ({ id: i + 1, status: 'draft', projectId: 2 }));
  await s.nodes.fwNext.onclick(); assert.equal(s.nodes.fwLocalRows.innerHTML, '');
  s.nodes.fwStatus.value = 'draft'; await s.nodes.fwStatus.onchange();
  assert.equal(s.queries.at(-1).params.pageNum, 1); assert.match(s.nodes.fwLocalRows.innerHTML, /LOCAL-ONLY/);
  await s.actions.exportRows(); assert.doesNotMatch(await s.blob.text(), /LOCAL-ONLY/);
  assert.equal(s.values.get(name), cached);
});
test('断网仍可打开本机内容，旧版存储迁移不丢字段且不自动写服务器', async () => {
  const s = await setupPc('daily-inspections');
  const name = 'field-pc:https://test.invalid:1:daily-inspections';
  s.values.set(name, JSON.stringify({ record: { status: 'draft' }, body: { projectId: 2, inspectionDate: '2020-01-01', content: '离线原文' }, requestId: 'old-request' }));
  s.listError = '模拟断网'; s.nodes.fwStatus.value = 'draft'; await s.nodes.fwStatus.onchange();
  assert.match(s.nodes.fwRows.innerHTML, /加载失败/); assert.match(s.nodes.fwLocalRows.innerHTML, /继续编辑本机内容/);
  await s.actions.resumeLocal(name);
  assert.equal(s.actions.getDraft().body.content, '离线原文'); assert.equal(s.actions.getDraft().requestId, 'old-request');
  assert.equal(s.values.has(name), false); assert.ok([...s.values.keys()].some(k => k.startsWith(name + ':draft:')));
  assert.ok(!s.calls.some(c => c.opts));
});
test('状态连续切换时迟到响应不覆盖新结果', async () => {
  const s = await setupPc('daily-inspections'), gate = deferred();
  s.pageFetch = (path, params) => params.status === 'draft' ? gate.promise : { list: [{ id: 2, status: 'submitted' }], total: 1 };
  s.nodes.fwStatus.value = 'draft'; const old = s.nodes.fwStatus.onchange(); await tick();
  s.nodes.fwStatus.value = 'submitted'; await s.nodes.fwStatus.onchange();
  gate.resolve({ list: [{ id: 1, status: 'draft' }], total: 1 }); await old;
  assert.match(s.nodes.fwRows.innerHTML, /data-id="2"/); assert.doesNotMatch(s.nodes.fwRows.innerHTML, /data-id="1"/);
});
test('服务端校验失败定位错误且保留正文，纠正后保存并从列表回显', async () => {
  const s = await setupPc('daily-inspections'); s.enableControls(); await s.actions.create();
  s.input('content', '需保留的现场正文'); s.writeError = error(400, '检查部位不能为空');
  await s.nodes.fwSave.onclick();
  assert.equal(s.nodes.fwError.textContent, '检查部位不能为空'); assert.equal(s.focus, 'fwError'); assert.equal(s.scrolled, 'fwError');
  assert.equal(s.actions.getDraft().body.content, '需保留的现场正文'); assert.equal(s.actions.getDraft().pending, null);
  s.writeError = null; s.input('location', 'A区'); await s.nodes.fwSave.onclick();
  assert.equal(s.values.size, 0); s.record = s.saved; s.records = [s.saved];
  s.beforeunload({ preventDefault() { assert.fail('服务器保存后不应提示尚未同步'); } });
  await s.nodes.fwCancel.onclick(); s.nodes.fwStatus.value = 'draft'; await s.nodes.fwStatus.onchange();
  await s.actions.open(10); assert.equal(s.nodes['fwF-content'].value, '需保留的现场正文');
  await s.nodes.fwSubmit.onclick();
  // 巡检提交即保存：服务器返回已保存，弹窗关闭回到列表，本人可再次编辑
  assert.equal(s.saved.status, 'recorded'); assert.equal(s.nodes.fwEditor.hidden, true);
});
test('电脑端已保存巡检保存修改后关闭编辑器并留在已保存', async () => {
  const s = await setupPc('daily-inspections'); s.enableControls();
  s.record = { id: 10, projectId: 2, inspectionDate: '2026-10-29', authorId: 1, authorName: '当前账号', status: 'recorded', lockVersion: 3, content: '现场原文' };
  s.records = [s.record];
  await s.actions.open(10);
  assert.equal(s.nodes.fwSave.hidden, true, '已保存巡检不再提供保存草稿');
  assert.equal(s.nodes.fwSubmit.textContent, '保存修改');
  s.input('content', '现场原文及补充');
  await s.nodes.fwSubmit.onclick();
  const put = s.calls.filter(c => c.opts && c.opts.method === 'PUT').at(-1);
  assert.equal(put.opts.body.status, 'recorded', '保存修改按已保存写入，不传草稿态');
  assert.equal(s.calls.some(c => c.opts && String(c.path).endsWith('/submit')), false, '已保存巡检不调用审核提交接口');
  assert.equal(s.nodes.fwEditor.hidden, true, '保存成功后关闭编辑器回到列表');
  assert.match(s.nodes.fwError.textContent, /巡检修改已保存/);
  assert.equal(s.saved.status, 'recorded'); assert.equal(s.values.size, 0, '保存成功后不再保留本机草稿');
  assert.match(s.nodes.fwRows.innerHTML, /data-id="10"/); assert.match(s.nodes.fwRows.innerHTML, /已保存/);
});
test('巡视旁站分组覆盖全部字段一次，短字段成对且必填星号不重复', async () => {
  for (const kind of ['daily-inspections', 'sideline-inspections']) {
    const spec = schema.schemas[kind], s = await setupPc(kind); await s.actions.create();
    assert.deepEqual(spec.pcSections.flatMap(g => g.fields).sort(), spec.fields.map(f => f[0]).sort());
    for (const [field] of spec.fields) assert.equal((s.nodes.fwForm.innerHTML.match(new RegExp('data-field="' + field + '"', 'g')) || []).length, 1);
    assert.match(s.nodes.fwForm.innerHTML, /aria-required="true"/);
    assert.doesNotMatch(s.nodes.fwForm.innerHTML, /\*\s*<span class="fd-req">/);
    assert.doesNotMatch(s.nodes.fwForm.innerHTML, /id="fwGuide"|fd-info|fd-guide-title|填写指引/);
  }
  const s = await setupPc('sideline-inspections'); await s.actions.create();
  assert.match(s.nodes.fwForm.innerHTML, /<input[^>]+data-field="startTime"/);
  assert.match(s.nodes.fwForm.innerHTML, /<textarea[^>]+data-field="result"/);
});
test('旁站起止时间与日期改用确认式选择面板，历史秒值原样回显', async () => {
  const s = await setupPc('sideline-inspections'); await s.actions.create();
  const html = s.nodes.fwForm.innerHTML;
  // 输入框只读：只能点开面板选择，点“确定”才写回并触发本机草稿保存
  for (const field of ['startTime', 'endTime']) {
    const tag = html.match(new RegExp('<input[^>]*data-field="' + field + '"[^>]*>'))[0];
    assert.match(tag, /data-picker="minute"/, field + ' 用分钟档选择面板');
    assert.match(tag, /readonly/, field + ' 只读，避免手输格式错');
    assert.match(tag, /aria-haspopup="dialog"/, field);
  }
  assert.match(html, /data-field="startTime"[^>]*data-picker-before="fwF-endTime"[^>]*data-picker-before-msg="旁站开始时间必须先于结束时间"/);
  assert.match(html, /data-field="endTime"[^>]*data-picker-after="fwF-startTime"[^>]*data-picker-after-msg="旁站结束时间必须晚于开始时间"/);
  assert.match(html, /data-field="inspectionDate"[^>]*data-picker="date"[^>]*readonly/);
  // 日常巡检的巡视时间已合并为单一“巡检时间”，同样要求分钟精度，且不再渲染结束时间
  const daily = await setupPc('daily-inspections'); await daily.actions.create();
  assert.match(daily.nodes.fwForm.innerHTML, /data-field="startTime"[^>]*data-picker="minute"/);
  assert.doesNotMatch(daily.nodes.fwForm.innerHTML, /data-field="endTime"/);
  // 历史值带秒时原样展示，未重新选择则不被取整
  const history = await setupPc('sideline-inspections');
  await history.actions.show({ record: { id: 12, status: 'draft', authorId: 1 },
    body: { projectId: 2, inspectionDate: '2026-10-29', startTime: '2026-10-29T08:30:00', endTime: '2026-10-29T11:30:00' } });
  assert.match(history.nodes.fwForm.innerHTML, /data-field="startTime"[^>]*value="2026-10-29 08:30:00"/);
  assert.match(history.nodes.fwForm.innerHTML, /data-field="endTime"[^>]*value="2026-10-29 11:30:00"/);
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
  const field = { value: '施工进度与安全问题原文', hidden: false, tagName: 'TEXTAREA', closest() { return null; }, after(node) { this.printed = node.textContent; } };
  s.nodes.fwForm.querySelectorAll = selector => selector.startsWith('details') ? [details] : [field];
  s.onPrint = () => { assert.equal(details.open, true); assert.equal(field.hidden, true); assert.equal(field.printed, field.value); };
  await s.nodes.fwPrint.onclick();
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
  s.record = { id: 7, projectId: 2, logDate: '2020-01-01', status: 'draft', authorId: 1, lockVersion: 3,
    construction: '领导手写施工', content: '旧整编正文', attachments: '[{"url":"old.pdf"}]', diarySources: '[{"id":8}]' };
  s.prefillSource = { construction: '不覆盖', inspection: '日记巡视', safetyIssues: '日记新问题' };
  await s.actions.open(7); await tick();
  const d = s.actions.getDraft();
  assert.match(prefillCalls(s)[0].path, /date=2020-01-01/);
  assert.equal(d.body.construction, '领导手写施工'); assert.equal(d.body.inspection, '日记巡视');
  assert.equal(d.body.content, '旧整编正文'); assert.equal(d.body.diarySources, '[{"id":8}]');
  assert.deepEqual(JSON.parse(d.body.attachments), [{ url: 'old.pdf' }]); assert.equal(d.record.lockVersion, 3);
});
test('电脑端驳回原件只读、不预填、不写原ID，修订打开真实V2并回看V1', async () => {
  for (const kind of ['supervision-diaries', 'supervision-logs']) {
    const s = await setupPc(kind);
    s.record = { ...body(), id: 7, logDate: '2026-09-23', authorId: 1, status: 'rejected', version: 1, lockVersion: 3,
      rejectReason: '补充现场位置', submittedAt: '2026-10-30T08:00:00', photos: '[{"url":"/api/uploads/v1.jpg","name":"V1照片"}]',
      ...(kind === 'supervision-diaries' ? { relatedAttachmentIds: '[]' } : {}) };
    const before = copy(s.record);
    await s.actions.open(7); await tick();
    for (const id of ['fwSave', 'fwSubmit', 'fwDelete', 'fwUploadField', 'fwFork']) assert.equal(s.nodes[id].hidden, true, id);
    assert.equal(s.nodes.fwRevise.hidden, false); assert.equal(prefillCalls(s).length, 0);
    await assert.rejects(s.actions.save(false), /冻结/);
    assert.equal(s.calls.some(c => c.opts && c.opts.method === 'PUT'), false);
    await s.nodes.fwRevise.onclick();
    assert.equal(s.actions.getDraft().record.id, 107); assert.equal(s.actions.getDraft().record.version, 2);
    assert.equal(s.actions.getDraft().record.sourceRecordId, 7); assert.equal(s.nodes.fwSave.hidden, false);
    s.versions = [s.record, s.revision]; await s.nodes.fwHistory.onclick();
    assert.match(s.nodes.fwHistoryContent.innerHTML, /V1/); assert.match(s.nodes.fwHistoryContent.innerHTML, /V2/);
    assert.match(s.nodes.fwHistoryContent.innerHTML, /补充现场位置/); assert.match(s.nodes.fwHistoryContent.innerHTML, /V1照片/);
    assert.deepEqual(s.record, before);
  }
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
  s.input('construction', '离线手写');
  // 关闭会丢弃未保存的暂存，故直接在编辑器内恢复本机草稿验证补空白
  const localName = [...s.values.keys()][0];
  s.prefill = null; s.prefillSource = { construction: '不覆盖', safetyIssues: '日记问题' };
  await s.actions.resumeLocal(localName); await tick();
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
  s.wx.navigateTo = options => { s.navigation = options.url; };
  s.wx.setNavigationBarTitle = () => {}; s.wx.showToast = options => { s.toast = options.title; };
  const editorContext = { module: { exports: {} }, wx: s.wx, require: name => ({ './inspection-checklist': C, './api': s.api, './drafts': s.drafts })[name] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/inspection-editor.js'), 'utf8'), editorContext);
  vm.runInNewContext(pageSource, { Page: value => { page = value; }, wx: s.wx,
    setTimeout: fn => { s.timeouts = (s.timeouts || []).concat(fn); return 1; },
    getCurrentPages: () => s.pageStack || [{}, {}],
    require: name => ({ '../../utils/api': s.api, '../../utils/drafts': s.drafts, '../../utils/voice': voice, '../../utils/schema': schema,
      '../../utils/inspection-checklist': C, '../../utils/inspection-editor': editorContext.module.exports,
      '../../utils/diary-links': require('../utils/diary-links'), '../../utils/daily-inspection-sync': DailySync })[name] });
  page.data = copy(page.data); page.uid = s.uid; page.kind = 'supervision-diaries'; page.visible = true;
  page.setData = values => Object.assign(page.data, copy(values));
  return page;
}
const diaryLink = require('../utils/diary-links').format({ sourceType: 'project-documents', sourceId: 5, file: '/api/uploads/a.jpg', name: '中文(复核).jpg' });
test('电脑端链接正文CSV保留文件名稳定地址及公式防护，不导出临时凭据', async () => {
  const s = await setupPc();
  s.records.push({ projectId: 2, construction: '=公式' + diaryLink, status: 'draft', authorName: '实际填写人' });
  await s.actions.exportRows();
  const csv = await s.blob.text();
  assert.ok(csv.includes("'=公式"));
  assert.ok(csv.includes('中文(复核).jpg（file-reference.html?sourceType=project-documents&sourceId=5&file=%2Fapi%2Fuploads%2Fa.jpg）'));
  assert.doesNotMatch(csv, /ticket=|token=|signature=/);
});
test('带链接正文离线重启、pending重放与后续移除均保留最终正文', async () => {
  const s = setup(), request = s.api.request;
  const d = s.drafts.create('supervision-diaries', Object.assign(body(), { construction: '前' + diaryLink + diaryLink + '后' }));
  s.reload(); assert.equal(s.drafts.get(d.localId).body.construction, '前' + diaryLink + diaryLink + '后');
  let lost = true; s.api.request = async (...args) => { const result = await request(...args); if (lost) { lost = false; throw error(undefined, '响应丢失'); } return result; };
  await assert.rejects(s.drafts.sync(d.localId)); const pending = copy(s.drafts.get(d.localId).pending);
  s.drafts.edit(d.localId, { body: Object.assign(body(), { construction: '前' + diaryLink + '后' }) });
  await s.drafts.sync(d.localId); assert.deepEqual(s.calls[1].body, pending.body);
  assert.equal(s.drafts.get(d.localId).body.construction, '前' + diaryLink + '后');
  await s.drafts.sync(d.localId); assert.equal(s.calls[2].body.construction, '前' + diaryLink + '后');
});
test('小程序反查只读本人服务器草稿不创建本机副本、不暴露写动作', async () => {
  const s = setup(), p = setupPage(s); s.server = Object.assign(body(), { id: 8, authorId: 1, status: 'draft', construction: diaryLink });
  await p.onLoad({ kind: 'supervision-diaries', id: 8, readonly: 'true' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.drafts.list().length, 0); assert.equal(p.data.editable, false); assert.equal(p.data.canReview, false); assert.equal(p.data.canRevise, false);
  assert.equal(p.data.fields.filter(f => f.link).length, 9);
  await p.review({}); await p.revise(); await p.fork(); assert.equal(s.modal, undefined); assert.equal(p.persist(), false);
  assert.equal(p.data.body.construction, diaryLink);
});
test('小程序保存前收集正在编辑的链接正文，语音仅追加不覆盖', async () => {
  const s = setup(), p = setupPage(s), d = create(s); p.localId = d.localId; p.showDraft(d);
  let collected = 0; p.selectAllComponents = () => [{ dataset: { field: 'construction' }, guard() {}, collect() { collected++; return '现场' + diaryLink; } }];
  await p.action({ currentTarget: { dataset: { action: 'save' } } }); assert.equal(s.calls[0].body.construction, '现场' + diaryLink);
  p.recordVoice({ currentTarget: { dataset: { field: 'construction' } } }); const work = s.onText('语音追加');
  s.modal.success({ confirm: true, content: '核对追加' }); await work;
  assert.equal(p.data.body.construction, '现场' + diaryLink + '核对追加'); assert.ok(collected >= 3);
});
test('小程序链接正文超长保存被拒绝，输入不截断且不写服务器', async () => {
  const s = setup(), p = setupPage(s), d = create(s); p.localId = d.localId; p.showDraft(d);
  const text = '中'.repeat(60001) + diaryLink; p.input({ currentTarget: { dataset: { field: 'construction' } }, detail: { value: text } });
  p.selectAllComponents = () => [{ guard() { throw new Error('单个正文栏目不能超过 60000 字符'); } }];
  await p.action({ currentTarget: { dataset: { action: 'save' } } }); assert.equal(s.calls.length, 0); assert.equal(p.data.body.construction, text); assert.match(p.data.error, /60000/);
});
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
  p.kind = 'daily-inspections';
  assert.deepEqual(copy(p.fields({}).filter(f => f.short).map(f => f.key)), ['startTime', 'workerCount', 'manageCount']);
  assert.equal(p.fields({}).filter(f => f.time).length, 1); assert.equal(p.fields({}).filter(f => f.number).length, 2);
});
test('小程序旁站时间改用日期时间选择器，写入秒位且只读时拒绝修改', () => {
  const s = setup(), p = setupPage(s); p.kind = 'sideline-inspections';
  const d = s.drafts.create(p.kind, { projectId: 2, inspectionDate: '2026-10-29' }, { id: 10, status: 'draft', authorId: 1, lockVersion: 1 });
  p.localId = d.localId; p.showDraft(d);
  assert.deepEqual(p.fields(p.data.body).filter(f => f.time).map(f => f.key), ['startTime', 'endTime']);
  assert.equal(p.fields(p.data.body).find(f => f.key === 'startTime').hint, schema.schemas[p.kind].hints.startTime);
  p.inspectionTime({ currentTarget: { dataset: { field: 'startTime', part: 'time' } }, detail: { value: '08:30' } });
  assert.equal(p.data.body.startTime, '2026-10-29T08:30:00');
  p.inspectionTime({ currentTarget: { dataset: { field: 'endTime', part: 'time' } }, detail: { value: '11:30' } });
  assert.equal(p.data.body.endTime, '2026-10-29T11:30:00');
  p.inspectionTime({ currentTarget: { dataset: { field: 'startTime', part: 'date' } }, detail: { value: '2026-10-28' } });
  assert.equal(p.data.body.startTime, '2026-10-28T08:30:00');
  p.inspectionTime({ currentTarget: { dataset: { field: 'startTime', part: 'clear' } }, detail: {} });
  assert.equal(p.data.body.startTime, ''); assert.equal(s.drafts.get(d.localId).body.startTime, '');
  p.data.editable = false;
  p.inspectionTime({ currentTarget: { dataset: { field: 'endTime', part: 'time' } }, detail: { value: '12:00' } });
  assert.equal(p.data.body.endTime, '2026-10-29T11:30:00');
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
  assert.equal(s.redirect, '/pages/record/index?kind=supervision-diaries&id=110');
  assert.equal(s.drafts.list().length, 1);
  assert.equal(s.revision.sourceRecordId, 10); assert.equal(s.revision.version, 2);
  assert.equal(s.revision.construction, record.construction);
  assert.equal(s.server.status, 'approved');
  assert.equal(s.calls.filter(c => c.url === '/supervision-diaries/10/new-version' && c.method === 'POST').length, 1);
});
test('小程序驳回修订请求真实V2，历史卡跳转只读且原稿保留', async () => {
  for (const kind of ['supervision-diaries', 'supervision-logs']) {
    const s = setup(), p = setupPage(s); p.kind = kind;
    s.server = { ...body(), id: 15, authorId: 1, logDate: '2026-09-23', status: 'rejected', version: 1, rejectReason: '原驳回原因' };
    const before = copy(s.server); p.showRecord(s.server);
    assert.equal(p.data.editable, false); assert.equal(p.data.canRevise, true);
    const work = p.revise(); s.modal.success({ confirm: true }); await work;
    assert.equal(s.redirect, '/pages/record/index?kind=' + kind + '&id=115');
    assert.equal(s.revision.sourceRecordId, 15); assert.equal(s.revision.version, 2);
    assert.equal(s.calls.some(c => c.method === 'PUT'), false); assert.deepEqual(s.server, before);
    p.showRecord(s.revision); s.versions = [s.server, s.revision]; await p.history();
    assert.equal(p.data.versions.length, 2); assert.equal(p.data.versions[0].rejectReason, '原驳回原因');
    p.openVersion({ currentTarget: { dataset: { id: 15 } } });
    assert.equal(s.navigation, '/pages/record/index?kind=' + kind + '&id=15&readonly=true');
    p.readonly = true; p.showRecord(s.server); assert.equal(p.data.canRevise, false);
  }
});
const dailyBody = () => ({ projectId: 2, inspectionDate: '2026-10-29', location: '三层临边', content: '巡视原文', issues: '历史补充原文', photos: '[]', attachments: '[]' });
function checklistData(problem = true) {
  const item = C.newItem(); item.content = '临边防护'; item.result = 'noncompliant';
  if (problem) item.problems.push(C.newProblem(item));
  return { version: 1, items: [item] };
}
const editEvent = (id, field, value) => ({ currentTarget: { dataset: { id, field } }, detail: { value } });
function setupDailyPage() {
  const s = setup(), p = setupPage(s); p.kind = 'daily-inspections';
  const d = s.drafts.create(p.kind, dailyBody()); p.localId = d.localId; p.showDraft(d);
  return { s, p, d };
}
test('巡视模型空态、默认值、提交校验及结果切换保留问题', () => {
  assert.equal(C.summary(null), '未录入检查项'); assert.deepEqual(C.parse(''), C.empty());
  const data = { version: 1, items: [C.newItem()] };
  assert.deepEqual(Object.keys(data.items[0]).sort(), ['content', 'id', 'photos', 'problems', 'result']);
  assert.equal(data.items[0].result, 'unchecked');
  assert.equal(C.stats(data).problems, 0); assert.doesNotThrow(() => C.validate(data, false));
  assert.throws(() => C.validate(data, true), /检查内容/); data.items[0].content = '检查安全网';
  assert.throws(() => C.validate(data, true), /检查结果/); data.items[0].result = 'compliant';
  assert.doesNotThrow(() => C.validate(data, true));
  data.items[0].problems.push(C.newProblem(data.items[0]));
  assert.equal(C.stats(data).problems, 1); assert.equal(C.stats(data).compliant, 1);
  assert.throws(() => C.parse('{broken'), /原始草稿/); assert.throws(() => C.parse('{"version":2,"items":[]}'), /版本/);
  assert.throws(() => C.parse(' '.repeat(60000) + '{"version":1,"items":[]}'), /60000/);
  data.items.push(C.clone(data.items[0])); assert.throws(() => C.stringify(data), /重复/);
});
test('巡视模型数量、枚举、文本及附件安全整数边界', () => {
  const data = { version: 1, items: Array.from({ length: 100 }, () => C.newItem()) };
  data.items.slice(0, 10).forEach(i => { i.problems = Array.from({ length: 20 }, () => C.newProblem(i)); });
  assert.equal(C.stats(data).problems, 200); data.items.push(C.newItem()); assert.throws(() => C.stringify(data), /100/); data.items.pop();
  data.items[10].problems.push(C.newProblem(data.items[10])); assert.throws(() => C.stringify(data), /200/);
  const one = checklistData(), p = one.items[0].problems[0];
  p.attachments = Array.from({ length: 50 }, (_, n) => ({ url: '/api/uploads/' + n + '.jpg', name: '照片', size: 1 }));
  assert.doesNotThrow(() => C.stringify(one)); p.attachments.push({ url: '/api/uploads/51.jpg' }); assert.throws(() => C.stringify(one), /50/); p.attachments.pop();
  p.attachments[0].size = Number.MAX_SAFE_INTEGER + 1; assert.throws(() => C.stringify(one), /附件/); p.attachments = [];
  p.type = '未知'; assert.throws(() => C.stringify(one), /类型/); p.type = C.types[0];
  one.items[0].content = null; assert.throws(() => C.stringify(one), /文本/);
  one.items[0].content = '字'.repeat(10001); assert.throws(() => C.stringify(one), /10000/);
  one.items[0].content = '字'.repeat(10000); p.name = '字'.repeat(10000); p.description = '字'.repeat(10000);
  for (let n = 0; n < 4; n++) { const extra = C.newItem(); extra.content = '字'.repeat(10000); one.items.push(extra); }
  assert.throws(() => C.stringify(one), /60000/);
});
test('巡视时间人数兼容空值、真实日期及单一时间校验', () => {
  assert.deepEqual(C.pack({ workerCount: '', manageCount: 0, startTime: '' }, false), { workerCount: null, manageCount: 0, startTime: null });
  const b = { startTime: '2026-10-29T08:30', endTime: '2026-10-29 09:30', workerCount: '12' };
  assert.equal(C.pack(b, true).startTime, '2026-10-29T08:30:00'); assert.equal(C.pack(b, true).workerCount, 12);
  for (const value of ['-1', '1.5', '2147483648', 'abc']) assert.throws(() => C.pack({ workerCount: value }), /非负整数/);
  for (const value of ['2026-02-30T10:00', '2026-10-29T25:00', 'bad']) assert.throws(() => C.pack({ startTime: value }));
  // 巡检时间已合并：只填巡检时间即可提交，历史草稿的结束时间不再发送
  assert.doesNotThrow(() => C.pack({ startTime: b.startTime }, false)); assert.doesNotThrow(() => C.pack({ startTime: b.startTime }, true));
  assert.equal('endTime' in C.pack(b, true), false);
  assert.doesNotThrow(() => C.pack({ startTime: b.startTime, endTime: b.startTime }));
});
test('巡视模型检查项照片结构、上限与打印文案', () => {
  const id = 'ci-photo-1', data = { version: 1, items: [Object.assign(C.newItem(), { id, content: '临边防护', result: 'compliant',
    photos: [{ url: '/api/uploads/1.jpg', name: '现场1.jpg', size: 10 }] })] };
  assert.deepEqual(C.parse(C.stringify(data)).items[0].photos.map(f => f.name), ['现场1.jpg']);
  assert.match(C.format(C.stringify(data)), /照片：现场1.jpg/);
  // 同步上传后把本机照片并回清单，不重复也不丢失已有凭证
  const merged = C.parse(C.withMedia(C.stringify(data), [{ id: 'media-2', url: '/api/uploads/2.jpg', name: '本机照片', itemId: id }]));
  assert.deepEqual(merged.items[0].photos.map(f => f.name), ['现场1.jpg', '本机照片']);
  data.items[0].photos = Array.from({ length: 11 }, (_, n) => ({ url: '/api/uploads/' + n + '.jpg', name: 'p' + n + '.jpg' }));
  assert.throws(() => C.stringify(data), /最多 10 张/);
  data.items[0].photos = [{ name: '缺地址.jpg' }];
  assert.throws(() => C.stringify(data), /检查项照片尚未上传或格式无效/);
  // 旧记录没有 photos 字段时按空处理，不影响读取与提交
  const legacy = { version: 1, items: [{ id: 'ci-legacy', content: '旧项', result: 'unchecked', problems: [] }] };
  assert.equal(C.parse(JSON.stringify(legacy)).items[0].photos, undefined);
  assert.doesNotThrow(() => C.pack({ checklist: JSON.stringify(legacy) }, false));
});
test('巡视发现人回写只合并元数据，重试比较全部可写内容', () => {
  const local = checklistData(), remote = C.clone(local), p = remote.items[0].problems[0]; p.foundById = 1; p.foundByName = '服务端发现人';
  assert.equal(C.sameBody('daily-inspections', { checklist: C.stringify(remote) }, { checklist: C.stringify(local) }), true);
  local.items[0].problems[0].description = '后续本机修改'; local.items[0].id = 'changed-item-id';
  const merged = C.parse(C.mergeFoundBy(local, remote)); assert.equal(merged.items[0].problems[0].description, '后续本机修改'); assert.equal(merged.items[0].problems[0].foundByName, '服务端发现人');
  assert.equal(C.sameBody('daily-inspections', { checklist: C.stringify(remote) }, { checklist: C.stringify(local) }), false);
});
test('小程序点击问题直接展开并聚焦，已有问题不重复新增', async () => {
  const { s, p, d } = setupDailyPage(), data = checklistData(false), id = data.items[0].id;
  p.applyChecklist(data); p.openProblems(editEvent(id));
  assert.equal(p.data.problemPanel.problems.length, 1); assert.equal(C.stats(p.data.body.checklist).problems, 0);
  const pid = p.problemEdit.problems[0].id;
  assert.equal(p.data.problemPanel.focusId, pid); assert.equal(s.drafts.get(d.localId).problemEdit.focusId, undefined, '一次性聚焦状态不写入草稿');
  p.problemInput(editEvent(pid, 'description', '临边防护缺失'));
  assert.equal(p.data.problemPanel.focusId, '', '后续输入不反复抢焦点');
  p.confirmProblems(); assert.equal(C.stats(p.data.body.checklist).problems, 1);
  p.openProblems(editEvent(id)); assert.equal(p.data.problemPanel.problems.length, 1); assert.equal(p.data.problemPanel.focusId, pid);
  const read = setupDailyPage().p, readData = checklistData(false); read.applyChecklist(readData); read.data.editable = false; read.openProblems(editEvent(readData.items[0].id));
  assert.equal(read.data.problemPanel.problems.length, 0, '只读查看不自动新增');
});
test('小程序问题点开即给出说明输入，副本恢复，确认与取消不混入父稿', async () => {
  const { s, p, d } = setupDailyPage(); p.addCheckItem(); const id = p.data.checkItems[0].id;
  p.checkInput(editEvent(id, 'content', '临边防护')); p.openProblems(editEvent(id));
  assert.equal(p.data.problemPanel.problems.length, 1, '点开即给出问题说明输入框'); assert.equal(C.stats(p.data.body.checklist).problems, 0);
  const pid = p.problemEdit.problems[0].id; p.problemInput(editEvent(pid, 'description', '仅副本说明'));
  await assert.rejects(s.drafts.sync(d.localId), /确认或取消/);
  s.reload(); const restored = setupPage(s); restored.kind = p.kind; restored.localId = d.localId; restored.showDraft(s.drafts.get(d.localId));
  assert.equal(restored.problemEdit.problems[0].description, '仅副本说明'); assert.equal(C.stats(restored.data.body.checklist).problems, 0);
  let cancel = restored.cancelProblems(); s.modal.success({ confirm: true }); await cancel;
  assert.equal(C.stats(restored.data.body.checklist).problems, 0);
  restored.openProblems(editEvent(id)); assert.equal(restored.problemEdit.problems.length, 1);
  restored.addProblem(); assert.equal(restored.problemEdit.problems.length, 2); restored.confirmProblems();
  assert.equal(restored.problemEdit, null); assert.equal(C.stats(restored.data.body.checklist).problems, 2);
  assert.equal(s.drafts.get(d.localId).problemEdit, null);
  restored.checkInput(editEvent(id, 'result', 'compliant')); assert.equal(C.stats(restored.data.body.checklist).problems, 2);
  assert.equal(restored.data.body.issues, '历史补充原文');
});
test('小程序检查内容与勾选状态，批量删除显示准确问题数量', async () => {
  const { s, p } = setupDailyPage(); const data = checklistData(); p.applyChecklist(data); const id = data.items[0].id;
  p.selectCheckItems({ detail: { value: [id] } }); p.checkInput(editEvent(id, 'content', '临边防护复核'));
  assert.equal(p.data.checkItems[0].selected, true);
  assert.equal(C.parse(p.data.body.checklist).items[0].content, '临边防护复核');
  let work = p.deleteCheckItems(editEvent()); assert.match(s.modal.content, /1 个问题/); s.modal.success({ confirm: false }); await work;
  assert.equal(C.stats(p.data.body.checklist).total, 1);
  work = p.deleteCheckItems(editEvent()); s.modal.success({ confirm: true }); await work; assert.equal(C.stats(p.data.body.checklist).total, 0);
});
test('小程序问题暂存与确认失败可取消重试，不掩盖父正文存储失败', async () => {
  for (const mode of ['panel', 'confirm', 'parent']) {
    const { s, p, d } = setupDailyPage(); p.applyChecklist(checklistData()); const id = p.data.checkItems[0].id;
    if (mode === 'parent') { s.quota = true; pageInput(p, 'content', '未落盘父正文'); s.quota = false; }
    p.openProblems(editEvent(id)); s.quota = true;
    if (mode === 'confirm') p.confirmProblems(); else { p.addProblem(); assert.match(p.data.panelError, /存储/); }
    s.quota = false; const dirty = p.problemEdit.dirty, cancel = p.cancelProblems(); if (dirty) s.modal.success({ confirm: true }); await cancel;
    if (mode === 'parent') { await assert.rejects(s.drafts.sync(d.localId), /未保存修改/); assert.equal(p.persist(), true); }
    await s.drafts.sync(d.localId); assert.equal(s.drafts.get(d.localId).state, '已同步草稿');
  }
});
test('小程序问题面板下线图片上传，历史附件只读展示且确认不丢本机媒体', async () => {
  const { s, p, d } = setupDailyPage(); const data = checklistData();
  data.items[0].problems[0].attachments.push({ url: '/api/uploads/old.jpg', name: '历史问题照片.jpg' });
  p.applyChecklist(data);
  s.wx.chooseMedia = options => options.success({ tempFiles: [{ tempFilePath: '/temp/a.jpg' }] });
  s.wx.compressImage = options => options.success({ tempFilePath: '/temp/compressed.jpg' });
  await p.chooseCheckPhoto({ currentTarget: { dataset: { id: p.data.checkItems[0].id, source: 'camera' } } });
  assert.equal(s.drafts.get(d.localId).media.length, 1, '检查项照片仍正常入本机');
  p.openProblems(editEvent(p.data.checkItems[0].id));
  assert.equal(typeof p.chooseProblemPhoto, 'undefined', '问题拍照方法已下线');
  assert.equal(typeof p.removeProblemFile, 'undefined', '问题附件移除方法已下线');
  assert.equal(p.problemEdit.media, undefined, '问题面板不再管理本机媒体');
  const panel = p.data.problemPanel.problems[0];
  assert.equal(panel.localMedia, undefined, '不再渲染问题本机媒体');
  assert.deepEqual(panel.files.map(f => f.name), ['历史问题照片.jpg'], '历史附件仍只读展示');
  p.confirmProblems();
  assert.equal(s.drafts.get(d.localId).media.length, 1, '确认问题保留检查项本机照片');
  assert.equal(C.parse(s.drafts.get(d.localId).body.checklist).items[0].problems[0].attachments.length, 1, '历史问题附件不丢失');
});
test('小程序历史问题照片媒体随同步回写附件，不混入整单照片', async () => {
  const s = setup(), data = checklistData();
  const d = s.drafts.create('daily-inspections', { ...dailyBody(), checklist: C.stringify(data) });
  s.drafts.edit(d.localId, { media: [{ id: 'm1', path: '/persistent/a.jpg', url: '/api/uploads/a.jpg', name: '历史问题照片.jpg', itemId: data.items[0].id, problemId: data.items[0].problems[0].id }] });
  await s.drafts.sync(d.localId);
  assert.equal(s.uploads.length, 0, '已上传的历史问题照片不再重复上传');
  assert.equal(C.parse(s.server.checklist).items[0].problems[0].attachments.some(f => f.url === '/api/uploads/a.jpg'), true, '历史问题照片回写附件');
  assert.deepEqual(JSON.parse(s.server.photos || '[]'), [], '问题照片不混入整单照片');
});
test('小程序检查项照片入本机并随同步写入清单，不混入整单照片', async () => {
  const { s, p, d } = setupDailyPage(); p.applyChecklist(checklistData());
  const id = p.data.checkItems[0].id;
  s.wx.chooseMedia = options => options.success({ tempFiles: [{ tempFilePath: '/temp/a.jpg' }] });
  s.wx.compressImage = options => options.success({ tempFilePath: '/temp/compressed.jpg' });
  await p.chooseCheckPhoto({ currentTarget: { dataset: { id, source: 'camera' } } });
  const media = s.drafts.get(d.localId).media;
  assert.equal(media.length, 1); assert.equal(media[0].itemId, id); assert.equal(media[0].problemId, undefined); assert.equal(media[0].source, 'camera');
  assert.equal(p.data.checkItems[0].localMedia.length, 1);
  assert.equal(p.data.checkItems[0].photos.length, 0, '未上传前不写入清单照片');
  await s.drafts.sync(d.localId);
  assert.equal(s.uploads.length, 1, '检查项照片进入上传队列');
  assert.deepEqual(C.parse(s.server.checklist).items[0].photos.map(f => f.url), ['/api/uploads/a.jpg']);
  assert.deepEqual(JSON.parse(s.server.photos || '[]'), [], '检查项照片不进入整单照片');
  assert.equal(s.server.checklist.includes('/persistent'), false, '清单只保存远端地址');
});
test('小程序本机与远端检查项照片均可按项移除，只读时拒绝新增', async () => {
  const { s, p, d } = setupDailyPage(); p.applyChecklist(checklistData());
  s.wx.chooseMedia = options => options.success({ tempFiles: [{ tempFilePath: '/temp/a.jpg' }] });
  s.wx.compressImage = options => options.success({ tempFilePath: '/temp/compressed.jpg' });
  await p.chooseCheckPhoto({ currentTarget: { dataset: { id: p.data.checkItems[0].id, source: 'album' } } });
  const local = s.drafts.get(d.localId).media[0];
  p.removeCheckPhoto({ currentTarget: { dataset: { id: p.data.checkItems[0].id, media: local.id } } });
  assert.equal(s.drafts.get(d.localId).media.length, 0); assert.equal(p.data.checkItems[0].localMedia.length, 0);
  const data = checklistData(); data.items[0].photos.push({ url: '/api/uploads/old.jpg', name: '旧凭证.jpg' });
  p.applyChecklist(data);
  assert.equal(C.parse(p.data.body.checklist).items[0].photos.length, 1);
  p.removeCheckPhoto({ currentTarget: { dataset: { id: data.items[0].id, url: '/api/uploads/old.jpg' } } });
  assert.equal(C.parse(p.data.body.checklist).items[0].photos.length, 0);
  p.data.editable = false; let chosen = 0; s.wx.chooseMedia = () => { chosen++; };
  await p.chooseCheckPhoto({ currentTarget: { dataset: { id: data.items[0].id, source: 'camera' } } });
  assert.equal(chosen, 0, '只读时不再打开选图');
});
test('小程序问题删除后迟到上传不能恢复附件引用', async () => {
  const s = setup(), data = checklistData(), gate = deferred(), entered = deferred();
  const d = s.drafts.create('daily-inspections', { ...dailyBody(), checklist: C.stringify(data) });
  s.drafts.edit(d.localId, { media: [{ id: 'media1', path: '/persistent/a.jpg', itemId: data.items[0].id, problemId: data.items[0].problems[0].id }] });
  s.api.upload = async () => { entered.resolve(); return gate.promise; }; const work = s.drafts.sync(d.localId); await entered.promise;
  data.items[0].problems = []; s.drafts.edit(d.localId, { body: { ...dailyBody(), checklist: C.stringify(data) }, media: [] });
  gate.resolve({ url: '/api/uploads/late.jpg', name: '迟到照片' }); await work;
  assert.equal(C.stats(s.server.checklist).problems, 0); assert.equal(s.server.checklist.includes('late.jpg'), false);
});
test('小程序更新响应丢失后忽略发现人元数据接纳原请求，保留后续本机修改', async () => {
  const s = setup(), data = checklistData(), values = { ...dailyBody(), checklist: C.stringify(data) };
  s.server = { ...values, id: 10, status: 'draft', lockVersion: 1 };
  const d = s.drafts.create('daily-inspections', values, s.server); s.drafts.edit(d.localId, { body: values });
  let writes = 0; const request = s.api.request;
  s.api.request = async (...args) => {
    if (args[1] === 'PUT') {
      if (++writes === 1) { await request(...args); const remote = C.parse(s.server.checklist); Object.assign(remote.items[0].problems[0], { foundById: 1, foundByName: '真实发现人' }); s.server.checklist = C.stringify(remote); throw error(undefined, '响应丢失'); }
      throw error(409, '版本变化');
    }
    return request(...args);
  };
  await assert.rejects(s.drafts.sync(d.localId), /响应丢失/);
  data.items[0].problems[0].description = '本机新说明'; s.drafts.edit(d.localId, { body: { ...values, checklist: C.stringify(data) } });
  await s.drafts.sync(d.localId); const latest = s.drafts.get(d.localId), p = C.parse(latest.body.checklist).items[0].problems[0];
  assert.equal(latest.dirty, true); assert.equal(p.description, '本机新说明'); assert.equal(p.foundByName, '真实发现人');
});
test('小程序巡检不进入修订审核链，复制完整保留字段且发现人重新待同步', async () => {
  const { s, p } = setupDailyPage(), data = checklistData(); data.items[0].problems[0].foundByName = '原发现人'; data.items[0].problems[0].foundById = 1;
  const values = { ...dailyBody(), startTime: '2026-10-29T08:00:00', endTime: '2026-10-29T09:00:00', workerCount: 0, manageCount: 2, checklist: C.stringify(data) };
  const record = { ...values, id: 20, inspectorId: 1, status: 'approved', lockVersion: 1 }; s.server = record;
  p.showRecord(record); assert.equal(p.data.body.checklist, values.checklist); assert.equal(p.data.people.author, '用户#1');
  const work = p.revise(); s.modal.success({ confirm: true }); await work;
  assert.equal(p.data.canRevise, false); assert.equal(s.calls.some(c => c.url.endsWith('/new-version')), false);
  const original = s.drafts.create(p.kind, values, record), fork = s.drafts.fork(original.localId);
  assert.equal(fork.body.workerCount, 0); assert.equal(fork.body.startTime, values.startTime);
  assert.equal(C.stats(fork.body.checklist).problems, 1); assert.equal(fork.body.sourceRecordId, undefined);
  assert.equal(C.parse(fork.body.checklist).items[0].problems[0].foundByName, undefined);
});
test('电脑巡检CSV仅服务器结果，含时间人数问题附件名且无访问链接', async () => {
  const s = await setupPc('daily-inspections'), data = checklistData(); data.items[0].problems[0].attachments.push({ url: '/api/uploads/x.jpg?token=secret', name: '问题照片.jpg' });
  await s.actions.create(); s.actions.getDraft().body.content = '不应导出的本机正文';
  s.records.push({ ...dailyBody(), code: '=公式', startTime: '2026-10-29T08:00:00', workerCount: 0, checklist: C.stringify(data), photos: '[{"url":"/api/uploads/a.jpg","name":"现场.jpg"}]' });
  await s.actions.exportRows(); const csv = await s.blob.text();
  for (const text of ['巡检时间', '施工人数', '检查统计', '问题照片.jpg', '现场.jpg', '2026-10-29 08:00:00', "'=公式"]) assert.ok(csv.includes(text), text);
  assert.doesNotMatch(csv, /token=secret|\/api\/uploads|不应导出的本机正文/);
});
function setupChecklistView(data = C.empty(), options = {}) {
  const s = { raw: C.stringify(data), errors: [], confirms: [], uploads: [], busy: !!options.busy, confirm: true };
  const simple = id => ({ dataset: {}, textContent: '', focus() { s.focus = id || 'control'; }, click() {} });
  // 检查项照片是行内 file 输入：按 data-ic-photo 缓存元素，重渲染后仍复用同一 onchange 绑定
  const photoInputs = new Map();
  const stats = simple(), errorBox = simple(), print = simple(), box = { innerHTML: '', querySelector: selector => simple(selector), querySelectorAll: () => [] };
  const host = { innerHTML: '', contains: () => true,
    querySelector: selector => selector === '[data-ic-panel]' ? box : selector === '[data-ic-summary]' ? stats : selector === '.ic-print' ? print : errorBox,
    querySelectorAll(selector) {
      if (selector === '[data-ic-photo]') return [...this.innerHTML.matchAll(/data-ic-photo="([^"]+)"/g)].map(m => {
        if (!photoInputs.has(m[1])) photoInputs.set(m[1], { dataset: { icPhoto: m[1] }, value: '' });
        return photoInputs.get(m[1]);
      });
      return [simple()];
    } }, photoInput = id => {
      if (!photoInputs.has(id)) photoInputs.set(id, { dataset: { icPhoto: id }, value: '' });
      return photoInputs.get(id);
    };
  const context = { window: null, document: {}, App: { escape: v => String(v == null ? '' : v).replace(/</g, '&lt;'), getUser: () => ({ userName: '填写人' }),
    confirm: async text => { s.confirms.push(text); return s.confirm; } }, InspectionChecklist: C };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../assets/inspection-checklist.js'), 'utf8'), context);
  s.view = context.InspectionChecklistView(host, { raw: () => s.raw, readOnly: !!options.readOnly, busy: () => s.busy,
    change: raw => { s.raw = raw; }, error: e => s.errors.push(e.message), openFile: url => { s.opened = url; },
    upload: async file => { s.uploads.push(file.name); return s.upload ? s.upload(file) : { url: '/api/uploads/' + file.name, name: file.name, size: 1 }; } });
  s.click = (action, itemId, problemId, extra) => {
    const el = { dataset: Object.assign({ icAction: action }, extra || {}), closest: selector => selector === '[data-ic-action]' ? el : { dataset: { icId: itemId, problemId } } };
    return host.onclick({ target: el });
  };
  s.input = (id, field, value, problem) => host.oninput({ target: { dataset: { [problem ? 'problemField' : 'icField']: field }, value,
    closest: () => ({ dataset: { icId: id, problemId: id } }) } });
  s.icFiles = async (itemId, files) => {
    // 页面 onchange 内部是异步上传，这里等微任务跑完再断言
    photoInput(itemId).onchange({ stopPropagation() {}, target: { files, value: '' } });
    for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve));
  };
  return Object.assign(s, { host, box, stats, print });
}
test('电脑检查项空表新增、问题独立确认取消、结果不删问题与删除确认', async () => {
  const s = setupChecklistView(); assert.match(s.host.innerHTML, /未录入检查项/);
  await s.click('add'); const id = C.parse(s.raw).items[0].id; await s.input(id, 'content', '检查脚手架');
  await s.click('problems', id);
  assert.equal((s.box.innerHTML.match(/data-problem-id=/g) || []).length, 1, '点开即给出问题说明输入框');
  assert.equal(C.stats(s.raw).problems, 0);
  assert.throws(s.view.guard, /确认或取消/); assert.equal(s.view.hasUnsaved(), true);
  await s.click('cancel-problems'); assert.equal(C.stats(s.raw).problems, 0);
  await s.click('problems', id); await s.click('add-problem'); await s.click('confirm-problems'); assert.equal(C.stats(s.raw).problems, 2);
  await s.input(id, 'result', 'compliant'); assert.equal(C.stats(s.raw).problems, 2);
  s.confirm = false; await s.click('delete', id); assert.equal(C.stats(s.raw).total, 1); assert.match(s.confirms.at(-1), /2 个问题/);
  s.confirm = true; await s.click('delete', id); assert.equal(C.stats(s.raw).total, 0);
});
test('电脑点击问题直接展开并聚焦，已有问题不重复新增', async () => {
  const data = checklistData(false), id = data.items[0].id, s = setupChecklistView(data);
  await s.click('problems', id);
  const pid = s.box.innerHTML.match(/data-problem-id="([^"]+)"/)[1];
  assert.equal((s.box.innerHTML.match(/data-problem-id=/g) || []).length, 1);
  assert.match(s.focus, /data-problem-field="description"/); assert.ok(s.focus.includes(pid));
  assert.equal(C.stats(s.raw).problems, 0, '确认前不写回检查项');
  await s.input(pid, 'description', '临边防护缺失', true); await s.click('confirm-problems');
  assert.equal(C.stats(s.raw).problems, 1);
  await s.click('problems', id); assert.equal((s.box.innerHTML.match(/data-problem-id=/g) || []).length, 1);
  assert.ok(s.focus.includes(pid), '再次打开聚焦已有问题而不是新增');
  // 符合的检查项点开同样直接给出问题说明输入框
  const ok = checklistData(false); ok.items[0].result = 'compliant'; const s2 = setupChecklistView(ok);
  await s2.click('problems', ok.items[0].id);
  assert.equal((s2.box.innerHTML.match(/data-problem-id=/g) || []).length, 1);
  assert.match(s2.focus, /data-problem-field="description"/); assert.equal(C.stats(s2.raw).problems, 0);
});
test('电脑问题面板仅保留问题说明，空说明也可确认，只读不允许写入', async () => {
  const data = checklistData(false), id = data.items[0].id, s = setupChecklistView(data, { busy: true });
  assert.match(s.host.innerHTML, /添加检查项/); await s.click('add'); assert.equal(C.stats(s.raw).total, 1); s.busy = false;
  await s.click('problems', id);
  assert.doesNotMatch(s.box.innerHTML, /问题名称|问题类型/); assert.match(s.box.innerHTML, /data-problem-field="description"/);
  const pid = s.box.innerHTML.match(/data-problem-id="([^"]+)"/)[1];
  await s.input(pid, 'description', '', true); await s.click('confirm-problems'); assert.doesNotThrow(s.view.guard);
  await s.click('problems', id); await s.input(pid, 'description', '有效说明', true); await s.click('confirm-problems'); assert.doesNotThrow(s.view.guard);
  const read = setupChecklistView(C.parse(s.raw), { readOnly: true }); assert.doesNotMatch(read.host.innerHTML, /data-ic-action="add"/);
  await read.click('problems', id); assert.doesNotMatch(read.box.innerHTML, /data-ic-action="add-problem"/);
  assert.doesNotMatch(read.box.innerHTML, /问题名称|问题类型/); assert.match(read.box.innerHTML, /data-problem-field="description"/);
  await read.input(pid, 'description', '不应修改', true); await read.click('cancel-problems'); assert.equal(read.raw, s.raw);
});
test('电脑问题面板无上传入口，历史附件只读查看，打印含名称与结果', async () => {
  const data = checklistData(); data.items[0].problems[0].attachments.push({ url: '/api/uploads/old.jpg', name: '历史问题照片.jpg' });
  const s = setupChecklistView(data); await s.click('problems', data.items[0].id);
  assert.doesNotMatch(s.box.innerHTML, /ic-upload|data-problem-upload|添加图片或附件|重试问题附件|data-upload-message/, '问题面板不再渲染任何上传入口');
  assert.doesNotMatch(s.box.innerHTML, /data-ic-action="remove-file"/, '历史附件不提供移除');
  assert.match(s.box.innerHTML, /历史问题照片.jpg/); assert.match(s.box.innerHTML, /data-ic-action="file"/, '历史附件仍可查看');
  await s.click('file', data.items[0].id, undefined, { url: '/api/uploads/old.jpg' });
  assert.equal(s.opened, '/api/uploads/old.jpg');
  await s.click('confirm-problems');
  assert.equal(C.parse(s.raw).items[0].problems[0].attachments.length, 1, '确认后历史附件保留');
  s.view.print();
  assert.match(s.print.textContent, /历史问题照片.jpg/); assert.match(s.print.textContent, /结果：不符合/);
  assert.doesNotMatch(s.print.textContent, /\/api\/uploads|结果：未检查|结果：符合/);
});
test('电脑问题面板新增与确认不触发任何上传，仅写回问题说明', async () => {
  const data = checklistData(false), s = setupChecklistView(data); await s.click('problems', data.items[0].id);
  const pid = s.box.innerHTML.match(/data-problem-id="([^"]+)"/)[1];
  await s.input(pid, 'description', '临边防护缺失', true);
  await s.click('add-problem');
  assert.equal(s.uploads.length, 0, '问题面板不再上传任何文件');
  assert.doesNotMatch(s.box.innerHTML, /data-problem-upload|ic-upload/);
  await s.click('confirm-problems');
  assert.equal(C.stats(s.raw).problems, 2);
  assert.equal(s.uploads.length, 0);
  assert.equal(s.view.hasUnsaved(), false);
});
test('电脑检查项现场照片独立上传、重复去重、移除与只读隐藏入口', async () => {
  const data = checklistData(), id = data.items[0].id, s = setupChecklistView(data);
  assert.match(s.host.innerHTML, /<th>现场照片<\/th>/);
  assert.ok(s.host.innerHTML.includes('data-ic-photo="' + id + '"'), '每行有独立照片入口');
  assert.match(s.host.innerHTML, /未上传/);
  await s.icFiles(id, [{ name: '现场凭证.jpg' }]);
  assert.deepEqual(s.uploads, ['现场凭证.jpg']);
  assert.deepEqual(C.parse(s.raw).items[0].photos.map(f => f.name), ['现场凭证.jpg']);
  assert.equal(s.view.hasUnsaved(), false, '检查项照片无需问题面板确认');
  // 同一地址重复选择不重复入库
  await s.icFiles(id, [{ name: '现场凭证.jpg' }]);
  assert.equal(C.parse(s.raw).items[0].photos.length, 1);
  assert.match(s.host.innerHTML, /现场凭证.jpg/);
  // 只移除该项照片，问题附件与问题本身不受影响
  await s.click('remove-photo', id, undefined, { url: '/api/uploads/现场凭证.jpg' });
  assert.equal(C.parse(s.raw).items[0].photos.length, 0);
  assert.equal(C.parse(s.raw).items[0].problems.length, 1);
  const read = setupChecklistView(C.parse(s.raw), { readOnly: true });
  assert.doesNotMatch(read.host.innerHTML, /data-ic-photo="/, '只读视图不渲染上传入口');
});
test('电脑检查项照片每项十张与整单五十个附件上限', async () => {
  const data = checklistData(), item = data.items[0];
  item.photos = Array.from({ length: 10 }, (_, n) => ({ url: '/api/uploads/p' + n + '.jpg', name: 'p' + n + '.jpg' }));
  const s = setupChecklistView(data);
  await s.icFiles(item.id, [{ name: 'extra.jpg' }]);
  assert.match(s.errors.at(-1), /每项最多 10 张检查项照片/);
  assert.equal(s.uploads.length, 0, '超限不再上传');
  const full = checklistData(), target = full.items[0];
  target.problems[0].attachments = Array.from({ length: 40 }, (_, n) => ({ url: '/api/uploads/a' + n + '.jpg', name: 'a' + n + '.jpg' }));
  // 另一项已满 10 张照片，本项仍可再加入，但整单已到 50 个附件
  const sibling = Object.assign(C.newItem(), { content: '安全网', result: 'compliant',
    photos: Array.from({ length: 10 }, (_, n) => ({ url: '/api/uploads/b' + n + '.jpg', name: 'b' + n + '.jpg' })) });
  full.items.push(sibling);
  const s2 = setupChecklistView(full);
  await s2.icFiles(target.id, [{ name: 'overflow.jpg' }]);
  assert.match(s2.errors.at(-1), /50 个附件（含检查项照片与问题附件）/);
  assert.equal(s2.uploads.length, 0);
});
test('电脑巡检新建默认当前分钟、单一时间提交且部位内容可留空', async () => {
  assert.equal(schema.nowMinute(new Date(2026, 0, 2, 3, 4)), '2026-01-02 03:04');
  const s = await setupPc('daily-inspections'); await s.actions.create();
  const html = s.nodes.fwForm.innerHTML, body = s.actions.getDraft().body;
  assert.match(String(body.startTime), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.ok(String(body.startTime).startsWith(schema.today()), '默认带入当前日期');
  assert.match(html, /data-field="startTime"[^>]*value="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00"/);
  assert.equal(html.includes('data-field="endTime"'), false, '不再渲染结束时间');
  // 检查部位与巡视内容改为选填：不再出现必填标记
  for (const field of ['location', 'content']) {
    const at = html.indexOf('id="fwF-' + field + '"');
    assert.ok(at > 0, field + ' 仍需渲染');
    assert.doesNotMatch(html.slice(html.lastIndexOf('fd-label', at), at), /fd-req/, field + ' 不再必填');
  }
  s.actions.getDraft().body.checklist = C.stringify(checklistData());
  await s.actions.save(true);
  const write = s.calls.find(c => c.opts && c.opts.method === 'POST');
  assert.ok(!write.opts.body.location); assert.ok(!write.opts.body.content);
  assert.match(write.opts.body.startTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
  assert.equal('endTime' in write.opts.body, false);
});
test('电脑巡检恢复旧pending后新增明细仍留在本机，不提交旧版本', async () => {
  const s = await setupPc('daily-inspections'); await s.actions.create(); const d = s.actions.getDraft();
  Object.assign(d.body, dailyBody()); s.writeError = error(undefined, '响应丢失'); await assert.rejects(s.actions.save(false));
  d.body.checklist = C.stringify(checklistData()); s.writeError = null; await s.actions.save(true);
  assert.equal(s.calls.some(c => c.path.endsWith('/submit')), false); assert.match(s.nodes.fwError.textContent, /本机新修改仍保留/);
  assert.equal(C.stats(s.actions.getDraft().body.checklist).problems, 1);
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

const homeSource = fs.readFileSync(path.join(__dirname, '../pages/home/index.js'), 'utf8');
function setupHome(s) {
  let page;
  s.api.request = async (url, method, params) => {
    s.homeCalls = (s.homeCalls || []).concat([{ url, params: copy(params) }]);
    if (url === '/field/summary') return { canReview: true, date: '2026-10-29',
      'daily-inspections': { draft: 1, submitted: 0, approved: 0, rejected: 0, recorded: 2 },
      'supervision-diaries': { draft: 0, submitted: 3, approved: 1, rejected: 0, recorded: 0 },
      'supervision-logs': { draft: 0, submitted: 0, approved: 0, rejected: 0, recorded: 0 },
      'sideline-inspections': { draft: 0, submitted: 0, approved: 0, rejected: 0, recorded: 0 } };
    if (method === 'GET') return { list: [{ id: 5, status: url === '/daily-inspections' ? 'recorded' : 'submitted' }], total: 1 };
    return {};
  };
  vm.runInNewContext(homeSource, { Page: value => { page = value; }, wx: s.wx,
    require: name => ({ '../../utils/api': s.api, '../../utils/drafts': s.drafts, '../../utils/schema': schema })[name] });
  page.data = copy(page.data); page.setData = values => Object.assign(page.data, copy(values));
  return page;
}
test('小程序巡检提交即保存并回列表，无审核确认，已保存可再次编辑', async () => {
  const s = setup(), p = setupPage(s); p.kind = 'daily-inspections';
  s.wx.navigateBack = () => { s.backed = true; };
  const d = s.drafts.create(p.kind, dailyBody(), { id: 10, status: 'recorded', lockVersion: 3, authorId: 1 });
  p.localId = d.localId; p.showDraft(d);
  assert.equal(p.data.editable, true, '本人已保存巡检仍可编辑');
  assert.equal(p.data.memo, true); assert.equal(p.data.submitLabel, '保存修改');
  assert.equal(p.data.canRevise, false); assert.equal(p.data.state, '已保存');
  await p.action({ currentTarget: { dataset: { action: 'submit' } } });
  assert.equal(s.modal, undefined, '巡检提交不再弹审核或正文锁定确认');
  assert.equal(s.toast, '巡检已保存');
  assert.equal(s.drafts.get(d.localId).serverStatus, 'recorded');
  assert.equal(s.calls.some(c => c.url.endsWith('/submit')), false, '已保存巡检不调用审核提交接口');
  s.timeouts.forEach(fn => fn()); assert.equal(s.backed, true, '保存成功后回到列表');
  const s2 = setup(), p2 = setupPage(s2); p2.kind = 'daily-inspections';
  s2.wx.navigateBack = () => { s2.backed = true; };
  const d2 = s2.drafts.create('daily-inspections', dailyBody()); p2.localId = d2.localId; p2.showDraft(d2);
  assert.equal(p2.data.submitLabel, '提交');
  await p2.action({ currentTarget: { dataset: { action: 'submit' } } });
  assert.equal(s2.drafts.get(d2.localId).serverStatus, 'recorded', '新草稿提交直接成为已保存');
  assert.equal(s2.calls.some(c => c.url.endsWith('/submit')), false);
  assert.equal(s2.modal, undefined); s2.timeouts.forEach(fn => fn()); assert.equal(s2.backed, true);
});
test('小程序巡检新建自动带入当前分钟，其他类型不带巡检时间', () => {
  const s = setup(), p = setupHome(s);
  p.data.projects = [{ id: 2, name: '测试工程' }]; p.data.projectIndex = 0;
  s.wx.navigateTo = options => { s.navigation = options.url; };
  p.create({ currentTarget: { dataset: { kind: 'daily-inspections' } } });
  const daily = s.drafts.list().at(-1);
  assert.match(String(daily.body.startTime), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.ok(String(daily.body.startTime).startsWith(schema.today()));
  assert.match(s.navigation, /pages\/record\/index\?localId=/);
  p.create({ currentTarget: { dataset: { kind: 'supervision-diaries' } } });
  assert.equal('startTime' in s.drafts.list().find(d => d.kind === 'supervision-diaries').body, false);
});
test('小程序首页巡检不展示待审核，切到巡检回到我的记录且摘要只给草稿与已保存', async () => {
  const s = setup(), p = setupHome(s);
  p.data.projects = [{ id: 2, name: '测试工程' }]; p.data.projectIndex = 0;
  p.data.kind = 'supervision-diaries'; p.data.mode = 'todo';
  await p.reload();
  assert.equal(p.data.mode, 'todo');
  assert.equal(p.data.summary.find(x => x.kind === 'daily-inspections').memo, true);
  p.selectKind({ currentTarget: { dataset: { kind: 'daily-inspections' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.data.mode, 'mine', '切到巡检应从待审核回到我的记录');
  assert.equal(s.homeCalls.filter(c => c.url === '/daily-inspections').at(-1).params.status, undefined, '巡检不按待审核筛选');
  assert.equal(p.data.records[0].statusText, '已保存');
  p.mode({ currentTarget: { dataset: { mode: 'todo' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.data.mode, 'mine', '巡检不提供项目待审核模式');
});

function dailySyncRecord() {
  return { id: 31, code: 'D-20261109-31', title: '一层', startTime: '2026-11-09T08:30:00', workerCount: 12, manageCount: 3,
    inspectionContent: '检查临边防护与临时用电', issues: '一处防护需加固',
    checklist: JSON.stringify({ version: 1, items: [{ id: 'ci-diary-1', content: '临边防护', result: 'noncompliant',
      photos: [{ url: '/api/uploads/item.jpg', name: '检查项.jpg' }],
      problems: [{ id: 'cp-diary-1', description: '防护松动，已要求立即加固', attachments: [] }] }] }),
    syncPhotos: [{ url: '/api/uploads/item.jpg', name: '检查项.jpg', size: 20 }, { url: '/api/uploads/whole.jpg', name: '整单照片.jpg', size: 30 }] };
}
test('巡检同步模型分栏追加、保留原文、照片去重且重复操作幂等', () => {
  const record = dailySyncRecord();
  const original = { inspection: '手写监理工作\n', newIssues: '原有问题', otherWork: '其他栏目不动' };
  const current = [{ url: '/api/uploads/item.jpg', name: '日记已有照片', description: '手写说明' }];
  const merged = DailySync.merge(record, original, current);
  assert.equal(merged.addedText, 2); assert.equal(merged.addedPhotos, 1);
  assert.ok(merged.body.inspection.startsWith('手写监理工作\n\n【日常巡检】D-20261109-31'));
  assert.match(merged.body.inspection, /巡检时间：2026-11-09 08:30/);
  assert.match(merged.body.inspection, /施工人数：12 人；管理人数：3 人/);
  assert.match(merged.body.inspection, /检查结果：不符合/);
  assert.ok(merged.body.newIssues.startsWith('原有问题\n\n【日常巡检】'));
  assert.match(merged.body.newIssues, /问题说明：防护松动，已要求立即加固/);
  assert.equal(merged.body.otherWork, '其他栏目不动');
  assert.equal(merged.photos[0].description, '手写说明');
  assert.equal(merged.photos[1].sourceId, 31);
  const repeated = DailySync.merge(record, merged.body, merged.photos);
  assert.equal(repeated.addedText, 0); assert.equal(repeated.addedPhotos, 0);
  assert.deepEqual(repeated.body, merged.body);
  const workOnly = DailySync.merge(record, original, current, { issues: false, photos: false });
  assert.equal(workOnly.body.newIssues, '原有问题'); assert.equal(workOnly.addedPhotos, 0);
  assert.throws(() => DailySync.merge(record, { inspection: '字'.repeat(60000) }, []), /60000/);
  assert.throws(() => DailySync.merge(record, {}, Array.from({ length: 50 }, (_, n) => ({ url: '/api/uploads/' + n + '.jpg' }))), /50/);
});
test('电脑端巡检一键追加到日记正文与照片区，不重复上传且不自动保存', async () => {
  const s = await setupPc(); s.enableControls(); s.workbench = { dailyInspections: [dailySyncRecord()], supervisionNotices: [], workContacts: [], documents: [] };
  await s.actions.create(); await tick();
  assert.match(s.nodes.fwDiaryDay.innerHTML, /同步到日记/);
  s.input('inspection', '手写监理工作');
  s.actions.syncDailyInspection(0, { inspection: true, issues: true, photos: true });
  const d = s.actions.getDraft();
  assert.ok(d.body.inspection.startsWith('手写监理工作\n\n【日常巡检】'));
  assert.match(d.body.newIssues, /防护松动，已要求立即加固/);
  assert.equal(JSON.parse(d.body.photos).length, 2);
  assert.match(s.nodes.fwForm.innerHTML, /D-20261109-31/);
  assert.equal(s.uploads.length, 0); assert.equal(s.calls.filter(c => c.opts && c.opts.method).length, 0);
  s.actions.syncDailyInspection(0, { inspection: true, issues: true, photos: true });
  assert.deepEqual(s.actions.getDraft().body, d.body);
});
test('小程序巡检选择面板写回本机草稿并保留已有日记与照片', async () => {
  const s = setup(), p = setupPage(s), d = create(s); p.localId = d.localId;
  const existing = Object.assign(body(), { inspection: '手写监理工作', newIssues: '原有问题', photos: JSON.stringify([{ url: '/api/uploads/item.jpg', description: '原有说明' }]) });
  const local = s.drafts.create('supervision-diaries', existing); p.localId = local.localId; p.showDraft(local);
  s.workbench = { dailyInspections: [dailySyncRecord()] };
  await p.loadDailyInspections();
  assert.equal(p.data.dailyRecords[0].photoCount, 2);
  p.openDailySync({ currentTarget: { dataset: { index: 0 } } });
  p.dailySyncChoice({ detail: { value: ['inspection', 'issues', 'photos'] } });
  p.confirmDailySync(); await tick();
  const saved = s.drafts.get(local.localId).body;
  assert.ok(saved.inspection.startsWith('手写监理工作\n\n【日常巡检】'));
  assert.match(saved.newIssues, /防护松动，已要求立即加固/);
  assert.equal(JSON.parse(saved.photos).length, 2);
  assert.equal(JSON.parse(saved.photos)[0].description, '原有说明');
  assert.equal(p.data.fields.find(f => f.key === 'inspection').value, saved.inspection);
  assert.equal(p.data.dailySyncIndex, -1); assert.equal(s.uploads.length, 0);
  p.openDailySync({ currentTarget: { dataset: { index: 0 } } }); p.confirmDailySync();
  assert.equal(s.drafts.get(local.localId).body.inspection, saved.inspection);
  assert.equal(JSON.parse(s.drafts.get(local.localId).body.photos).length, 2);
});
