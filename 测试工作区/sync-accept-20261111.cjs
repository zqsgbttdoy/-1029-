'use strict';
// 2026-11-11 隔离实例专项验收：问题字段精简 + 点开即输入（静态资产）+ 巡检同步监理日记。
// 仅连接 18090/18091 隔离 e2e/H2 实例；finally 按基线清理全部测试数据。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const DailySync = require('../补后端/miniprogram/utils/daily-inspection-sync');
const base = process.env.SYNC_ACCEPT_BASE || 'http://127.0.0.1:18091/api';
const staticBase = process.env.SYNC_ACCEPT_STATIC || 'http://127.0.0.1:18091';
if (!/127\.0\.0\.1:1809/.test(base)) throw new Error('本脚本只允许连接 18090/18091 隔离实例');
const out = path.join(__dirname, '同步验收-20261111');
const run = 'SYNC-' + Date.now();
const results = [];
let admin, project;
const created = { 'daily-inspections': [], 'supervision-diaries': [] };
function check(title, ok, actual, expected = '') {
  results.push({ id: 'T' + String(results.length + 1).padStart(2, '0'), title, result: ok ? '通过' : '失败', expected, actual: actual ?? null });
  console.log((ok ? 'PASS ' : 'FAIL ') + title);
  return ok;
}
async function api(method, route, body, token = admin, headers = {}) {
  const h = { ...headers }; if (token) h.Authorization = 'Bearer ' + token;
  if (body != null && !(body instanceof FormData)) h['Content-Type'] = 'application/json';
  const response = await fetch(base + route, { method, headers: h, body: body == null ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await response.text(); let json; try { json = JSON.parse(text); } catch (_) { json = {}; }
  return { http: response.status, code: json.code, message: json.message, data: json.data };
}
const ok = r => r.http === 200 && r.code === 200;
const ver = r => ({ 'X-Record-Version': String(r.lockVersion) });
const key = () => ({ 'Idempotency-Key': randomUUID() });
const checklist = problems => JSON.stringify({ version: 1, items: [{ id: 'item-' + randomUUID().slice(0, 8), content: '检查临边防护', result: 'noncompliant', problems }] });
const dailyBody = (problems, suffix) => ({ projectId: project.id, code: run + suffix, inspectionDate: '2026-11-10', location: '三层临边', content: '巡视原文', startTime: '2026-11-10T08:30:00', workerCount: 5, manageCount: 2, checklist: checklist(problems), photos: '[]', attachments: '[]' });
async function createDaily(problems, suffix) {
  const r = await api('POST', '/daily-inspections', dailyBody(problems, suffix), admin, key());
  if (!ok(r)) throw new Error('创建巡检失败 ' + suffix + ': ' + r.http + ' ' + r.message);
  created['daily-inspections'].push(r.data.id);
  return r.data;
}
const problemOf = record => JSON.parse(record.checklist).items[0].problems[0];
async function main() {
  fs.mkdirSync(out, { recursive: true });
  // ---------- 登录与基线 ----------
  const auth = await api('POST', '/auth/login', { username: 'admin', password: process.env.SYNC_ADMIN_PASSWORD || '123456' }, null);
  if (!ok(auth) || !auth.data?.token) throw new Error('隔离实例 admin 登录失败：' + auth.http + ' ' + auth.message);
  admin = auth.data.token;
  check('隔离实例 admin 登录成功', true, { userId: auth.data.userId });
  const baseline = await api('GET', '/projects?pageSize=200');
  const baselineProjects = baseline.data.total;
  project = (await api('POST', '/projects', { code: run, name: run + '同步验收项目', buildUnit: '模拟建设单位', type: '房屋建筑', startDate: '2026-01-01', endDate: '2026-12-31' })).data;
  if (!project?.id) throw new Error('测试项目创建失败');
  // ---------- A. 问题字段精简（后端真实落库） ----------
  const minimal = await createDaily([{ id: 'p-min', description: '防护松动，已要求立即加固', attachments: [] }], '-min');
  const savedMin = problemOf(minimal);
  check('A1 仅说明的新结构可创建，落库不重建 name/type', !('name' in savedMin) && !('type' in savedMin) && savedMin.description === '防护松动，已要求立即加固', savedMin);
  let r = await api('POST', '/daily-inspections/' + minimal.id + '/submit', null, admin, ver(minimal));
  check('A2 仅说明结构提交即保存（recorded）', ok(r) && r.data.status === 'recorded', r.data?.status);
  const recorded = r.data;
  const edited = checklist([{ id: 'p-min', description: '防护已加固并复查合格', attachments: [] }]);
  r = await api('PUT', '/daily-inspections/' + minimal.id, { checklist: edited }, admin, ver(recorded));
  const savedEdit = ok(r) ? problemOf(r.data) : null;
  check('A3 已保存巡检再编辑仍仅存说明且保持 recorded', ok(r) && r.data.status === 'recorded' && savedEdit.description === '防护已加固并复查合格' && !('name' in savedEdit) && !('type' in savedEdit), { status: r.data?.status, problem: savedEdit });
  const legacy = await createDaily([{ id: 'p-old', name: '防护缺失', type: '安全问题', description: '历史问题说明', attachments: [] }], '-legacy');
  const savedOld = problemOf(legacy);
  check('A4 历史 name/type 原样保留不被丢弃', savedOld.name === '防护缺失' && savedOld.type === '安全问题' && savedOld.description === '历史问题说明', savedOld);
  r = await api('POST', '/daily-inspections/' + legacy.id + '/submit', null, admin, ver(legacy));
  check('A5 历史记录提交不受字段下线影响', ok(r) && r.data.status === 'recorded', r.data?.status);
  const legacyNoDesc = await createDaily([{ id: 'p-old2', name: '老问题名称', type: '安全问题', description: '', attachments: [] }], '-legacy2');
  r = await api('POST', '/daily-inspections/' + legacyNoDesc.id + '/submit', null, admin, ver(legacyNoDesc));
  check('A6 空说明（仅旧名称）也可提交，名称必填已下线', ok(r) && r.data.status === 'recorded', { http: r.http, message: r.message });
  r = await api('POST', '/daily-inspections', dailyBody([{ id: 'p-bad', description: 'x', type: '未知类型', attachments: [] }], '-badtype'), admin, key());
  check('A7 历史类型字段仍做枚举校验（非法类型拒绝）', r.http === 400 && /类型/.test(r.message || ''), { http: r.http, message: r.message });
  // ---------- B. 巡检同步监理日记（真实同步模块 + 真实接口落库） ----------
  const fresh = await api('GET', '/daily-inspections/' + minimal.id);
  const record = fresh.data;
  const merged = DailySync.merge(record, {}, []);
  check('B1 同步工作栏含检查项与不符合结果', /检查项：/.test(merged.blocks.inspection) && /检查结果：不符合/.test(merged.blocks.inspection), merged.blocks.inspection);
  check('B2 同步问题栏只输出“问题说明”且无名称/类型行', /问题说明：防护已加固并复查合格/.test(merged.blocks.newIssues) && !/问题名称|问题类型/.test(merged.blocks.newIssues), merged.blocks.newIssues);
  const diaryBody = { projectId: project.id, diaryDate: '2026-11-10', weather: '晴', inspection: merged.body.inspection, newIssues: merged.body.newIssues, photos: merged.body.photos };
  r = await api('POST', '/supervision-diaries', diaryBody, admin, key());
  if (!ok(r)) throw new Error('同步日记创建失败：' + r.message);
  created['supervision-diaries'].push(r.data.id);
  const diary = (await api('GET', '/supervision-diaries/' + r.data.id)).data;
  check('B3 同步正文真实落库且读取一致', diary.inspection === merged.body.inspection && diary.newIssues === merged.body.newIssues, { inspection: diary.inspection?.slice(0, 60), newIssues: diary.newIssues?.slice(0, 80) });
  const again = DailySync.merge(record, { inspection: diary.inspection, newIssues: diary.newIssues, photos: diary.photos }, diary.photos);
  check('B4 重复同步幂等不追加', again.addedText === 0 && again.body.inspection === diary.inspection && again.body.newIssues === diary.newIssues, { addedText: again.addedText });
  const legacyRecord = (await api('GET', '/daily-inspections/' + legacyNoDesc.id)).data;
  const legacySync = DailySync.sections(legacyRecord);
  check('B5 旧记录空说明回退旧名称同步', /问题说明：老问题名称/.test(legacySync.newIssues), legacySync.newIssues);
  // 照片同步：上传 1x1 PNG 作为巡检现场照片，merge 后并入日记照片区
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=', 'base64');
  const form = new FormData(); form.append('file', new Blob([png], { type: 'image/png' }), '巡检现场.png');
  const up = await api('POST', '/files/upload', form);
  if (!ok(up)) throw new Error('照片上传失败：' + up.message);
  const withPhoto = DailySync.merge(Object.assign({}, record, { syncPhotos: [{ url: up.data.url, name: '巡检现场.png', size: png.length }] }), { inspection: diary.inspection, newIssues: diary.newIssues, photos: diary.photos }, diary.photos);
  const syncedPhotos = JSON.parse(withPhoto.body.photos);
  check('B6 巡检照片并入日记照片区且带来源标记', withPhoto.addedPhotos === 1 && syncedPhotos.some(p => p.url === up.data.url && p.source === 'daily-inspection' && p.sourceId === record.id), syncedPhotos);
  r = await api('PUT', '/supervision-diaries/' + diary.id, { photos: withPhoto.body.photos }, admin, ver(diary));
  check('B7 同步照片真实落库', ok(r) && JSON.parse(r.data.photos).some(p => p.source === 'daily-inspection'), { http: r.http });
  // ---------- C. 点开即输入（前端交互已由 Node 129 项覆盖，此处核对隔离站实际 served 资产） ----------
  const asset = await (await fetch(staticBase + '/assets/inspection-checklist.js', { signal: AbortSignal.timeout(10000) })).text();
  check('C1 隔离站 PC 资产为点开即输入版本', /const quick = editable\(\)/.test(asset) && /无需再次添加/.test(asset), { quick: /const quick = editable\(\)/.test(asset), hint: /无需再次添加/.test(asset) });
  check('C2 PC 问题面板不再渲染名称/类型字段', !/问题名称|问题类型/.test(asset) && /data-problem-field="description"/.test(asset), null);
  const page = await (await fetch(staticBase + '/daily-inspection.html', { signal: AbortSignal.timeout(10000) })).text();
  check('C3 巡检页面可访问且引用检查项组件', page.includes('<html') && /inspection-checklist\.js/.test(page), { http: page.includes('<html') });
  // ---------- 清理：先软删记录并核对无残留，再删项目（项目软删后按 projectId 查记录会 403） ----------
  await cleanupRecords();
  for (const kind of Object.keys(created)) {
    const list = await api('GET', '/' + kind + '?projectId=' + project.id + '&pageSize=200');
    check('D1 清理后 ' + kind + ' 无残留', ok(list) && list.data.total === 0, { http: list.http, total: list.data?.total });
  }
  await cleanupProject();
  const after = await api('GET', '/projects?pageSize=200');
  check('D2 清理后项目数回到基线', after.data.total === baselineProjects, { before: baselineProjects, after: after.data.total });
}
async function cleanupRecords() {
  for (const kind of Object.keys(created)) {
    for (const id of created[kind]) {
      const detail = await api('GET', '/' + kind + '/' + id);
      if (!ok(detail)) continue; // 已不存在
      const del = await api('DELETE', '/' + kind + '/' + id, null, admin, ver(detail.data));
      if (!ok(del)) console.log('清理失败 ' + kind + '/' + id + ': ' + del.http + ' ' + del.message);
    }
  }
}
async function cleanupProject() {
  if (project?.id) {
    const del = await api('DELETE', '/projects/' + project.id);
    if (!ok(del)) console.log('清理项目失败: ' + del.http + ' ' + del.message);
  }
}
function finish(error) {
  if (error) { results.push({ id: 'ERR', title: '执行中断', result: '受阻', actual: error.message }); console.error('中断：' + error.message); }
  const counts = {}; for (const r of results) counts[r.result] = (counts[r.result] || 0) + 1;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, '验收结果.json'), JSON.stringify({ run, base, time: new Date().toISOString(), counts, results }, null, 2));
  console.log(JSON.stringify({ run, counts, out }, null, 2));
  if (counts['失败'] || counts['受阻']) process.exitCode = 1;
}
main().then(() => finish()).catch(async e => { try { await cleanupRecords(); await cleanupProject(); } catch (_) {} finish(e); });