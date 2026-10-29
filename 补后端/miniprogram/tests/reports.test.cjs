// 运行：node --test 补后端/miniprogram/tests/reports.test.cjs
// 直接引入 utils/reports.js（纯逻辑，无 wx 依赖），验证日期偏移、分页取数与聚合规则。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const reports = require('../utils/reports');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const schema = require('../utils/schema');

test('shiftDate 跨月跨年且拒绝非法格式', () => {
  assert.equal(reports.shiftDate('2026-01-05', -6), '2025-12-30');
  assert.equal(reports.shiftDate('2026-02-28', 1), '2026-03-01');
  assert.equal(reports.shiftDate('2024-02-28', 1), '2024-02-29');
  assert.equal(reports.shiftDate('2026-12-31', 1), '2027-01-01');
  assert.throws(() => reports.shiftDate('2026-1-5', 0), /YYYY-MM-DD/);
  assert.throws(() => reports.shiftDate('abc', 0), /YYYY-MM-DD/);
});

test('fetchAll 取完所有分页后停止，不静默少计', async () => {
  const pages = [
    { list: [{ id: 1 }, { id: 2 }], total: 5 },
    { list: [{ id: 3 }, { id: 4 }], total: 5 },
    { list: [{ id: 5 }], total: 5 }
  ];
  const calls = [];
  const request = async (path, method, params) => { calls.push(params); return pages.shift(); };
  const list = await reports.fetchAll(request, '/supervision-diaries', { projectId: 9 });
  assert.deepEqual(list.map(r => r.id), [1, 2, 3, 4, 5]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].projectId, 9);
  assert.equal(calls[1].pageNum, 2);
});

test('fetchAll 遇到空页立即返回，防止死循环', async () => {
  const request = async () => ({ list: [], total: 999 });
  assert.deepEqual(await reports.fetchAll(request, '/x', {}), []);
});

test('aggregate 统计状态分布并按作者去重工作日', () => {
  const records = [
    { authorId: 1, status: 'approved', diaryDate: '2026-09-21' },
    { authorId: 1, status: 'approved', diaryDate: '2026-09-21' },
    { authorId: 1, status: 'draft', diaryDate: '2026-09-22' },
    { authorId: 2, status: 'rejected', logDate: '2026-09-22' },
    { authorId: 2, status: 'submitted', inspectionDate: '2026-09-23' }
  ];
  const result = reports.aggregate(records);
  assert.equal(result.total, 5);
  assert.deepEqual(result.statusCounts, { approved: 2, draft: 1, rejected: 1, submitted: 1 });
  assert.deepEqual(result.authors.map(a => a.authorId), ['1', '2']);
  assert.equal(result.authors[0].total, 3);
  assert.equal(result.authors[0].workDays, 2, '同人同日两条记录只能计两个工作日中的两天');
  assert.equal(result.authors[0].approved, 2);
  assert.equal(result.authors[1].workDays, 2);
  assert.equal(result.authors[1].rejected, 1);
});

test('aggregate 处理空输入与缺失作者', () => {
  assert.deepEqual(reports.aggregate([]), { total: 0, statusCounts: {}, authors: [] });
  const result = reports.aggregate([{ status: 'approved' }]);
  assert.equal(result.authors[0].authorId, 'unknown');
  assert.equal(result.authors[0].workDays, 0);
});

test('aggregate 同数量作者按 ID 稳定排序', () => {
  const result = reports.aggregate([
    { authorId: 9, status: 'draft', diaryDate: '2026-09-21' },
    { authorId: 3, status: 'draft', diaryDate: '2026-09-21' }
  ]);
  assert.deepEqual(result.authors.map(a => a.authorId), ['3', '9']);
});

test('formatDate 补零输出', () => {
  assert.equal(reports.formatDate(new Date(2026, 8, 5)), '2026-09-05');
});

