'use strict';
// 非浏览器验收：执行页面原始内联脚本，使用可控DOM桩验证统计逻辑；不改动页面。
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..', '补后端');
const out = path.resolve(__dirname, process.argv[2] || 'QA22-page-checks');
if (!out.startsWith(__dirname + path.sep)) throw new Error('输出必须在测试工作区');
if (fs.existsSync(path.join(out, '页面脚本验证.json'))) throw new Error('输出目录已有测试证据，请使用新目录');
fs.mkdirSync(out, { recursive: true });
const results = [];
function check(page, title, valid, actual) { const r = { id: 'P' + String(results.length + 1).padStart(3, '0'), page, title, result: valid ? '通过' : '失败', actual }; results.push(r); console.log(r.id, r.result, page, title); }
const pages = ['index', 'welcome', 'project-ledger', 'daily-inspection', 'sideline-inspection', 'supervision-notice', 'work-contact', 'supervision-diary', 'supervision-log', 'safety-log', 'meeting-minutes', 'supervision-monthly-report', 'sub-item-database', 'project-data-upload', 'diary-statistics', 'log-statistics', 'safety-log-statistics', 'diary-report', 'message-center', 'department-management', 'personnel-management', 'permission-settings', 'process-management', 'operation-log', 'work-standard-config', 'login'];
function inline(page) { return Array.from(fs.readFileSync(path.join(root, page + '.html'), 'utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)).filter(m => !/\bsrc=/.test(m[1])).map(m => m[2]); }
for (const page of pages) { try { const scripts = inline(page); scripts.forEach(s => new vm.Script(s)); check(page, '内联JavaScript语法检查', true, { scripts: scripts.length }); } catch (e) { check(page, '内联JavaScript语法检查', false, e.message); } }
for (const f of ['assets/app.js', 'assets/field-records.js', 'miniprogram/utils/schema.js']) { try { new vm.Script(fs.readFileSync(path.join(root, f), 'utf8')); check(f, '共享脚本语法检查', true); } catch (e) { check(f, '共享脚本语法检查', false, e.message); } }
const fieldRecordsJs = fs.readFileSync(path.join(root, 'assets/field-records.js'), 'utf8');
check('assets/field-records.js', '记录类页面导出按钮统一使用“导出”文案',
  /const exportLabel = '导出';/.test(fieldRecordsJs)
  && /id="fwExport">' \+ exportLabel \+ '</.test(fieldRecordsJs)
  && !/导出筛选结果/.test(fieldRecordsJs));
// 全站导出按钮文案一致性：只允许“导出”或带明确格式的“导出Word”等，不允许旧的长文案
const exportLabels = [];
for (const page of pages) {
  const html = fs.readFileSync(path.join(root, page + '.html'), 'utf8');
  for (const m of html.matchAll(/<button\b[^>]*>([^<]*导出[^<]*)<\/button>/g)) exportLabels.push({ page, label: m[1].trim() });
}
const verboseExport = exportLabels.filter(b => /导出\s*(CSV|Excel|日志|筛选结果)/.test(b.label));
check('全部页面', '导出按钮文案已统一精简（无“导出CSV/导出Excel/导出日志/导出筛选结果”）', verboseExport.length === 0, verboseExport);
const exportPages = new Set(exportLabels.filter(b => /^📥\s*导出$/.test(b.label)).map(b => b.page));
check('全部页面', '日记报表、操作日志、安全日志与人员管理均使用“📥 导出”',
  ['diary-report', 'operation-log', 'safety-log', 'personnel-management'].every(p => exportPages.has(p)), exportLabels);
// 项目成员授权入口已下线：权限统一在权限设置页维护，记录页不得残留按钮、面板或遗留选择器
const memberLeftovers = ['assets/field-records.js', 'assets/field-records.css', ...pages.map(p => p + '.html')]
  .filter(f => /fwMembers|fwMemberPanel|fwMemberList|fwMemberId|fwMemberSave|项目成员授权/.test(fs.readFileSync(path.join(root, f), 'utf8')));
check('全部页面', '记录页“项目成员授权”入口、面板及遗留选择器已移除', memberLeftovers.length === 0, memberLeftovers);
check('assets/field-records.js', '记录页新建按钮只显示“新建”，不再拼接记录类型名',
  /id="fwNew">新建<\/button>/.test(fieldRecordsJs) && !/id="fwNew">新建' \+/.test(fieldRecordsJs));
check('assets/field-records.js', '关闭与取消直接关闭编辑器并丢弃未保存暂存，不经离开确认',
  /\$\('fwClose'\)\.onclick = dismissEditor; \$\('fwCancel'\)\.onclick = dismissEditor;/.test(fieldRecordsJs)
  && /const dismissEditor = run\(async \(\) => \{ removeDraft\(\); closeEditor\(\); dirty = false;/.test(fieldRecordsJs)
  && !/\$\('fwClose'\)\.onclick = leaveEditor/.test(fieldRecordsJs));
check('assets/field-records.js', '巡检旁站新建不再要求先选工具栏项目，改由表单项目下拉选择',
  /if \(hasTemplate && !\$\('fwProject'\)\.value && projects\.length > 1\)/.test(fieldRecordsJs)
  && /<option value="">请选择项目名称<\/option>/.test(fieldRecordsJs)
  && /请选择项目名称（工程名称）后再/.test(fieldRecordsJs)
  && !/if \(!\$\('fwProject'\)\.value && projects\.length > 1\)/.test(fieldRecordsJs));
function escape(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function environment(page, options) {
  const nodes = new Map(), calls = [], errors = [], downloads = [];
  function node(id) {
    if (!nodes.has(id)) { let html = '', text = ''; const classes = new Set(); nodes.set(id, { id, value: '', disabled: false, style: {}, dataset: {}, nextElementSibling: { textContent: '' }, classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); }, toggle(c) { if (classes.has(c)) classes.delete(c); else classes.add(c); } }, appendChild() {}, click() {}, addEventListener() {}, removeAttribute(name) { if (name === 'disabled' || name === 'aria-disabled') this.disabled = false; }, setAttribute(name, v) { if (name === 'disabled') this.disabled = v !== 'false'; }, querySelectorAll: () => [], querySelector: s => node(id + ' ' + s),
      get innerHTML() { return html; }, set innerHTML(v) { html = String(v); }, get textContent() { return text; }, set textContent(v) { text = String(v); html = escape(v); } }); }
    return nodes.get(id);
  }
  const document = { getElementById: node, createElement: tag => node('created-' + tag + '-' + nodes.size), querySelector: node, querySelectorAll: s => [0, 1, 2, 3].map(i => node(s + i)), addEventListener() {} };
  const context = { window: { location: { search: '' } }, document, App: { escape, toast() {} }, console: { log() {}, error: (...a) => errors.push(a.join(' ')) }, Date, JSON, String, Number, Math, Promise, URLSearchParams, Blob, alert: m => errors.push(m),
    URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:mock'; }, revokeObjectURL() {} },
    apiGetPage: async (route, params) => { calls.push({ route, params }); return { list: [], total: 0 }; } };
  vm.createContext(context);
  // 依赖 FieldSchema 的页面（如日记报表导出）需先注入真实共用模型，否则导出异常被 catch 吞掉而无法断言
  if (options && options.schema) {
    vm.runInContext(fs.readFileSync(path.join(root, 'miniprogram/utils/schema.js'), 'utf8'), context);
    context.FieldSchema = context.window.FieldSchema;
  }
  inline(page).forEach(s => vm.runInContext(s, context));
  return { context, node, calls, errors, downloads };
}
async function projectStatusChecks() {
  const page = 'project-ledger', s = environment(page), c = s.context, messages = [], calls = [];
  const copy = value => JSON.parse(JSON.stringify(value));
  let record = { id: 7101, code: 'QA-STATUS-7101', name: '模拟项目状态回归', buildUnit: '模拟建设单位',
    startDate: '2026-01-01', endDate: '2026-12-31', managerId: 9001, status: 'active' };
  c.window.App = c.App;
  c.App.toast = (message, type) => messages.push({ message, type });
  c.App.tableLoading = () => {};
  c.App.apiFetch = async (route, options) => {
    calls.push({ route, method: options?.method || 'GET', body: options ? copy(options.body) : null });
    if (options?.method === 'PUT') record = { ...record, ...copy(options.body) };
    return copy(record);
  };
  c.App.apiGetPage = async (route, params) => {
    calls.push({ route, method: 'GET', params: copy(params) });
    const list = !params.status || params.status === record.status ? [copy(record)] : [];
    return { list, total: list.length };
  };
  // 页面保存函数使用 then 回调且不返回 Promise，等待当前事件循环的微任务全部结束。
  const settled = () => new Promise(resolve => setImmediate(resolve));
  // 新建项目的两个下拉必须是可用态：无硬编码 disabled，且不再使用浏览器默认灰底外观。
  const ledgerHtml = fs.readFileSync(path.join(root, page + '.html'), 'utf8');
  const selectTags = Array.from(ledgerHtml.matchAll(/<select[^>]*id="(projectStatus|chiefEngineer)"[^>]*>/g)).map(m => m[0]);
  check(page, '项目状态与总监理师下拉未被硬编码禁用',
    selectTags.length === 2 && selectTags.every(tag => !/(^|\s)disabled(\s|=|>)/.test(tag)), selectTags);
  check(page, '下拉使用白底深色文字而非默认灰底',
    /\.form-group select\.form-control\s*\{[^}]*background-color:\s*#fff[^}]*color:\s*#1F2937/.test(ledgerHtml)
    && /\.form-group select\.form-control:disabled\s*\{/.test(ledgerHtml));
  s.node('projectStatus').disabled = true; s.node('chiefEngineer').disabled = true;
  c.openCreateModal();
  check(page, '新建弹窗打开时清除两个下拉的禁用状态并重置为未选择',
    s.node('projectStatus').disabled === false && s.node('chiefEngineer').disabled === false
    && s.node('projectStatus').value === '' && s.node('chiefEngineer').value === '');
  c.closeModal('createModal');
  await c.loadData();
  for (const [next, label] of [['paused', '已暂停'], ['completed', '已完成'], ['planning', '筹备中'], ['active', '进行中']]) {
    c.openEditModal(record.id);
    s.node('projectStatus').value = next;
    const start = calls.length;
    c.saveProject(); await settled();
    const sequence = calls.slice(start);
    check(page, '编辑状态准确传入通用PUT：' + next,
      sequence[0]?.route === '/projects/' + record.id && sequence[0]?.method === 'PUT' && sequence[0]?.body.status === next
      && sequence[0]?.body.managerId === 9001,
      sequence[0]);
    check(page, '保存后重新查询列表并更新中文状态：' + next,
      sequence[1]?.route === '/projects' && sequence[1]?.method === 'GET'
      && c.allData[0]?.status === next && s.node('tableBody').innerHTML.includes(label)
      && !s.node('createModal').classList.contains('show') && messages.at(-1)?.message === '保存成功');
    c.openEditModal(record.id);
    check(page, '再次编辑回显新状态：' + next, s.node('projectStatus').value === next);
    c.viewProject(record.id); await settled();
    check(page, '详情刷新展示新状态：' + next, s.node('view_status').innerHTML.includes(label));
    c.closeModal('viewModal');
  }
  s.node('statusFilter').value = 'active';
  c.openEditModal(record.id); s.node('projectStatus').value = 'paused';
  c.saveProject(); await settled();
  check(page, '保留旧状态筛选时变更后的项目从结果消失', c.allData.length === 0 && s.node('tableBody').innerHTML.includes('暂无匹配数据'));
  s.node('statusFilter').value = ''; await c.loadData();
  c.openEditModal(record.id); s.node('projectStatus').value = 'completed';
  const successCount = messages.filter(m => m.message === '保存成功').length, beforeFailure = calls.length;
  c.App.apiFetch = async () => { throw new Error('模拟接口保存失败'); };
  c.saveProject(); await settled();
  check(page, '保存失败不提示成功、不关闭编辑框、不刷新为未保存的状态',
    messages.filter(m => m.message === '保存成功').length === successCount
    && s.node('createModal').classList.contains('show') && calls.length === beforeFailure && c.allData[0].status === 'paused');
  let resolveOld;
  c.App.apiGetPage = () => new Promise(resolve => { resolveOld = resolve; });
  const old = c.loadData();
  c.App.apiGetPage = async () => ({ list: [{ ...record, status: 'completed' }], total: 1 });
  await c.loadData();
  resolveOld({ list: [{ ...record, status: 'active' }], total: 1 }); await old;
  check(page, '迟到的旧查询不会覆盖最新状态', c.allData[0].status === 'completed' && s.node('tableBody').innerHTML.includes('已完成'));
  check(page, '项目状态交互无脚本或局部渲染异常', s.errors.length === 0, s.errors);
}
async function workStandardChecks() {
  const page = 'work-standard-config', s = environment(page), c = s.context;
  c.window.App = c.App; c.App.toast = message => s.errors.push(message);
  const defaults = { diaryDeadline: '18:00', missingTime: 'next_day_morning', remindBefore: '60', noticeReplyDays: '3', urgeFrequency: 'daily', minInspection: '2', restDayRule: 'not_required' };
  Object.entries(defaults).forEach(([id, value]) => { s.node(id).value = value; });
  const sample = { id: 987, name: 'diaryDeadline', module: 'work-standard', standard: '17:30', updateTime: '2026-09-24T10:00:00' };
  c.apiGetPage = c.window.apiGetPage = async () => ({ list: [sample], total: 1 });
  await c.loadConfigs();
  check(page, '已存截止时间同步到控件和预览', s.node('diaryDeadline').value === '17:30' && s.node('previewDeadline').textContent === '17:30');
  check(page, '提前提醒按真实配置计算', s.node('previewReminder').textContent === '16:30' && s.node('previewLead').textContent === '60分钟');
  check(page, '缺失预览与选项一致', s.node('previewMissing').textContent === '次日 09:00');
  check(page, '更新时间来自接口', s.node('configUpdateInfo').textContent.includes('2026-09-24 10:00:00'));
  s.node('diaryDeadline').value = '19:00'; s.node('missingTime').value = 'next_day_noon'; c.updatePreview();
  check(page, '编辑配置后预览联动', s.node('previewDeadline').textContent === '19:00' && s.node('previewReminder').textContent === '18:00' && s.node('previewMissing').textContent === '次日 12:00');
  let writes = 0;
  c.apiFetch = c.window.apiFetch = async (route, options) => { writes++; return { ...options.body, id: options.body.name === 'diaryDeadline' ? 987 : 1000 + writes, updateTime: '2026-09-24T11:00:00' }; };
  await Promise.all([c.saveConfig(), c.saveConfig()]);
  check(page, '保存成功更新元数据且重复点击不重复发起', writes === 11 && s.node('saveModal').classList.contains('show') && s.node('configUpdateInfo').textContent.includes('11:00:00'), { writes });
  c.closeModal('saveModal');
  c.apiFetch = c.window.apiFetch = async () => { throw new Error('权限不足'); };
  await c.saveConfig();
  check(page, '权限失败不显示保存成功', !s.node('saveModal').classList.contains('show') && s.errors.some(e => e.includes('权限不足')));
  c.window.apiFetch = null; await c.saveConfig();
  check(page, '接口缺失不伪报保存成功', !s.node('saveModal').classList.contains('show'));
  c.window.apiFetch = c.apiFetch;
  c.apiGetPage = c.window.apiGetPage = async () => { throw new Error('连接失败'); };
  await c.loadConfigs();
  check(page, '读取失败禁止保存而非当作默认值', c.configLoaded === false && s.node('configUpdateInfo').textContent.includes('禁止保存'));
  c.apiGetPage = c.window.apiGetPage = async () => ({ list: [sample], total: 201 }); await c.loadConfigs();
  check(page, '未完整加载时禁止保存', c.configLoaded === false);
  c.apiGetPage = c.window.apiGetPage = async () => ({ list: [sample, { ...sample, id: 988 }], total: 2 }); await c.loadConfigs();
  check(page, '同名配置冲突显式拒绝保存', c.configLoaded === false && s.errors.some(e => e.includes('同名配置')));
  c.confirmReset();
  check(page, '重置同步预览且不自动保存', s.node('previewDeadline').textContent === '18:00' && s.node('previewReminder').textContent === '17:00' && s.errors.includes('表单已重置为默认值，尚未保存'));
  const html = fs.readFileSync(path.join(root, page + '.html'), 'utf8');
  check(page, '未实现调度明确告知且无立即生效承诺', html.includes('自动调度尚未实现') && html.includes('尚未接入保存，已禁用') && !html.includes('立即生效'));
  check(page, '预览和元数据拥有真实DOM锚点', ['previewDeadline', 'previewReminder', 'previewLead', 'previewMissing', 'configUpdateInfo'].every(id => html.includes('id="' + id + '"')));
}
function securityChecks() {
  const runtime = { window: {}, document: { readyState: 'loading', addEventListener() {} } };
  vm.createContext(runtime);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8'), runtime);
  const actualEscape = runtime.window.App.escape;
  check('assets/app.js', '实际App.escape编码HTML特殊字符', actualEscape('<>&"\'') === '&lt;&gt;&amp;&quot;&#39;');
  const safety = environment('safety-log'), sc = safety.context;
  sc.App.escape = actualEscape;
  const marker = '<img src=x onerror="window.__qaXss=1">';
  sc.filteredData = [sc.mapLog({ id: 7, code: marker, projectId: 1, logDate: '2026-09-23', status: 'draft' })];
  sc.renderAllActions = () => {};
  sc.renderTable();
  const rendered = safety.node('tbody').innerHTML;
  check('safety-log', '日志编号以文本输出不得进入可执行HTML', rendered.includes(actualEscape(marker)) && !rendered.includes(marker),
    { rawMarkupObserved: rendered.includes(marker), note: '原渲染函数输出检查，未打开浏览器或发送攻击请求' });
  const project = environment('project-ledger'), pc = project.context;
  pc.App.escape = actualEscape;
  pc.filteredData = [{ id: 7, code: 'QA', name: "');window.__qaXss=1;//", status: 'active' }];
  pc.renderTable();
  const html = project.node('tableBody').innerHTML;
  const handler = Array.from(html.matchAll(/onclick="([^"]*)"/g)).map(m => m[1]).find(s => s.includes('confirmDelete'));
  const probe = {};
  if (handler) {
    const decoded = handler.replace(/&#(?:0*39|x0*27);|&apos;/gi, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    vm.runInNewContext(decoded, { window: probe, confirmDelete() {} }, { timeout: 1000 });
  }
  check('project-ledger', '项目名不得突破onclick的JavaScript字符串上下文', probe.__qaXss !== 1,
    { markerExecutedInSandbox: probe.__qaXss === 1, note: '模拟HTML实体解码后，仅在隔离VM执行标记赋值；不访问真实页面或令牌' });
}
function finish() {
  const counts = {}; results.forEach(r => counts[r.result] = (counts[r.result] || 0) + 1);
  fs.writeFileSync(path.join(out, '页面脚本验证.json'), JSON.stringify({ note: '原页面内联JS+DOM桩/接口桩，不是浏览器渲染/点击测试，也不是真实大量数据负载测试。', counts, results }, null, 2));
  console.log(JSON.stringify(counts));
  if (counts['失败']) process.exitCode = 1;
}
async function main() {
  if (process.argv.includes('--project-only')) { await projectStatusChecks(); finish(); return; }
  if (process.argv.includes('--work-standard-only')) { await workStandardChecks(); finish(); return; }
  await projectStatusChecks();
  for (const page of ['log-statistics', 'safety-log-statistics']) {
    const s = environment(page), c = s.context, today = c.getTodayStr();
    const drafts = c.aggregate([{ projectId: 1, logDate: today, status: 'draft' }]);
    check(page, '当日只有草稿不得显示已提交', drafts[0].todaySubmitted === false, drafts);
    const duplicates = c.aggregate([{ projectId: 1, logDate: today, status: 'approved' }, { projectId: 1, logDate: today, status: 'approved' }]);
    check(page, '同一天两条记录不能当作两个应写工作日', duplicates[0].totalDays === 1, duplicates);
    c.projectData = drafts; c.renderTable();
    check(page, '渲染后的草稿行应显示未提交', s.node('tableBody').innerHTML.includes('○ 未提交'), s.node('tableBody').innerHTML);
    c.projectsMap = { 1: '模拟A项目', 2: '模拟B项目（无记录）' };
    check(page, '无记录项目应纳入未提交统计', c.aggregate([]).length === 2, c.aggregate([]));
    s.context.apiGetPage = async (route, params) => { s.calls.push({ route, params }); return { list: [{ projectId: 1, logDate: today, status: 'approved' }], total: 2001, pageNum: 1, pageSize: 2000 }; };
    await c.loadData(); check(page, '总数超过第一页时不能静默少计', s.calls.length > 1 || s.errors.length > 0, { requests: s.calls, displayedRows: c.rawLogs.length, totalFromApi: 2001, errors: s.errors });
  }
  const diary = environment('diary-statistics');
  diary.context.usersMap = { 1: '模拟监理甲' }; diary.context.projectsMap = { 1: '模拟项目A' };
  diary.context.renderStats([{ projectId: 1, authorId: 1, status: 'approved', diaryDate: '2026-09-23' }, { projectId: 1, authorId: 1, status: 'draft', diaryDate: '2026-09-23' }]);
  check('diary-statistics', '已通过和草稿数量分别展示', diary.node('statApproved').textContent === '1' && diary.node('statDraft').textContent === '1', { approved: diary.node('statApproved').textContent, draft: diary.node('statDraft').textContent });
  check('diary-statistics', '同人同日多记录不能直接当作应写天数', !diary.node('statBody').innerHTML.includes('<td>2</td>'), diary.node('statBody').innerHTML);
  diary.context.apiGetPage = async (route, params) => { diary.calls.push({ route, params }); return { list: [{ projectId: 1, authorId: 1, status: 'approved', diaryDate: '2026-09-23' }], total: 1001 }; };
  diary.context.loadData(); await Promise.resolve(); await Promise.resolve();
  check('diary-statistics', '超过1000条应继续取数或显式报错', diary.calls.length > 1 || diary.errors.length > 0, { calls: diary.calls, shown: diary.node('statTotal').textContent, actualTotal: 1001 });
  const report = environment('diary-report', { schema: true });
  report.context.apiGetPage = async (route, params) => { report.calls.push({ route, params }); return { list: [{ id: 123, authorId: 1, projectId: 1, status: 'approved', diaryDate: '2026-09-23', weather: '晴', photos: '["/api/uploads/test.png"]', attachments: '[]' }], total: 1001 }; };
  await report.context.loadData();
  check('diary-report', '状态与附件数量正确渲染', report.node('reportTableBody').innerHTML.includes('通过') && report.context.filteredData[0].relatedCount === 1, report.node('reportTableBody').innerHTML);
  check('diary-report', '查看日记链接应携带该条记录ID', /(?:id|recordId)=123/.test(report.node('reportTableBody').innerHTML), report.node('reportTableBody').innerHTML);
  check('diary-report', '报表不能忽略超过1000条的后续记录', report.calls.length > 1 || report.errors.length > 0, { calls: report.calls, displayed: report.context.filteredData.length, actualTotal: 1001 });
  report.context.exportExcel(); const csv = await report.downloads[0].text();
  check('diary-report', '可生成包含真实渲染记录的CSV文本', csv.includes('2026-09-23') && csv.includes('通过'), csv);
  fs.writeFileSync(path.join(out, '日记报表-受控脚本模拟导出.csv'), '\uFEFF' + csv);
  // 导出读取的是 record 里的字段，直接改外层对象不会进入 CSV，旧写法永远无法通过
  report.context.filteredData[0].record.weather = '晴,间多云'; report.context.exportExcel();
  const commaCsv = await report.downloads[1].text(); check('diary-report', 'CSV逗号字段应加引号以防列错位', commaCsv.includes('"晴,间多云"'), commaCsv);
  // 日常巡检作为现场备忘录：巡检不得回流成审核单据，其他类型的审核链路保持不变
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  const schemaJs = read('miniprogram/utils/schema.js');
  check('miniprogram/utils/schema.js', '巡检保存态文案与可编辑判定集中在 schema 并对外导出',
    /const memoStatuses = \[[^\]]*'recorded'/.test(schemaJs)
    && /function isSavedMemo\(kind, status\) \{ return kind === 'daily-inspections'/.test(schemaJs)
    && /kind === 'daily-inspections'\) return status === 'draft' \? statuses\.draft : isSavedMemo\(kind, status\) \? '已保存'/.test(schemaJs)
    && /kind === 'daily-inspections'\) return status === 'draft' \|\| isSavedMemo\(kind, status\)/.test(schemaJs)
    && /memoStatuses, isSavedMemo, statusText, canEditStatus/.test(schemaJs)
    && /return \['submitted', 'pending'\]\.includes\(status\) \? '已提交（待审核）'/.test(schemaJs));
  const homeWxml = read('miniprogram/pages/home/index.wxml'), homeJs = read('miniprogram/pages/home/index.js');
  check('miniprogram/pages/home', '小程序首页巡检不展示“项目待审核”，摘要只给草稿与已保存',
    /wx:if="\{\{canReview && kind !== 'daily-inspections'\}\}"/.test(homeWxml)
    && /wx:if="\{\{item\.memo\}\}"/.test(homeWxml)
    && /已保存 \{\{item\.counts\.recorded\}\}/.test(homeWxml)
    && /巡检提交即保存为备忘，不产生审核待办/.test(homeWxml)
    && /kind === 'daily-inspections' && this\.data\.mode === 'todo' \? 'mine'/.test(homeJs));
  check('miniprogram/pages/home', '小程序首页巡检列表不按待审核拉取，状态文案改用 statusText',
    /const kind = this\.data\.kind, todo = this\.data\.mode === 'todo' && kind !== 'daily-inspections';/.test(homeJs)
    && /status: todo \? 'submitted' : undefined/.test(homeJs)
    && /statusText: statusText\(kind, r\.status\)/.test(homeJs)
    && /if \(mode === 'todo' && this\.data\.kind === 'daily-inspections'\) return;/.test(homeJs));
  const recordWxml = read('miniprogram/pages/record/index.wxml'), recordJs = read('miniprogram/pages/record/index.js');
  check('miniprogram/pages/record', '小程序记录页巡检隐藏审核入口、提交按钮按类型显示文案',
    /canReview && kind !== 'daily-inspections' && \(status === 'submitted' \|\| status === 'pending'\)/.test(recordWxml)
    && /\{\{submitLabel\}\}/.test(recordWxml)
    && /memo \? '联网保存 \/ 重试' : '联网保存草稿 \/ 重试'/.test(recordWxml)
    && /检查项手动添加；不符合可添加问题，不会自动创建问题。/.test(recordWxml)
    && !/改变审核状态/.test(recordWxml)
    && /if \(kind !== 'daily-inspections'\) return '确认提交审核';/.test(recordJs)
    && /return serverId && isSavedMemo\(kind, status\) \? '保存修改' : '提交';/.test(recordJs)
    && /submitLabel: submitLabelOf\(this\.kind, record\.status, record\.id\)/.test(recordJs));
  const dailyHtml = read('daily-inspection.html');
  const chain = ['miniprogram/utils/inspection-checklist.js', 'miniprogram/utils/schema.js', 'assets/inspection-checklist.js', 'assets/field-records.js'];
  const chainPos = chain.map(f => dailyHtml.indexOf('src="' + f + '"'));
  check('daily-inspection.html', '检查项数据、schema 视图与记录页脚本按依赖顺序引入',
    chainPos.every(p => p > 0) && chainPos.slice(1).every((p, i) => p > chainPos[i]), chainPos);
  const processHtml = read('process-management.html');
  check('process-management.html', '巡检流程卡改为现场备忘录，不再提供审批配置',
    /日常巡检（现场备忘录）/.test(processHtml)
    && /<span class="flow-status inactive">无审核<\/span>/.test(processHtml)
    && /0 个（提交即保存）/.test(processHtml)
    && /无需审批配置/.test(processHtml)
    && !/巡检整改审批/.test(processHtml)
    && !/openEditModal\(5\)/.test(processHtml)
    && !/toggleFlow\(5\)/.test(processHtml));
  const demoJs = fs.readFileSync(path.join(__dirname, '..', '演示数据生成.cjs'), 'utf8');
  const demoBlock = (demoJs.match(/const inspections = \[([\s\S]*?)\n  \];/) || [])[1] || '';
  const demoBad = demoBlock.match(/'(approved|submitted|pending|rejected|fixed|active)'/g) || [];
  check('演示数据生成.cjs', '巡检样例只生成草稿/已保存，不调用审核接口',
    !/approveRecord\([^)]{0,80}daily-inspections/.test(demoJs)
    && /巡检记录 ' \+ location \+ '（' \+ status \+ '）'/.test(demoJs)
    && /'recorded'/.test(demoBlock) && /'draft'/.test(demoBlock) && demoBad.length === 0, demoBad);
  const kindJava = read('backend/src/main/java/com/supervision/common/FieldRecordKind.java');
  const serviceJava = read('backend/src/main/java/com/supervision/service/FieldRecordService.java');
  check('FieldRecordKind.java', '日常巡检在服务端定义为无需审核，历史状态统一按已保存判定',
    /DAILY_SAVED_STATUSES = java\.util\.Set\.of\(\s*"recorded", "submitted", "pending", "approved", "rejected", "fixed", "active"\)/.test(kindJava)
    && /public boolean requiresReview\(\) \{ return this != DAILY; \}/.test(kindJava)
    && /public boolean isSavedMemo\(String status\) \{/.test(kindJava));
  check('FieldRecordService.java', '服务端拒绝巡检审核，提交状态归一为已保存且已保存可再编辑',
    /if \(!kind\.requiresReview\(\)\) throw new BusinessException\(400, "日常巡检无需审核"\);/.test(serviceJava)
    && /if \(!Set\.of\("draft", "submitted", "recorded"\)\.contains\(status\)\)/.test(serviceJava)
    && /if \(kind\.isSavedMemo\(record\.getStatus\(\)\) \|\| !"draft"\.equals\(status\)\) status = "recorded";/.test(serviceJava)
    && /if \(kind\.isSavedMemo\(record\.getStatus\(\)\)\) return;/.test(serviceJava));
  await workStandardChecks();
  if (process.argv.includes('--security')) securityChecks();
  finish();
}
main().catch(e => { results.push({ result: '受阻', title: '页面测试器中断', actual: e.message }); finish(); console.error(e); process.exitCode = 1; });
