'use strict';
// 仅运行于已确认的本地 e2e/H2 环境；不更改业务源码，不访问正式系统。
// 凭据仅从环境读取并驻留内存，输出证据不包含 JWT、密码及签名链接。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const base = process.env.QA22_API_BASE || 'http://127.0.0.1:8091/api';
const run = 'QA22-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const out = path.join(__dirname, run);
const results = [], fixtures = [], requests = [];
const modules = ['仪表盘', '项目台账', '日常巡检', '旁站检查', '监理通知单', '工作联系单', '监理日记', '监理日志', '安全日志', '会议纪要', '监理月报', '工程资料目录与上传', '统计报表', '消息中心', '个人资料与设置', '部门管理', '人员管理', '权限设置', '流程管理', '操作日志', '工作标准配置', '登录与认证'];
let admin, author, reviewer, outsider, authorUser, reviewerUser, outsiderUser, project, otherProject, photo, doc, leaf;
const date = '2026-09-23';
const password = randomBytes(8).toString('hex');
function clean(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => /token|password|signature|signing|phone|idCard|requestHash|requestKey/i.test(key) ? '[已脱敏]' : v));
}
function check(module, title, ok, actual, expected = '') {
  const row = { id: 'T' + String(results.length + 1).padStart(3, '0'), module, title, result: ok ? '通过' : '失败', expected, actual: clean(actual ?? null) };
  results.push(row); console.log(`${row.id} ${row.result} ${module}：${title}`); return ok;
}
function note(module, title, result, actual) { results.push({ id: 'T' + String(results.length + 1).padStart(3, '0'), module, title, result, actual }); }
async function api(method, route, body, token = admin, headers = {}) {
  const start = Date.now();
  try {
    const h = { ...headers }; if (token) h.Authorization = 'Bearer ' + token;
    if (body != null && !(body instanceof FormData)) h['Content-Type'] = 'application/json';
    const response = await fetch(base + route, { method, headers: h, body: body == null ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'manual' });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch (_) { json = {}; }
    const r = { http: response.status, code: json.code, message: json.message, data: json.data };
    requests.push({ method, route, http: r.http, code: r.code, message: r.message, elapsedMs: Date.now() - start });
    return r;
  } catch (e) { const r = { http: 0, message: e.message }; requests.push({ method, route, ...r }); return r; }
}
const ok = r => r.http === 200 && r.code === 200;
const err4 = r => r.http >= 400 && r.http < 500;
const ver = r => ({ 'X-Record-Version': String(r.lockVersion) });
const key = () => ({ 'Idempotency-Key': randomUUID() });
async function create(module, endpoint, data, token = admin, headers = {}) {
  const r = await api('POST', endpoint, data, token, headers);
  check(module, '新增模拟记录 ' + (data.code || data.name || data.title || endpoint), ok(r) && !!r.data?.id, r);
  if (!ok(r) || !r.data?.id) throw new Error(module + '前置数据创建失败：' + r.message);
  fixtures.push({ module, endpoint, id: r.data.id, name: data.name || data.title, code: data.code, projectId: data.projectId, initialStatus: r.data.status });
  return r.data;
}
async function group(module, fn) {
  try { await fn(); } catch (e) { note(module, '后续场景执行受阻', '受阻', e.message); console.log(module, e.message); }
}
async function login(name, pwd, module = '登录与认证') {
  const r = await api('POST', '/auth/login', { username: name, password: pwd }, null);
  check(module, '账号认证并签发 JWT：' + name, ok(r) && !!r.data?.token, { http: r.http, code: r.code, userId: r.data?.userId, roles: r.data?.roles });
  if (!r.data?.token) throw new Error('未获取测试令牌');
  const payload = JSON.parse(Buffer.from(r.data.token.split('.')[1], 'base64url').toString());
  check(module, 'JWT具有签名、签发时间和有效期', r.data.token.split('.').length === 3 && payload.exp > payload.iat, { exp: payload.exp, iat: payload.iat });
  return r.data.token;
}
async function upload(name, bytes, type, token, endpoint = '/files/upload') {
  const form = new FormData(); form.append('file', new Blob([bytes], { type }), name);
  return api('POST', endpoint, form, token);
}
function business(kind, suffix = '') {
  const body = { projectId: project.id, code: run + '-' + kind.slice(0, 3) + suffix, photos: JSON.stringify([{ url: photo, description: '模拟照片：A区钢筋检查，仅用于测试，不是真实施工证据' }]), attachments: JSON.stringify([{ url: doc, name: '模拟检查说明.txt' }]) };
  if (kind === 'supervision-diaries') Object.assign(body, { diaryDate: date, weather: '晴', wind: '东北风2级', temperature: '23℃~29℃', construction: 'A区1层梁板钢筋绑扎，轴线1-3/A-C，保护层25mm；检查记录为模拟数据。', management: '监理2人、施工12人，交底记录齐全。', inspection: '发现保护层垫块间距偏大，要求补设并复查。' });
  if (kind === 'supervision-logs') Object.assign(body, { logDate: date, weather: '晴', content: '项目当日监理工作汇总；已核对图纸与日记来源。', management: '安排钢筋隐蔽验收。' });
  if (kind === 'daily-inspections') Object.assign(body, { inspectionDate: date, location: 'A区1层梁板1-3/A-C轴', content: '检查钢筋规格、数量、保护层和临边防护。', issues: JSON.stringify([{ content: '垫块间距偏大', status: 'unfixed' }]) });
  if (kind === 'sideline-inspections') Object.assign(body, { inspectionDate: date, location: 'A区1层梁板', startTime: date + 'T08:00:00', endTime: date + 'T10:30:00', content: JSON.stringify({ process: '混凝土浇筑', result: '完成', manageCount: 2, workerCount: 12, docs: ['结构图S-01'], issues: '坍落度复核合格', text: 'C30混凝土，见证取样；模拟施工数据。' }) });
  return body;
}
async function fieldFlow(module, kind) {
  const input = business(kind, '-flow'); input.authorId = outsiderUser.id; input.inspectorId = outsiderUser.id;
  const h = key(); let r = await create(module, '/' + kind, input, author, h); const id = r.id, route = '/' + kind + '/' + id;
  check(module, '服务端绑定真实作者，不接受冒名', (r.authorId ?? r.inspectorId) === authorUser.id, { authorId: r.authorId, inspectorId: r.inspectorId });
  let q = await api('POST', '/' + kind, input, author, h); check(module, '重复请求幂等，不生成第二张单', ok(q) && q.data.id === id, q.data?.id);
  q = await api('POST', '/' + kind, { ...input, weather: '不同请求' }, author, h); check(module, '同键不同正文返回409', q.http === 409, q);
  q = await api('GET', route, null, outsider); check(module, '其他项目用户禁止查看', q.http === 403, q);
  q = await api('GET', route, null, reviewer); check(module, '审核人不能查看未提交私人草稿', q.http === 403, q);
  q = await api('PUT', route, input, author); check(module, '缺并发版本拒绝写入', q.http === 428, q);
  const changedField = kind === 'supervision-diaries' ? 'construction' : kind === 'supervision-logs' ? 'management' : 'location';
  const changedValue = 'QA22并发验证：已补充现场实测部位说明';
  const oldVersion = r.lockVersion;
  q = await api('PUT', route, { [changedField]: changedValue, code: '' }, author, ver(r)); check(module, '实际编辑草稿并保留编号、递增并发版本', ok(q) && q.data.code === r.code && q.data.lockVersion > oldVersion, q.data); if (!ok(q)) throw new Error('编辑失败'); r = q.data;
  q = await api('PUT', route, input, author, { 'X-Record-Version': String(oldVersion) }); check(module, '旧版本更新返回409，不覆盖新稿', q.http === 409, q);
  q = await api('GET', route, null, author); check(module, '冲突后服务端保留较新正文', ok(q) && q.data[changedField] === changedValue, q.data?.[changedField]);
  q = await api('POST', route + '/submit', null, author, ver(r)); check(module, '草稿提交进入待审核', ok(q) && q.data.status === 'submitted', q.data); if (!ok(q)) throw new Error('提交失败'); r = q.data;
  q = await api('POST', route + '/approve', { status: 'approved' }, author, ver(r)); check(module, '普通作者禁止自行审核', q.http === 403, q);
  q = await api('POST', route + '/approve', { status: 'rejected' }, reviewer, ver(r)); check(module, '退回必须填写原因', q.http === 400, q);
  q = await api('POST', route + '/approve', { status: 'rejected', rejectReason: '请补充部位说明及复查结论' }, reviewer, ver(r)); check(module, '授权审核人退回', ok(q) && q.data.status === 'rejected', q.data); if (!ok(q)) throw new Error('退回失败'); r = q.data;
  q = await api('PUT', route, { ...business(kind, '-flow'), code: r.code }, author, ver(r)); check(module, '退回后可修改', ok(q), q.data); if (!ok(q)) throw new Error('修改失败'); r = q.data;
  q = await api('POST', route + '/submit', null, author, ver(r)); check(module, '修改后再次提交', ok(q) && q.data.status === 'submitted', q.data); r = q.data;
  q = await api('POST', route + '/approve', { status: 'approved' }, reviewer, ver(r)); check(module, '再次提交后审核通过', ok(q) && q.data.status === 'approved', q.data); r = q.data;
  q = await api('PUT', route, { content: '不应覆盖的内容' }, author, ver(r)); check(module, '已通过正文锁定', q.http === 409, q);
  q = await api('GET', route + '/history', null, author); const actions = q.data?.map(e => e.action) || [];
  check(module, '版本历史含提交、退回、通过与正文快照', ok(q) && ['submit', 'rejected', 'approved'].every(a => actions.includes(a)) && q.data.every(e => !!e.snapshot), { actions, length: q.data?.length });
  const rev = await create(module, '/' + kind, { ...business(kind, '-rev'), sourceRecordId: id }, author, key());
  check(module, '修订稿保留来源且不覆盖已审核原件', rev.sourceRecordId === id && rev.status === 'draft', { id: rev.id, sourceRecordId: rev.sourceRecordId, version: rev.version });
  for (const status of ['draft', 'submitted', 'rejected']) {
    let sample = await create(module, '/' + kind, business(kind, '-' + status), author, key());
    if (status !== 'draft') { q = await api('POST', '/' + kind + '/' + sample.id + '/submit', null, author, ver(sample)); if (!ok(q)) throw new Error('状态样本提交失败'); sample = q.data; }
    if (status === 'rejected') { q = await api('POST', '/' + kind + '/' + sample.id + '/approve', { status, rejectReason: '待补充照片部位说明' }, reviewer, ver(sample)); check(module, '保留退回样本', ok(q) && q.data.status === status, q.data); }
  }
  q = await api('GET', '/' + kind + '?projectId=' + project.id + '&status=approved&dateFrom=' + date + '&dateTo=' + date, null, author);
  check(module, '项目/状态/日期过滤准确', ok(q) && q.data.total === 1 && q.data.list[0].id === id, q.data);
  const p1 = await api('GET', '/' + kind + '?projectId=' + project.id + '&pageNum=1&pageSize=2', null, author);
  const p2 = await api('GET', '/' + kind + '?projectId=' + project.id + '&pageNum=2&pageSize=2', null, author);
  check(module, '分页总数一致且无重复记录', ok(p1) && ok(p2) && p1.data.total === 5 && p2.data.total === 5 && !p1.data.list.some(a => p2.data.list.some(b => b.id === a.id)), { page1: p1.data?.list.map(x => x.id), page2: p2.data?.list.map(x => x.id), total: p1.data?.total });
}
// 日常巡检按现场备忘录验收：提交即保存、服务端拒绝审核、已保存仍可本人修改
async function dailyMemoFlow(module, kind) {
  const input = business(kind, '-flow'); input.authorId = outsiderUser.id; input.inspectorId = outsiderUser.id;
  const h = key(); let r = await create(module, '/' + kind, input, author, h); const id = r.id, route = '/' + kind + '/' + id;
  check(module, '服务端绑定真实作者，不接受冒名', (r.authorId ?? r.inspectorId) === authorUser.id, { authorId: r.authorId, inspectorId: r.inspectorId });
  let q = await api('POST', '/' + kind, input, author, h); check(module, '重复请求幂等，不生成第二张单', ok(q) && q.data.id === id, q.data?.id);
  q = await api('POST', '/' + kind, { ...input, location: '另一处部位' }, author, h); check(module, '同键不同正文返回409', q.http === 409, q);
  q = await api('GET', route, null, outsider); check(module, '其他项目用户禁止查看', q.http === 403, q);
  q = await api('GET', route, null, reviewer); check(module, '审核人不能查看未提交私人草稿', q.http === 403, q);
  q = await api('PUT', route, input, author); check(module, '缺并发版本拒绝写入', q.http === 428, q);
  const oldVersion = r.lockVersion;
  q = await api('PUT', route, { location: 'QA22并发验证：已补充现场实测部位说明', code: '' }, author, ver(r));
  check(module, '实际编辑草稿并保留编号、递增并发版本', ok(q) && q.data.code === r.code && q.data.lockVersion > oldVersion, q.data); if (!ok(q)) throw new Error('编辑失败'); r = q.data;
  q = await api('PUT', route, input, author, { 'X-Record-Version': String(oldVersion) }); check(module, '旧版本更新返回409，不覆盖新稿', q.http === 409, q);
  q = await api('GET', route, null, author); check(module, '冲突后服务端保留较新正文', ok(q) && q.data.location === 'QA22并发验证：已补充现场实测部位说明', q.data?.location);
  q = await api('POST', route + '/submit', null, author, ver(r));
  check(module, '提交即保存为已保存，不产生待审核', ok(q) && q.data.status === 'recorded', q.data); if (!ok(q)) throw new Error('提交失败'); r = q.data;
  q = await api('POST', route + '/approve', { status: 'approved' }, reviewer, ver(r)); check(module, '巡检不提供审核（服务端拒绝审核）', q.http === 400 && /无需审核/.test(q.message || ''), q);
  q = await api('POST', route + '/approve', { status: 'rejected', rejectReason: '巡检不应退回' }, reviewer, ver(r)); check(module, '巡检同样拒绝退回', q.http === 400, q);
  q = await api('PUT', route, { ...business(kind, '-flow'), code: r.code }, author, ver(r));
  check(module, '已保存巡检本人可继续修改且仍为已保存', ok(q) && q.data.status === 'recorded' && q.data.lockVersion > r.lockVersion, q.data); if (!ok(q)) throw new Error('修改失败'); r = q.data;
  q = await api('PUT', route, { content: '不应被其他账号覆盖' }, outsider, ver(r)); check(module, '非本人禁止修改已保存巡检', err4(q), q);
  q = await api('GET', route + '/history', null, author); const actions = q.data?.map(e => e.action) || [];
  check(module, '保存历史含提交与修改且保留快照', ok(q) && actions.includes('submit') && actions.includes('save') && q.data.every(e => !!e.snapshot), { actions, length: q.data?.length });
  const draftSample = await create(module, '/' + kind, business(kind, '-draft'), author, key());
  const savedSample = await create(module, '/' + kind, business(kind, '-saved'), author, key());
  q = await api('POST', '/' + kind + '/' + savedSample.id + '/submit', null, author, ver(savedSample)); check(module, '第二条巡检提交后同为已保存', ok(q) && q.data.status === 'recorded', q.data);
  q = await api('GET', '/' + kind + '?projectId=' + project.id + '&status=recorded&dateFrom=' + date + '&dateTo=' + date, null, author);
  check(module, '按已保存筛选只返回保存态记录', ok(q) && q.data.total === 2 && q.data.list.some(x => x.id === id) && !q.data.list.some(x => x.id === draftSample.id), q.data);
  q = await api('GET', '/' + kind + '?projectId=' + project.id + '&status=draft&dateFrom=' + date + '&dateTo=' + date, null, author);
  check(module, '按草稿筛选不含已保存记录', ok(q) && q.data.total === 1 && q.data.list[0].id === draftSample.id, q.data);
  const p1 = await api('GET', '/' + kind + '?projectId=' + project.id + '&pageNum=1&pageSize=2', null, author);
  const p2 = await api('GET', '/' + kind + '?projectId=' + project.id + '&pageNum=2&pageSize=2', null, author);
  check(module, '分页总数一致且无重复记录', ok(p1) && ok(p2) && p1.data.total === 3 && p2.data.total === 3 && !p1.data.list.some(a => p2.data.list.some(b => b.id === a.id)), { page1: p1.data?.list.map(x => x.id), page2: p2.data?.list.map(x => x.id), total: p1.data?.total });
}
async function main() {
  if (process.env.QA22_ISOLATED !== '1' || !process.env.QA_ADMIN_PASSWORD) throw new Error('需确认本地H2并设置 QA22_ISOLATED=1 与 QA_ADMIN_PASSWORD；禁止指向正式数据。');
  fs.mkdirSync(out, { recursive: true });
  admin = await login('admin', process.env.QA_ADMIN_PASSWORD);
  let q = await api('POST', '/auth/login', { username: 'admin', password: 'QA22-wrong-password' }, null); check('登录与认证', '错误密码拒绝登录', err4(q), q);
  q = await api('GET', '/projects', null, null); check('登录与认证', '无令牌访问返回401', q.http === 401, q);
  q = await api('GET', '/projects', null, 'invalid.jwt.token'); check('登录与认证', '伪造令牌访问返回401', q.http === 401, q);
  const root = await create('部门管理', '/departments', { name: run + '模拟总公司', status: 'active', sortOrder: 1 });
  const branch = await create('部门管理', '/departments', { name: run + '监理一部', parentId: root.id, leader: '模拟总监', status: 'active', sortOrder: 1 });
  const team = await create('部门管理', '/departments', { name: run + '项目监理组', parentId: branch.id, status: 'active', sortOrder: 1 });
  await create('部门管理', '/departments', { name: run + '资料档案部', parentId: root.id, status: 'active', sortOrder: 2 });
  q = await api('GET', '/departments?name=' + encodeURIComponent(run)); check('部门管理', '四节点三级部门结构可查询', ok(q) && q.data.total === 4 && q.data.list.some(x => x.id === team.id && x.parentId === branch.id), q.data);
  q = await api('POST', '/departments', { name: '' }); check('部门管理', '空部门名称被拒绝', q.http === 400, q);
  const suffix = String(Date.now()).slice(-7);
  async function user(n, title, position) { return create('人员管理', '/users', { name: run + title, gender: '男', deptId: team.id, position, certNo: '模拟资格-' + n, phone: '139' + suffix + n, hireDate: '2026-01-01', status: 'active', password }); }
  authorUser = await user(1, '现场监理', '专业监理工程师'); reviewerUser = await user(2, '项目总监', '总监理工程师'); outsiderUser = await user(3, '乙项目监理', '监理员');
  q = await api('GET', '/users?deptId=' + team.id); check('人员管理', '部门筛选返回三种测试人员', ok(q) && q.data.total === 3, q.data);
  q = await api('POST', '/users', { name: run + '无效手机号', phone: '123' }); check('人员管理', '不合规手机号拒绝', q.http === 400, q);
  const role = await create('权限设置', '/roles', { name: run + '只读角色', code: run + '-read', description: '测试角色，不具管理员权限' });
  const reviewRole = await create('权限设置', '/roles', { name: run + '总监角色', code: run + '-review', description: '审核权限由项目授权配置' });
  const permission = await create('权限设置', '/permissions', { name: run + '日记查看', code: run + ':diary:read', module: 'supervision-diary', sortOrder: 1 });
  q = await api('POST', '/roles/' + role.id + '/permissions', [permission.id]); check('权限设置', '管理员配置测试角色权限', ok(q), q);
  q = await api('GET', '/permissions/tree'); check('权限设置', '权限树可读取新增模块节点', ok(q) && JSON.stringify(q.data).includes(permission.name), q.data);
  q = await api('POST', '/roles/' + role.id + '/users', [authorUser.id]); check('权限设置', '管理员分配测试普通角色', ok(q), q);
  q = await api('POST', '/roles/' + reviewRole.id + '/users', [reviewerUser.id]); check('权限设置', '管理员分配测试审核角色', ok(q), q);
  author = await login(authorUser.name, password); reviewer = await login(reviewerUser.name, password); outsider = await login(outsiderUser.name, password);
  for (const endpoint of ['/roles', '/permissions', '/departments', '/operation-logs']) { q = await api('GET', endpoint, null, author); check('权限设置', '普通用户禁止读取管理接口 ' + endpoint, q.http === 403, q); }
  q = await api('POST', '/users', { name: run + '越权创建', phone: '139' + suffix + '4', password }, author); check('人员管理', '普通用户禁止新增人员', q.http === 403, q);
  project = await create('项目台账', '/projects', { code: run + '-A', name: run + '示范楼A项目', buildUnit: '模拟建设单位甲', type: '房屋建筑', startDate: '2026-01-01', endDate: '2026-12-31', managerId: reviewerUser.id, address: '测试区A地块（非真实地址）' });
  otherProject = await create('项目台账', '/projects', { code: run + '-B', name: run + '配套道路B项目', buildUnit: '模拟建设单位乙', type: '市政', startDate: '2026-03-01', endDate: '2027-03-01', managerId: outsiderUser.id });
  for (const u of [authorUser, reviewerUser]) { q = await api('PUT', '/projects/' + project.id + '/members', { userId: u.id, enabled: true, canReview: u.id === reviewerUser.id }); check('权限设置', '设置项目成员/审核权 ' + u.name, ok(q), q.data); }
  q = await api('GET', '/projects', null, author); check('项目台账', '普通用户只看到获授权项目', ok(q) && q.data.total === 1 && q.data.list[0].id === project.id, q.data);
  q = await api('GET', '/projects/' + otherProject.id, null, author); check('项目台账', '直接猜ID也不能跨项目读取', q.http === 403, q);
  q = await api('POST', '/projects', { name: run + '越权项目', code: run + '-forbidden', buildUnit: '模拟' }, author); check('项目台账', '普通用户不能新增项目', q.http === 403, q);
  q = await api('POST', '/projects', { name: run + '重复项目', code: project.code, buildUnit: '模拟' }); check('项目台账', '重复项目编号拒绝', err4(q), q);
  q = await api('GET', '/projects?code=' + encodeURIComponent(project.code)); check('项目台账', '项目编号搜索准确', ok(q) && q.data.total === 1, q.data);
  await group('项目台账', async () => {
    const body = { code: run + '-STATUS', name: run + '项目状态回归', buildUnit: '模拟建设单位', status: 'planning' };
    const sample = await create('项目台账', '/projects', body);
    check('项目台账', '新建采用表单选择的项目状态', sample.status === 'planning', sample.status, 'planning');
    const route = '/projects/' + sample.id, query = '/projects?code=' + encodeURIComponent(body.code);
    let previous = 'planning';
    for (const status of ['active', 'paused', 'completed', 'planning']) {
      const changed = { ...body, status };
      const saved = await api('PUT', route, changed);
      check('项目台账', '通用PUT返回实际保存状态 ' + status, ok(saved) && saved.data?.status === status, saved.data?.status, status);
      const detail = await api('GET', route), list = await api('GET', query);
      check('项目台账', '重新读取详情和列表状态一致 ' + status,
        ok(detail) && detail.data?.status === status && ok(list) && list.data?.total === 1 && list.data.list[0].status === status,
        { detail: detail.data?.status, list: list.data?.list?.map(p => p.status) }, status);
      const filtered = await api('GET', query + '&status=' + status), old = await api('GET', query + '&status=' + previous);
      check('项目台账', '状态变更同步新旧筛选结果 ' + status,
        ok(filtered) && filtered.data?.total === 1 && ok(old) && old.data?.total === 0,
        { current: filtered.data?.total, previous: old.data?.total });
      previous = status;
    }
    const { status, ...withoutStatus } = body;
    const renamed = { ...withoutStatus, name: body.name + '改名' };
    q = await api('PUT', route, renamed);
    check('项目台账', '旧客户端省略状态时不覆盖原状态', ok(q) && q.data?.status === previous && q.data.name === renamed.name, q.data);
    for (const invalid of ['', 'unknown', 'inactive']) {
      q = await api('PUT', route, { ...body, status: invalid });
      check('项目台账', '非法状态明确拒绝 ' + JSON.stringify(invalid), q.http === 400, q);
    }
    q = await api('PUT', route, { ...body, status: 'active' }, author);
    check('项目台账', '普通用户禁止修改项目状态', q.http === 403, q);
    q = await api('GET', route);
    check('项目台账', '失败请求未部分覆盖状态与名称', ok(q) && q.data?.status === previous && q.data.name === renamed.name, q.data);
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=', 'base64');
  q = await upload('模拟现场图.png', png, 'image/png', author); check('工程资料目录与上传', 'multipart照片上传与UUID存储', ok(q) && !!q.data?.url, q); photo = q.data?.url;
  q = await upload('模拟检查说明.txt', 'QA22 模拟检查附件：保护层25mm，复查完成。非真实工程资料。', 'text/plain', author); check('工程资料目录与上传', '文字附件上传', ok(q) && !!q.data?.url, q); doc = q.data?.url;
  if (!photo || !doc) throw new Error('上传前置失败');
  q = await upload('禁止类型.exe', 'QA22 inert test content', 'application/octet-stream', author); check('工程资料目录与上传', '非白名单扩展名拒绝', err4(q), q);
  q = await upload('空文件.txt', '', 'text/plain', author); check('工程资料目录与上传', '空文件拒绝', err4(q), q);
  const unit = await create('工程资料目录与上传', '/sub-item-databases', { projectId: project.id, name: run + 'A楼单位工程', sortOrder: 1 });
  const division = await create('工程资料目录与上传', '/sub-item-databases', { projectId: project.id, parentId: unit.id, name: '主体结构分部工程', sortOrder: 1 });
  leaf = await create('工程资料目录与上传', '/sub-item-databases', { projectId: project.id, parentId: division.id, name: '钢筋分项工程', sortOrder: 1 });
  q = await api('GET', '/sub-item-databases/tree?projectId=' + project.id, null, author); check('工程资料目录与上传', '单位/分部/分项三级资料树', ok(q) && q.data[0]?.children[0]?.children[0]?.id === leaf.id, q.data);
  q = await api('GET', '/sub-item-databases/' + leaf.id, null, outsider); check('工程资料目录与上传', '其他项目用户不能读取资料目录', q.http === 403, q);
  q = await api('POST', '/project-documents', { projectId: project.id, name: '缺目录', filePath: doc }, author); check('工程资料目录与上传', '资料必须关联有效子项', q.http === 400, q);
  const pd = await create('工程资料目录与上传', '/project-documents', { projectId: project.id, subItemId: leaf.id, name: run + '隐蔽验收说明', filePath: doc, fileType: 'txt' }, author);
  q = await api('GET', '/project-documents/' + pd.id, null, outsider); check('工程资料目录与上传', '跨项目文档详情拒绝', q.http === 403, q);
  q = await upload('模拟专项说明.txt', 'QA22 钢筋隐蔽验收专项说明。', 'text/plain', author, '/project-documents/upload?projectId=' + project.id + '&subItemId=' + leaf.id); check('工程资料目录与上传', '工程资料专用上传接口', ok(q) && q.data.subItemId === leaf.id, q.data);
  for (const [module, kind] of [['监理日记', 'supervision-diaries'], ['监理日志', 'supervision-logs'], ['旁站检查', 'sideline-inspections']]) await group(module, () => fieldFlow(module, kind));
  await group('日常巡检', () => dailyMemoFlow('日常巡检', 'daily-inspections'));
  const createdWithReadOnlyRole = await api('GET', '/supervision-diaries?projectId=' + project.id, null, author);
  check('权限设置', '仅查看权限角色不应能创建/编辑日记', ok(createdWithReadOnlyRole) && createdWithReadOnlyRole.data.total === 0, { created: createdWithReadOnlyRole.data?.total, assignedPermissions: [permission.code] }, '模块权限矩阵应参与服务端授权');
  await group('工程资料目录与上传', async () => {
    q = await api('GET', '/files/access?url=' + encodeURIComponent(photo), null, outsider); check('工程资料目录与上传', '跨项目不可获取附件签名', q.http === 403, q);
    q = await api('GET', '/files/access?url=' + encodeURIComponent(photo), null, reviewer); check('工程资料目录与上传', '项目审核人可预览已提交记录照片', ok(q) && !!q.data.url, { http: q.http, code: q.code });
    const signed = new URL(q.data.url, base); const file = await fetch(signed, { signal: AbortSignal.timeout(10000) });
    const bytes = Buffer.from(await file.arrayBuffer()); check('工程资料目录与上传', '签名附件返回原文件且禁止公共缓存', file.status === 200 && bytes.equals(png) && file.headers.get('cache-control')?.includes('no-store'), { http: file.status, bytes: bytes.length, type: file.headers.get('content-type'), cache: file.headers.get('cache-control') });
    const bad = await fetch(signed.href + 'x'); check('工程资料目录与上传', '签名篡改被拒绝', bad.status === 403, { http: bad.status });
    const raw = await fetch(new URL(photo, base)); check('工程资料目录与上传', '原始上传路径不能匿名直出', [401, 403, 404].includes(raw.status), { http: raw.status });
    await api('PUT', '/projects/' + project.id + '/members', { userId: reviewerUser.id, enabled: false, canReview: false });
    try { const revoked = await fetch(signed); check('工程资料目录与上传', '撤销项目成员后原签名链接立即失效', revoked.status === 403, { http: revoked.status }); }
    finally { await api('PUT', '/projects/' + project.id + '/members', { userId: reviewerUser.id, enabled: true, canReview: true }); }
  });
  await group('统计报表', async () => {
    const source = await api('GET', '/field/diary-source?projectId=' + project.id + '&date=' + date, null, author); check('统计报表', '当日取数仅含已通过日记', ok(source) && source.data.sources.length === 1, source.data);
    q = await api('GET', '/field/diary-source?projectId=' + project.id + '&date=2026-09-24', null, author); check('统计报表', '次日不混入当日日记', ok(q) && q.data.sources.length === 0, q.data);
    const summary = await api('GET', '/field/summary?projectId=' + project.id + '&date=' + date, null, author);
    check('统计报表', '每日摘要按四类业务及真实状态计数（巡检只计草稿与已保存）',
      ok(summary) && ['supervision-diaries', 'supervision-logs', 'daily-inspections', 'sideline-inspections'].every(k => {
        const e = k === 'daily-inspections'
          ? { draft: 1, recorded: 2, submitted: 0, approved: 0, rejected: 0 }
          : { approved: 1, draft: 2, submitted: 1, rejected: 1 };
        return Object.keys(e).every(s => summary.data[k][s] === e[s]);
      }), summary.data);
    const generated = await create('监理日志', '/supervision-logs', { ...business('supervision-logs', '-source'), content: source.data.content, diarySources: JSON.stringify(source.data.sources) }, author, key());
    check('监理日志', '日记取数日志持久化且来源可追溯', JSON.parse(generated.diarySources)[0].id === source.data.sources[0].id, generated);
    q = await api('POST', '/supervision-logs', { ...business('supervision-logs', '-badsource'), logDate: '2026-09-24', diarySources: JSON.stringify(source.data.sources) }, author, key()); check('监理日志', '跨日日记来源拒绝', q.http === 409, q);
    const weekly = await api('GET', '/supervision-diaries?projectId=' + project.id + '&dateFrom=2026-09-21&dateTo=2026-09-27&status=approved', null, author);
    check('统计报表', '周范围真实记录可查询（不等同周报生成）', ok(weekly) && weekly.data.total === 1, weekly.data);
    fs.writeFileSync(path.join(out, '模拟日报周汇总.json'), JSON.stringify({ note: '由测试器根据真实接口生成的对账资料，不是系统已实现周报生成能力', daily: summary.data, weekly: { from: '2026-09-21', to: '2026-09-27', approvedDiaries: weekly.data.total, sourceIds: weekly.data.list.map(x => x.id) } }, null, 2));
    note('统计报表', '正式周报自动生成/定版/导出', '功能尚未实现', '未发现独立周报生成端点；周范围查询与测试器汇总不能冒充正式周报。');
  });
  for (const [module, kind, dateField] of [['安全日志', 'safety-logs', 'logDate'], ['会议纪要', 'meeting-minutes', 'meetingDate'], ['监理月报', 'supervision-monthly-reports', 'reportMonth'], ['监理通知单', 'supervision-notices', 'noticeDate'], ['工作联系单', 'work-contacts', 'contactDate']]) await group(module, async () => {
    const body = { projectId: project.id, code: run + '-' + kind.slice(0, 6), [dateField]: dateField === 'reportMonth' ? '2026-09' : date, title: run + module + '模拟记录', content: '模拟工程：完成钢筋隐蔽检查1次；问题1项，要求补设垫块并复查。', inspection: '临边防护完整', safety: '未发生安全事故（模拟）', attendees: '模拟总监、施工负责人', location: '项目会议室', deadline: '2026-09-25', photos: JSON.stringify([{ url: photo, description: '模拟图' }]), attachments: JSON.stringify([{ url: doc }]), weather: '晴' };
    let record = await create(module, '/' + kind, body, author); const route = '/' + kind + '/' + record.id;
    q = await api('GET', route, null, outsider); check(module, '跨项目详情访问被拒绝', q.http === 403, q);
    q = await api('PUT', route, { ...body, content: body.content + '补充复查说明。' }, author); check(module, '编辑正文持久化', ok(q) && q.data.content.includes('补充复查'), q.data);
    q = await api('GET', '/' + kind + '?projectId=' + project.id + '&code=' + encodeURIComponent(record.code) + '&pageSize=1', null, author); check(module, '项目及编号过滤/分页', ok(q) && q.data.total === 1 && q.data.list[0].id === record.id, q.data);
    q = await api('POST', '/' + kind, body, author); check(module, '重复单据编号拒绝', err4(q), q);
    if (kind === 'safety-logs') {
      q = await api('PUT', route, { ...body, status: 'submitted' }, author); check(module, '表单提交应进入待审核', ok(q) && q.data.status === 'submitted', q.data?.status, 'submitted');
      q = await api('POST', route + '/approve', { status: 'approved' }, reviewer); check(module, '项目授权总监无需管理员也应可审核', ok(q), q, 'HTTP200');
      q = await api('POST', route + '/approve', { status: 'approved' }); check(module, '不应跳过提交直接审核草稿', q.http === 409 || q.http === 400, q.data, '拒绝草稿直接审核');
      q = await api('PUT', route, { ...body, content: '测试：审核后尝试覆盖正文' }, author); check(module, '已审核正文不可直接覆盖', q.http === 409, q.data);
      const rejected = await create(module, '/' + kind, { ...body, code: body.code + '-reject' }, author);
      q = await api('POST', '/' + kind + '/' + rejected.id + '/approve', { status: 'rejected', rejectReason: '补全复查结论' }); check(module, '退回样本保存', ok(q) && q.data.status === 'rejected', q.data);
      q = await api('PUT', '/' + kind + '/' + rejected.id, { ...body, code: rejected.code, status: 'submitted' }, author); check(module, '退回修改后应可再提交', ok(q) && q.data.status === 'submitted', q.data?.status);
      note(module, '历史快照接口', '功能尚未实现', '仅普通version字段；控制器未暴露历史快照/修订入口。');
    }
    if (kind === 'supervision-notices' || kind === 'work-contacts') {
      const issued = kind === 'supervision-notices' ? 'issued' : 'sent';
      q = await api('PUT', route, { ...body, status: issued }, author); check(module, '草稿通过页面更新转为下发/发送', ok(q) && q.data.status === issued, q.data?.status, issued);
      const sent = await create(module, '/' + kind, { ...body, code: body.code + '-sent', status: issued }, author);
      q = await api('POST', '/' + kind + '/' + sent.id + '/reply', { replyContent: '已增设垫块，复查符合要求（模拟回复）' }, reviewer); check(module, '已下发/发送记录回复', ok(q) && ['responded', 'replied'].includes(q.data.status), q.data);
      const replied = q.data;
      q = await api('PUT', '/' + kind + '/' + sent.id, { ...body, code: sent.code, status: 'verified' }, author); check(module, '回复后验证闭环状态应持久化', ok(q) && q.data.status === 'verified', q.data?.status, 'verified');
      q = await api('POST', '/' + kind, { ...body, code: body.code + '-skip', status: 'verified' }, author); check(module, '不能创建即伪造已验证状态', err4(q), q.data);
      q = await api('PUT', '/' + kind + '/' + sent.id, { ...body, code: sent.code, content: '已回复后覆盖原通知内容' }, author); check(module, '已下发/回复记录应锁定原正文', q.http === 409 || q.http === 400, q.data);
      check(module, '回复状态契约一致性', replied?.status === (kind === 'supervision-notices' ? 'responded' : 'replied'), { expectedExistingApi: kind === 'supervision-notices' ? 'responded' : 'replied', actual: replied?.status });
    }
    if (kind === 'supervision-monthly-reports') note(module, '从确认记录自动生成月报', '功能尚未实现', '当前仅人工正文CRUD；本轮已录入模拟月报，不能视为自动生成。');
  });
  await group('消息中心', async () => {
    const message = await create('消息中心', '/messages', { senderId: reviewerUser.id, receiverId: authorUser.id, title: run + '待复查通知', content: '请于9月25日前复查垫块布设（模拟）', type: 'notice' });
    q = await api('GET', '/messages?receiverId=' + authorUser.id, null, author); check('消息中心', '收件人可分页查询模拟通知', ok(q) && q.data.list.some(x => x.id === message.id), q.data);
    q = await api('GET', '/messages/unread-count?receiverId=' + authorUser.id, null, author); check('消息中心', '未读数量正确', ok(q) && q.data === 1, q.data);
    q = await api('GET', '/messages/' + message.id, null, outsider); check('消息中心', '非收件人禁止查看消息', q.http === 403, q);
    q = await api('GET', '/messages?receiverId=' + authorUser.id, null, outsider); check('消息中心', '不能指定他人receiverId读取消息', q.http === 403 || (ok(q) && q.data.total === 0), q.data);
    q = await api('PUT', '/messages/' + message.id + '/read', null, outsider); check('消息中心', '非收件人不能代标已读', q.http === 403, q);
    q = await api('PUT', '/messages/' + message.id + '/read', null, author); check('消息中心', '本人标记已读', ok(q), q);
    q = await api('GET', '/messages/unread-count?receiverId=' + authorUser.id, null, author); check('消息中心', '已读后未读数量归零', ok(q) && q.data === 0, q.data);
  });
  await group('工作标准配置', async () => {
    const body = { name: run + '日记提交截止', module: 'supervision-diary', standard: '18:00', description: '仅模拟配置，不代表定时提醒已启用' };
    const setting = await create('工作标准配置', '/work-standard-configs', body);
    q = await api('GET', '/work-standard-configs?name=' + encodeURIComponent(run)); check('工作标准配置', '标准按名称检索', ok(q) && q.data.list.some(x => x.id === setting.id), q.data);
    q = await api('PUT', '/work-standard-configs/' + setting.id, { ...body, standard: '17:30' }); check('工作标准配置', '管理员更新标准', ok(q) && q.data.standard === '17:30', q.data);
    q = await api('PUT', '/work-standard-configs/' + setting.id, { ...body, standard: '16:00' }, author); check('工作标准配置', '普通用户不能更改全局标准', q.http === 403, q.data);
    note('工作标准配置', '定时催办/工作日调度效果', '功能尚未实现', '当前为普通配置记录，未发现相应定时执行器；配置成功不能证明提醒生效。');
  });
  await group('操作日志', async () => {
    q = await api('GET', '/operation-logs?pageSize=200'); check('操作日志', '管理员操作日志列表可查询', ok(q) && Array.isArray(q.data?.list), q.data);
    const scoped = await api('GET', '/operation-logs?userName=' + encodeURIComponent(authorUser.name) + '&pageSize=200');
    check('操作日志', '本轮作者创建/提交应写入全局审计日志', ok(scoped) && scoped.data.total > 0, { total: scoped.data?.total, existingAuthorizationLogs: q.data?.total, sample: q.data?.list.slice(0, 2) }, '应存在测试作者业务操作，而不只有管理员成员授权事件');
  });
  await group('仪表盘', async () => {
    q = await api('GET', '/dashboard/stats', null, author); check('仪表盘', '统计接口返回真实退回计数', ok(q) && q.data.abnormalDiaries === 1 && q.data.abnormalLogs === 1, q.data);
    q = await api('GET', '/dashboard/stats', null, outsider); check('仪表盘', '其他项目不能计入本项目退回记录', ok(q) && q.data.abnormalDiaries === 0 && q.data.abnormalLogs === 0, q.data);
  });
  await group('监理日记', async () => {
    const input = { ...business('supervision-diaries', '-concurrent'), diaryDate: '2026-09-22' }, h = key();
    const simultaneous = await Promise.all(Array.from({ length: 4 }, () => api('POST', '/supervision-diaries', input, author, h)));
    check('监理日记', '四个并发同键创建只生成一张单', simultaneous.every(ok) && new Set(simultaneous.map(x => x.data?.id)).size === 1, simultaneous.map(x => ({ http: x.http, id: x.data?.id })));
    const r = simultaneous[0].data;
    if (r) { q = await api('DELETE', '/supervision-diaries/' + r.id, null, author, ver(r)); check('监理日记', '本人可删除临时草稿', ok(q), q); q = await api('GET', '/supervision-diaries/' + r.id, null, author); check('监理日记', '删除草稿后不可读取', q.http === 404, q); }
    q = await api('POST', '/supervision-diaries', { ...business('supervision-diaries', '-no-photo'), photos: '[]', status: 'submitted' }, author, key()); check('监理日记', '缺现场照片不能正式提交', q.http === 400, q);
  });
  await group('部门管理', async () => {
    const scratch = await create('部门管理', '/departments', { name: run + '临时空部门', parentId: root.id });
    q = await api('PUT', '/departments/' + scratch.id, { name: run + '临时空部门已更名', parentId: root.id }); check('部门管理', '部门更名持久化', ok(q) && q.data.name.endsWith('已更名'), q.data);
    q = await api('DELETE', '/departments/' + scratch.id); check('部门管理', '空部门可删除', ok(q), q);
    q = await api('DELETE', '/departments/' + team.id); check('部门管理', '存在成员的部门禁止删除', err4(q), q);
  });
  await group('人员管理', async () => {
    await api('PUT', '/users/' + outsiderUser.id + '/status?status=inactive');
    try { q = await api('GET', '/projects', null, outsider); check('人员管理', '禁用人员后旧令牌不能访问项目', [401, 403].includes(q.http), q); }
    finally { await api('PUT', '/users/' + outsiderUser.id + '/status?status=active'); }
  });
  await group('个人资料与设置', async () => {
    q = await api('GET', '/auth/info', null, author); check('个人资料与设置', '个人身份接口与实际账号一致', ok(q) && q.data.userName === authorUser.name && !q.data.roles.includes('admin'), q.data);
    note('个人资料与设置', '浏览器个人设置保存及头像裁剪', '受阻', '遵循本轮不进入凭据/个人设置表单限制，未操作。');
  });
  await group('登录与认证', async () => {
    q = await api('POST', '/auth/logout', null, outsider); check('登录与认证', '退出接口返回成功', ok(q), q);
    q = await api('GET', '/auth/info', null, outsider); note('登录与认证', '服务端主动撤销退出后的JWT', '功能尚未实现', { http: q.http, oldTokenStillValid: ok(q), explanation: '当前为无状态JWT设计；退出只清客户端，不代表服务端令牌撤销。' });
  });
  note('流程管理', '配置真实审批节点并驱动业务', '功能尚未实现', 'process-management.html仅本地演示，saveFlow显示alert，无控制器或持久化端点；未伪造成功样本。');
  const pages = ['index', 'welcome', 'project-ledger', 'daily-inspection', 'sideline-inspection', 'supervision-notice', 'work-contact', 'supervision-diary', 'supervision-log', 'safety-log', 'meeting-minutes', 'supervision-monthly-report', 'sub-item-database', 'project-data-upload', 'diary-statistics', 'log-statistics', 'safety-log-statistics', 'diary-report', 'message-center', 'department-management', 'personnel-management', 'permission-settings', 'process-management', 'operation-log', 'work-standard-config', 'login'];
  const availability = [];
  for (const name of pages) { const response = await fetch((process.env.QA22_STATIC_BASE || 'http://127.0.0.1:8091') + '/' + name + '.html'); const text = await response.text(); availability.push({ page: name + '.html', http: response.status, html: text.includes('<html'), note: '仅HTTP静态资源可用性；非浏览器功能验收' }); }
  fs.writeFileSync(path.join(out, '页面资源可用性.json'), JSON.stringify(availability, null, 2));
}
function finish(error) {
  if (!fs.existsSync(out)) return;
  if (error) note('环境', '执行中断', '受阻', error.message);
  const counts = {}; for (const r of results) counts[r.result] = (counts[r.result] || 0) + 1;
  fs.writeFileSync(path.join(out, '接口测试结果.json'), JSON.stringify({ run, base, time: new Date().toISOString(), counts, results }, null, 2));
  fs.writeFileSync(path.join(out, '请求记录.json'), JSON.stringify(requests, null, 2));
  fs.writeFileSync(path.join(out, '模拟数据清单.json'), JSON.stringify({ run, note: '有效数据与负向测试探针分开判断。随机测试密码/JWT未落盘；重跑使用新批次。H2服务停止后业务数据丢失。', fixtures }, null, 2));
  const cell = v => '"' + String(typeof v === 'object' ? JSON.stringify(v) : v ?? '').replace(/"/g, '""') + '"';
  fs.writeFileSync(path.join(out, '接口测试结果.csv'), '\uFEFF' + ['编号,模块,场景,结论,预期,实际', ...results.map(r => [r.id, r.module, r.title, r.result, r.expected, r.actual].map(cell).join(','))].join('\r\n'));
  console.log(JSON.stringify({ run, counts, fixtures: fixtures.length, requests: requests.length, out }, null, 2));
}
main().then(() => finish()).catch(e => { finish(e); console.error(e.message); process.exitCode = 1; });