test('电脑端日记报表取数与 CSV 保留全部规范正文、真实人员和旧记录', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../../diary-report.html'), 'utf8');
  assert.match(html, /src="miniprogram\/utils\/schema\.js"/);
  const record = { id: 12, projectId: 2, diaryDate: '2026-10-28', authorId: 3, authorName: '实际记录人', submittedBy: '旧显示名', reviewerId: 4, reviewerName: '项目总监', reviewedAt: '2026-10-28T18:00:00', status: 'approved', photos: '[]' };
  schema.schemas['supervision-diaries'].fields.forEach(([key, label]) => { record[key] = label + '正文'; });
  record.otherWork = '参加会议，审议"方案"\n配合业主';
  record.newIssues = '=待协调问题';
  const records = [record, { id: 13, projectId: 2, diaryDate: '2020-01-01', authorId: 8, status: 'draft', construction: '原有正文' }];
  const nodes = {}, calls = []; let blob;
  const element = () => ({ value: '', innerHTML: '', textContent: '', click() {} });
  const node = id => nodes[id] || (nodes[id] = element());
  const context = { window: {}, FieldSchema: schema, Blob, console,
    document: { getElementById: node, querySelector: node, createElement: element },
    URL: { createObjectURL: value => { blob = value; return 'blob:test'; }, revokeObjectURL() {} },
    alert: message => { throw new Error(message); },
    apiGetPage: async (url, params) => { calls.push({ url, params }); return { list: [records[params.pageNum - 1]], total: records.length }; }
  };
  vm.createContext(context);
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!script[1].includes('src=')) vm.runInContext(script[2], context);
  }
  context.projectsMap[2] = '测试工程'; context.usersMap[3] = '过期缓存名';
  await context.loadData();
  assert.equal(calls.length, 2); assert.equal(context.filteredData.length, 2);
  assert.equal(context.filteredData[0].record.materialInspection, '材料进场检查正文');
  assert.match(nodes.reportTableBody.innerHTML, /supervision-diary\.html\?readonly=true&id=12/);
  context.exportExcel();
  const csv = await blob.text();
  for (const [, label] of schema.schemas['supervision-diaries'].fields) assert.ok(csv.includes(label), label);
  for (const value of ['测试工程', '实际记录人', '项目总监', '2026-10-28T18:00:00', '材料进场检查正文', '用户#8', '原有正文', "'=待协调问题"]) assert.ok(csv.includes(value), value);
  assert.ok(csv.includes('"参加会议，审议""方案""\n配合业主"'));
  assert.doesNotMatch(csv, /旧显示名|过期缓存名|undefined/);
});

test('日志统计按真实记录生成只读入口，保留多条原文并转义人员与编号', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../../log-statistics.html'), 'utf8');
  const records = [
    { id: 101, projectId: 2, logDate: '2026-10-28', status: 'approved', code: '<日志一>', authorName: '安全工程师<甲>' },
    { id: 102, projectId: 2, logDate: '2026-10-28', status: 'submitted', code: '日志二', authorId: 8 },
    { id: 103, projectId: 2, logDate: '2026-10-28', status: 'draft', code: '未提交草稿' },
    { id: 104, projectId: 2, logDate: '2020-01-01', status: 'approved', code: '历史日志' },
    { id: '105" onclick="alert(1)', projectId: 2, logDate: '2026-10-28', status: 'submitted', code: '非法编号' },
    { id: 106, projectId: 2, logDate: '2026-10-28', status: 'rejected' }
  ];
  const nodes = {}, calls = [];
  const node = id => nodes[id] || (nodes[id] = { value: '', innerHTML: '', textContent: '', classList: { add() {} }, querySelector: selector => node(id + selector) });
  const context = { window: {}, console,
    App: { escape: value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) },
    document: { getElementById: node, querySelectorAll: () => [0, 1, 2, 3].map(i => node('card' + i)) },
    apiGetPage: async (url, params) => { calls.push({ url, params }); return { list: records.slice((params.pageNum - 1) * 2, params.pageNum * 2), total: records.length }; }
  };
  vm.createContext(context);
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!script[1].includes('src=')) vm.runInContext(script[2], context);
  }
  context.currentUser = '当前查看者'; context.projectsMap[2] = '测试工程';
  context.getTodayStr = () => '2026-10-28';
  await context.loadData();
  assert.equal(calls.length, 3); assert.ok(calls.every(c => c.url === '/supervision-logs'));
  context.viewSubmitDetail(0);
  const detail = nodes.detailModalBody.innerHTML;
  assert.match(detail, /supervision-log\.html\?readonly=true&id=101/);
  assert.match(detail, /supervision-log\.html\?readonly=true&id=102/);
  assert.match(detail, /supervision-log\.html\?readonly=true&id=106/);
  assert.match(detail, /&lt;日志一&gt; · 安全工程师&lt;甲&gt;/);
  assert.match(detail, /日志二 · 用户#8/); assert.match(detail, /原记录未记录人员/);
  assert.doesNotMatch(detail, /id=103|id=104|id=105|id=2"|onclick=|<日志一>|当前查看者|undefined/);
});
