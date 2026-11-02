/* eslint-disable */
/**
 * 监理现场管理系统 —— 一键生成模拟演示数据
 * 前提：先运行《一键启动.bat》，再运行本脚本（生成演示数据.bat）。
 */

const API_BASE = process.env.API_BASE || 'http://localhost:8080/api';
const DEMO_PASSWORD = '123456';

let okCount = 0, failCount = 0;
const failures = [];

function pad(n) { return String(n).padStart(2, '0'); }
function d(offsetDays) {
  const t = new Date(Date.now() + offsetDays * 86400000);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}
function dt(offsetDays, hh, mm) { return `${d(offsetDays)}T${pad(hh)}:${pad(mm)}:00`; }
function workdays(n) {
  // 返回最近 n 个工作日，降序：T[0]=今天（或最近工作日）……体现“近期业务活动”，
  // 小程序首页「今日摘要」按当天查询，必须让数据覆盖到今天。
  const list = [];
  for (let off = 0; off <= Math.ceil(n * 1.6) + 4 && list.length < n; off++) {
    const day = new Date(Date.now() - off * 86400000).getDay();
    if (day !== 0 && day !== 6) list.push(d(-off));
  }
  return list;
}

// 全局递增编号，避免随机数碰撞导致“编号已存在”
let codeSeq = 0;
function uniq() { return String(++codeSeq).padStart(3, '0'); }
function idemKey() {
  return require('crypto').randomUUID().replace(/-/g, '') + 'demo';
}

async function req(path, { method = 'GET', body, token, headers } = {}) {
  const h = Object.assign({}, headers);
  if (token) h['Authorization'] = 'Bearer ' + token;
  const opts = { method, headers: h, signal: AbortSignal.timeout(30000) };
  if (body !== undefined) {
    if (!(body instanceof FormData)) { h['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    else opts.body = body;
  }
  const resp = await fetch(API_BASE + path, opts);
  let json = null;
  try { json = await resp.json(); } catch (e) { /* 非 JSON */ }
  if (!resp.ok || (json && json.code !== undefined && json.code !== 200)) {
    throw new Error(`${method} ${path} -> ${json && json.message ? json.message : 'HTTP ' + resp.status}`);
  }
  return json ? json.data : null;
}

async function step(name, fn) {
  try { await fn(); okCount++; console.log('  [OK] ' + name); }
  catch (e) { failCount++; failures.push(name + ': ' + e.message); console.log('  [x] ' + name + ' -> ' + e.message); }
}
function section(t) { console.log('\n========== ' + t + ' =========='); }

async function login(username, password) {
  const data = await req('/auth/login', { method: 'POST', body: { username, password } });
  return { token: data.token, userId: data.userId, name: data.userName };
}

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function uploadPng(token) {
  const fd = new FormData();
  fd.append('file', new Blob([PNG_1X1], { type: 'image/png' }), '现场照片.png');
  return (await req('/files/upload', { method: 'POST', body: fd, token })).url;
}
async function uploadDoc(token, projectId, subItemId, filename, content) {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(content, 'utf8')], { type: 'text/plain' }), filename);
  return req('/project-documents/upload?projectId=' + projectId + '&subItemId=' + subItemId, { method: 'POST', body: fd, token });
}

async function createRecord(token, kindPath, body) {
  return req('/' + kindPath, { method: 'POST', body, token, headers: { 'Idempotency-Key': idemKey() } });
}
async function getRecordVersion(token, kindPath, id) {
  return (await req('/' + kindPath + '/' + id, { token })).lockVersion;
}
async function submitRecord(token, kindPath, id) {
  const v = await getRecordVersion(token, kindPath, id);
  return req('/' + kindPath + '/' + id + '/submit', { method: 'POST', token, headers: { 'X-Record-Version': String(v) } });
}
async function approveRecord(token, kindPath, id, status, rejectReason) {
  const v = await getRecordVersion(token, kindPath, id);
  return req('/' + kindPath + '/' + id + '/approve', {
    method: 'POST', token, headers: { 'X-Record-Version': String(v) },
    body: status === 'rejected' ? { status, rejectReason } : { status }
  });
}

(async () => {
  console.log('监理现场管理系统 - 演示数据生成');
  console.log('后端地址: ' + API_BASE);

  // 0. 连通性检查（未登录访问受保护接口应返回业务错误而非连不上）
  try {
    await req('/dashboard/stats');
    console.log('[警告] 未登录却能取到数据，环境可能异常，仍继续。');
  } catch (e) {
    if (/fetch failed|ECONNREFUSED|timeout|超时/i.test(e.message)) {
      console.log('\n[错误] 无法连接后端服务。请先双击《一键启动.bat》，等登录页打开后再运行本脚本。');
      process.exit(1);
    }
  }

  const T = workdays(14);

  // 1. admin 登录
  const admin = await login('13800000000', DEMO_PASSWORD);
  console.log('已登录：' + admin.name + '（管理员）');

  // 1.1 部门（种子已有：总公司 id=1、监理一部 id=2）
  section('部门管理');
  const dept = {};
  for (const [name, desc, leader] of [
    ['监理二部', '第二监理事业部，负责市政类项目', '李慧敏'],
    ['安全监理部', '专职安全监理与隐患排查', '陈静'],
    ['综合办公室', '行政、资料与档案管理', '周敏'],
  ]) {
    await step('新建部门：' + name, async () => {
      dept[name] = (await req('/departments', { method: 'POST', token: admin.token,
        body: { name, parentId: 1, description: desc, leader, sortOrder: 10, status: 'active' } })).id;
    });
  }

  // 1.2 项目台账
  section('项目台账');
  const zhao = await login('13800000001', DEMO_PASSWORD);
  const proj = {};
  const projects = [
    ['p1', { name: '滨江花园一期住宅工程', code: 'XL-BJHY-2026-001', buildUnit: '杭州滨江置业有限公司',
      address: '杭州市滨江区江陵路 128 号', type: '房建工程', status: 'active',
      startDate: d(-210), endDate: d(150), managerId: zhao.userId,
      description: '12 栋高层住宅，总建筑面积 28.6 万平方米，现阶段主体结构施工。' }],
    ['p2', { name: '城南市政道路改造工程', code: 'XL-CSZL-2026-002', buildUnit: '城南基础设施建设指挥部',
      address: '市城南片区环湖路至解放南路段', type: '市政工程', status: 'active',
      startDate: d(-120), endDate: d(240),
      description: '道路全长 4.8km，含雨污水管网、路灯及交通设施配套。' }],
    ['p3', { name: '原行政办公楼装修监理项目', code: 'XL-XZBG-2025-003', buildUnit: '市级机关事务管理局',
      address: '市民中心东路 9 号', type: '装饰装修', status: 'completed',
      startDate: d(-400), endDate: d(-30),
      description: '已完成竣工验收，档案留存备查（演示"已完结"状态）。' }],
  ];
  for (const [key, body] of projects) {
    await step('新建项目：' + body.name, async () => {
      proj[key] = (await req('/projects', { method: 'POST', token: admin.token, body })).id;
    });
  }
  await step('更新赵总监档案（关联项目一）', () =>
    req('/users/' + zhao.userId, { method: 'PUT', token: admin.token, body: {
      name: '赵建国', gender: '男', deptId: 2, position: '总监理工程师', certNo: 'JLZ-001',
      phone: '13800000001', projectId: proj.p1, hireDate: '2024-01-01', status: 'active' } }));

  // 1.3 人员（不同角色视角 + 禁用边界）
  section('人员管理');
  const users = { zhao };
  const personnel = [
    ['李慧敏', '女', dept['监理二部'], '总监理工程师', '13800000003', proj.p2, 'JLZ-002', '2024-03-01'],
    ['王强', '男', 2, '监理员', '13800000004', proj.p1, 'JLY-101', '2024-06-01'],
    ['陈静', '女', dept['安全监理部'], '安全监理员', '13800000005', proj.p1, 'AQL-201', '2024-06-15'],
    ['刘洋', '男', 2, '总监代表', '13800000006', proj.p2, 'JLZ-305', '2024-04-01'],
    ['周敏', '女', dept['综合办公室'], '资料员', '13800000007', proj.p2, null, '2025-02-01'],
    ['吴十', '男', dept['监理二部'], '监理员', '13800000008', proj.p3, null, '2025-06-01'],
  ];
  for (const [name, gender, deptId, position, phone, projectId, certNo, hireDate] of personnel) {
    await step('新建人员：' + name, async () => {
      users[name] = await req('/users', { method: 'POST', token: admin.token,
        body: { name, gender, deptId, position, phone, certNo, projectId, hireDate, password: DEMO_PASSWORD } });
    });
  }
  await step('边界场景：禁用离职人员"吴十"', () =>
    req('/users/' + users['吴十'].id + '/status?status=disabled', { method: 'PUT', token: admin.token }));

  // 1.4 角色与权限
  section('权限设置');
  let roleChief = null, roleSupervisor = null;
  await step('新建角色：总监理工程师', async () => {
    roleChief = await req('/roles', { method: 'POST', token: admin.token,
      body: { name: '总监理工程师', code: 'chief', description: '负责项目全面监理工作与记录审核', status: 'active' } });
  });
  await step('新建角色：监理员', async () => {
    roleSupervisor = await req('/roles', { method: 'POST', token: admin.token,
      body: { name: '监理员', code: 'supervisor', description: '负责现场巡查、旁站与日记填报', status: 'active' } });
  });
  const permIds = [];
  const permModules = [['现场管理', 'field'], ['系统管理', 'sys'], ['资料管理', 'doc']];
  const parentIds = {};
  for (const [name, code] of permModules) {
    await step('新建权限(顶级)：' + name, async () => {
      const r = await req('/permissions', { method: 'POST', token: admin.token,
        body: { name, code, module: name, sortOrder: 1 } });
      parentIds[name] = r.id; permIds.push(r.id);
    });
  }
  const childPerms = [
    ['项目维护', 'field:project', '现场管理'], ['监理日记填报', 'field:diary', '现场管理'],
    ['日记审核签发', 'field:diary:approve', '现场管理'], ['巡检旁站填报', 'field:inspect', '现场管理'],
    ['人员管理', 'sys:user', '系统管理'], ['角色权限配置', 'sys:role', '系统管理'],
    ['资料上传归档', 'doc:upload', '资料管理'],
  ];
  const fieldPermIds = [];
  for (const [name, code, parent] of childPerms) {
    await step('新建权限：' + name, async () => {
      const r = await req('/permissions', { method: 'POST', token: admin.token,
        body: { name, code, module: parent, parentId: parentIds[parent], sortOrder: 2 } });
      permIds.push(r.id);
      if (parent === '现场管理') fieldPermIds.push(r.id);
    });
  }
  await step('为"总监"角色配置全部权限', () =>
    req('/roles/' + roleChief.id + '/permissions', { method: 'POST', token: admin.token, body: permIds }));
  await step('为"监理员"角色仅配置填报类权限（边界：无审核权）', () =>
    req('/roles/' + roleSupervisor.id + '/permissions', { method: 'POST', token: admin.token,
      body: [parentIds['现场管理'], ...fieldPermIds.filter((_, i) => i !== 2)] }));
  await step('角色分配成员：总监=李慧敏/刘洋', () =>
    req('/roles/' + roleChief.id + '/users', { method: 'POST', token: admin.token,
      body: [users['李慧敏'].id, users['刘洋'].id] }));
  await step('角色分配成员：监理员=王强/陈静/周敏', () =>
    req('/roles/' + roleSupervisor.id + '/users', { method: 'POST', token: admin.token,
      body: [users['王强'].id, users['陈静'].id, users['周敏'].id] }));

  // 1.5 项目授权（现场页“项目成员授权”按钮已下线，此处直接调接口预置启用/审核权，保证演示审核流程可用）
  section('项目授权');
  const memberPlan = [
    [proj.p1, users['王强'].id, true, false], [proj.p1, users['陈静'].id, true, false],
    [proj.p1, zhao.userId, true, true],
    [proj.p2, users['李慧敏'].id, true, true], [proj.p2, users['刘洋'].id, true, true], [proj.p2, users['周敏'].id, true, false],
  ];
  for (const [pid, uid, enabled, canReview] of memberPlan) {
    await step('项目 ' + pid + ' 授权用户 ' + uid + '（审核权=' + canReview + '）', () =>
      req('/projects/' + pid + '/members', { method: 'PUT', token: admin.token, body: { userId: uid, enabled, canReview } }));
  }
  await step('项目二指定负责人为李慧敏', () =>
    req('/projects/' + proj.p2, { method: 'PUT', token: admin.token, body: {
      name: '城南市政道路改造工程', code: 'XL-CSZL-2026-002', buildUnit: '城南基础设施建设指挥部',
      address: '市城南片区环湖路至解放南路段', type: '市政工程', status: 'active',
      startDate: d(-120), endDate: d(240), managerId: users['李慧敏'].id,
      description: '道路全长 4.8km，含雨污水管网、路灯及交通设施配套。' } }));

  // 2. 各角色登录 + 上传照片（吴十已禁用，不参与登录，仅作为边界演示）
  const sessions = { admin };
  for (const key of ['zhao', '李慧敏', '王强', '陈静', '刘洋', '周敏']) {
    sessions[key] = key === 'zhao' ? zhao : await login(users[key].phone, DEMO_PASSWORD);
  }
  const wang = sessions['王强'], chen = sessions['陈静'], liu = sessions['刘洋'], zhou = sessions['周敏'], li = sessions['李慧敏'];
  const photoWang = await uploadPng(wang.token);
  const photoChen = await uploadPng(chen.token);
  const photoLiu = await uploadPng(liu.token);

  // 3. 监理日记
  section('监理日记');
  const diaryTexts = [
    ['基础垫层浇筑旁站监督，核查商品混凝土坍落度 4 次，全部合格。', '组织班前安全讲话，特种作业人员持证检查 12 人。', '巡检 3# 楼钢筋绑扎，箍筋间距局部超偏 3 处已通知整改。'],
    ['3# 楼剪力墙钢筋隐蔽验收，配合设计院处理节点做法疑问 1 项。', '下发监理通知单一份（保护层垫块设置不规范）。', '屋面防水样板检查，收头处理待改进。'],
    ['塔吊标准节加高旁站，核对附着杆角度与说明书一致。', '参加甲方质量例会，通报本周质量问题台账。', '巡检临时用电，两级漏保测试记录齐全。'],
    ['5# 楼铝模拆模检查，实测垂直度合格率 96%。', '审查下周进度计划，提出关键线路调整建议 2 条。', '抽查砌体拉结筋植筋拉拔试验，报告齐全。'],
    ['车库顶板防水巡视，卷材搭接宽度满足 100mm。', '督促基坑监测数据日报闭环。', '钢筋加工场标识检查，原材与半成品分区规范。'],
    ['6# 楼外架悬挑层验收，锚固环不足 2 处要求整改复验。', '组织危大工程专项巡查（模板支撑体系）。', '进场砌块见证取样 1 组。'],
    ['7# 楼混凝土浇筑令审批，坍落度抽测 3 点合格。', '检查养护记录，夜间覆盖保湿到位。', '巡检临边防护，1 处洞口盖板缺失当场恢复。'],
    ['8# 楼电梯井筒模加固检查，复核垂直度控制线。', '陪同第三方主体飞检，记录疑点 4 条。', '抽查直螺纹接头工艺检验报告，扭矩记录完整。'],
  ];
  let diarySeq = 0;
  async function diary(session, projectId, photo, day, idx, status) {
    const t = diaryTexts[idx % diaryTexts.length];
    diarySeq++;
    const body = {
      code: 'RZ-' + day.replace(/-/g, '') + '-' + pad(diarySeq),
      projectId, diaryDate: day,
      weather: ['晴', '多云', '阴', '小雨', '阵雨'][idx % 5],
      wind: (2 + (idx % 4)) + ' 级',
      temperature: (18 + (idx % 8)) + '℃ ~ ' + (26 + (idx % 6)) + '℃',
      construction: t[0], management: t[1], inspection: t[2],
      otherMatters: idx % 3 === 0 ? '无其他事项。' : '',
      morningMeeting: idx % 2 === 0 ? '班前讲话：高处作业必须系挂安全带。' : '',
      drawingReview: idx % 4 === 0 ? '复核结施-12 梁柱节点配筋，疑问已发联系单。' : '',
    };
    if (status !== 'draft') body.photos = JSON.stringify([photo]);
    const created = await createRecord(session.token, 'supervision-diaries', body);
    if (status !== 'draft') await submitRecord(session.token, 'supervision-diaries', created.id);
    return created;
  }
  const wangDiaries = [];
  for (let i = 0; i < 7; i++) {
    await step('王强填报日记 ' + T[i], async () => { wangDiaries.push(await diary(wang, proj.p1, photoWang, T[i], i, 'submitted')); });
  }
  await step('王强填报日记（草稿边界）' + T[7], () => diary(wang, proj.p1, photoWang, T[7], 7, 'draft'));
  await step('赵总监审核通过王强日记 5 篇', async () => { for (const r of wangDiaries.slice(0, 5)) await approveRecord(zhao.token, 'supervision-diaries', r.id, 'approved'); });
  await step('赵总监退回王强日记 1 篇（边界）', () =>
    approveRecord(zhao.token, 'supervision-diaries', wangDiaries[5].id, 'rejected', '当日大雨，停工记录与照片不符，请补充说明后重新提交。'));
  const chenDiaries = [];
  for (let i = 2; i < 5; i++) {
    await step('陈静填报日记 ' + T[i], async () => { chenDiaries.push(await diary(chen, proj.p1, photoChen, T[i], i + 1, 'submitted')); });
  }
  await step('赵总监审核通过陈静日记 2 篇', async () => { for (const r of chenDiaries.slice(0, 2)) await approveRecord(zhao.token, 'supervision-diaries', r.id, 'approved'); });
  await step('陈静填报日记（草稿）', () =>
    createRecord(chen.token, 'supervision-diaries', { code: 'RZ-' + d(-1).replace(/-/g, '') + '-90', projectId: proj.p1, diaryDate: d(-1),
      weather: '多云', construction: '安全专项巡查准备，整理危大工程清单（草稿，未提交）。' }));
  const liuDiaries = [];
  for (let i = 1; i < 4; i++) {
    await step('刘洋填报日记 ' + T[i], async () => { liuDiaries.push(await diary(liu, proj.p2, photoLiu, T[i], i, 'submitted')); });
  }
  await step('李总监审核通过刘洋日记 2 篇', async () => { for (const r of liuDiaries.slice(0, 2)) await approveRecord(li.token, 'supervision-diaries', r.id, 'approved'); });

  // 4. 监理日志（周汇总）
  section('监理日志');
  const logBodies = [
    { code: 'RZLB-W39', weekStart: d(-13), weekEnd: d(-7), logDate: d(-7),
      content: '本周 3#-5# 楼完成标准层结构验收 3 次；混凝土浇筑 6 次约 2800m³；质量问题台账 11 条，闭环 9 条。',
      management: '组织周例会 1 次，专项检查 2 次；6# 楼铝模首检已交底。',
      inspection: '巡查覆盖全部在施楼层，一般问题 5 项，重大风险 0 项。' },
    { code: 'RZLB-W40', weekStart: d(-6), weekEnd: d(0), logDate: d(0),
      content: '本周完成 5# 楼主体中间验收（预验收通过）；塔吊加高 2 台次；雨季施工措施全面检查。',
      management: '参加建设单位雨期施工部署会；发布防台风预警二级提醒。',
      inspection: '日常巡检 14 次，旁站 6 次，通知单 1 份已闭环。' },
    { code: 'RZLB-W41', weekStart: d(1), weekEnd: d(6), logDate: d(6),
      content: '下周期望汇总（草稿，数据待现场核实后提交）。' },
  ];
  const logs = [];
  for (let i = 0; i < logBodies.length; i++) {
    const b = logBodies[i];
    await step('监理日志：' + b.code + (i < 2 ? '（已提交）' : '（草稿）'), async () => {
      const created = await createRecord(zhao.token, 'supervision-logs',
        Object.assign({ projectId: proj.p1, weather: '晴', temperature: '22℃ ~ 29℃' }, b));
      if (i < 2) await submitRecord(zhao.token, 'supervision-logs', created.id);
      logs.push(created);
    });
  }
  await step('赵总监签批本周监理日志 2 篇', async () => {
    for (const r of logs.slice(0, 2)) await approveRecord(zhao.token, 'supervision-logs', r.id, 'approved');
  });

  // 5. 日常巡检（现场备忘录：提交即保存为已保存，不调用审核接口）
  section('日常巡检');
  const inspections = [
    [wang, 'p1', T[0], '3# 楼 5 层顶板', '模板支撑立杆间距抽查 10 点，2 点超允许偏差', '要求班组 2 小时内调整并报复检', 'recorded'],
    [wang, 'p1', T[1], '地下室顶板后浇带', '后浇带止水钢板焊缝局部不饱满', '已开通知单要求补焊并全数自查', 'recorded'],
    [chen, 'p1', T[3], '外脚手架（东立面）', '安全平网 2 处破损', '通知安全员当日更换，复查合格', 'recorded'],
    [chen, 'p1', T[4], '钢筋加工场', '箍筋内净尺寸偏差超出允许范围', '口头提醒，要求校核成型机参数', 'draft'],
    [zhou, 'p2', T[6], 'K1+200 雨水管道沟槽', '沟槽放坡不到位，局部超载', '要求立即卸载并修整边坡，报验暂停', 'recorded'],
    [zhou, 'p2', T[7], '环湖路水稳基层摊铺', '摊铺厚度个别断面偏差大于 10mm', '旁站监督调整摊铺机标高', 'recorded'],
  ];
  for (const [s, pk, day, location, content, issues, status] of inspections) {
    await step('巡检记录 ' + location + '（' + status + '）', async () => {
      const created = await createRecord(s.token, 'daily-inspections', {
        code: 'XC-' + day.replace(/-/g, '') + '-' + uniq(),
        projectId: proj[pk], inspectionDate: day, location, content, issues });
      if (status !== 'draft') await submitRecord(s.token, 'daily-inspections', created.id);
    });
  }

  // 6. 旁站记录
  section('旁站记录');
  const sidelines = [
    [wang, 'p1', T[1], '3# 楼梁板混凝土浇筑', 'C35 泵送混凝土浇筑，坍落度抽测合格，试块留置 3 组', 'approved', 2, 12, 8, 18],
    [wang, 'p1', T[3], '基础底板后浇带封闭', '微膨胀混凝土浇筑（拟定）', 'draft', 1, 6, 13, 16],
    [liu, 'p2', T[8], 'K1+300 污水管道闭水试验', '渗水量 1.2L/(m·h)，满足规范限值', 'approved', 2, 5, 9, 12],
    [liu, 'p2', T[9], '道路沥青下面层摊铺', '摊铺温度 145~155℃，碾压组合满足要求', 'submitted', 3, 10, 7, 11],
  ];
  for (const [s, pk, day, process, result, status, manageCount, workerCount, sh, sm] of sidelines) {
    await step('旁站记录 ' + process + '（' + status + '）', async () => {
      const dayOff = -Math.round((Date.now() - new Date(day + 'T00:00:00').getTime()) / 86400000);
      const content = JSON.stringify({ process, result, docs: ['旁站记录表-' + day, '检验批验收记录'], manageCount, workerCount });
      const created = await createRecord(s.token, 'sideline-inspections', {
        code: 'BZ-' + day.replace(/-/g, '') + '-' + uniq(),
        projectId: proj[pk], inspectionDate: day, location: process, content,
        startTime: dt(dayOff, sh, sm), endTime: dt(dayOff, sh + 4, sm) });
      if (status !== 'draft') await submitRecord(s.token, 'sideline-inspections', created.id);
      if (status === 'approved') await approveRecord(pk === 'p1' ? zhao.token : li.token, 'sideline-inspections', created.id, 'approved');
    });
  }

  // 7. 安全日志
  section('安全日志');
  const safetyPlans = [
    [T[0], '巡查临时用电、高处作业与动火作业 3 个面。', '基坑支护位移监测 12.3mm，预警值内。', '卸料平台限载牌缺失。', '无', 'approved'],
    [T[2], '组织周安全专项检查（脚手架、临边洞口）。', '连墙件按二步三跨设置，抽查 8 点符合方案。', '配电箱门缺失 1 处已恢复。', '无', 'approved'],
    [T[4], '塔吊群塔防碰撞措施检查。', '4 台塔吊高差与回转限位满足方案。', '信号工脱岗 10 分钟已通报总包。', '一般隐患 1 项（塔吊指挥缺位）', 'submitted'],
    [T[6], '消防通道与安全网专项检查。', '临时消防立管与消火栓布置满足规范。', '密目网破损 3 处待更换。', '无', 'rejected'],
    [T[7], '安全日志补录（草稿）。', '', '', '', 'draft'],
  ];
  for (const [day, content, inspection, safetyIssue, majorIssue, status] of safetyPlans) {
    await step('安全日志 ' + day + '（' + status + '）', async () => {
      const base = { code: 'AQ-' + day.replace(/-/g, '') + '-' + uniq(),
        projectId: proj.p1, logDate: day, weather: '晴', wind: '东南风 3 级', temperature: '21℃ ~ 28℃',
        content, inspection, safety: safetyIssue, majorIssue };
      const created = await req('/safety-logs', { method: 'POST', token: chen.token, body: base });
      if (status === 'draft') return;
      await req('/safety-logs/' + created.id, { method: 'PUT', token: chen.token, body: Object.assign({}, base, { status: 'submitted' }) });
      if (status === 'approved' || status === 'rejected') {
        await req('/safety-logs/' + created.id + '/approve', { method: 'POST', token: zhao.token,
          body: status === 'rejected' ? { status: 'rejected', rejectReason: '隐患整改闭环照片缺失，请补齐后再报审。' } : { status: 'approved' } });
      }
    });
  }

  // 8. 会议纪要
  section('会议纪要');
  const meetings = [
    [zhao, 'p1', d(-12), '第 39 周监理例会纪要', '建设、施工、监理、勘察单位。', '1、上周隐蔽验收问题全部闭环；2、铝模首检本周四；3、雨季物资储备清单报审。', '项目部会议室'],
    [zhao, 'p1', d(-5), '危大工程（模板支撑）专家论证会纪要', '建设、施工、监理及 5 名外部专家。', '支撑立杆步距由 1.8m 调整为 1.5m，扫地杆离地 200mm，结论"修改后通过"。', '集团公司 3 楼会议室'],
    [li, 'p2', d(-3), '市政道路交通导改专题会纪要', '交警、管线单位、施工总包。', '导改分三期实施，二期围挡 15 日前完成；夜间降噪措施三日内报审。', '指挥部会议室'],
  ];
  for (const [s, pk, day, title, attendees, content, location] of meetings) {
    await step('会议纪要：' + title, () =>
      req('/meeting-minutes', { method: 'POST', token: s.token, body: {
        code: 'HY-' + day.replace(/-/g, '') + '-' + uniq(),
        projectId: proj[pk], meetingDate: day, title, attendees, content, location } }));
  }

  // 9. 监理通知单
  section('监理通知单');
  const notices = [
    [zhao, 'p1', d(-8), '关于 3# 楼钢筋保护层垫块设置不规范的监理通知', '抽查发现楼板负筋垫块数量不足、间距过大，保护层厚度合格率仅 82%。请 3 日内全数自查整改并报复验。', d(-4), 'issued', '高'],
    [zhao, 'p1', d(-16), '关于基坑排水沟堵塞的监理通知', '坑底排水沟局部堵塞，积水浸泡垫层，要求立即疏通并加装沉淀池。', d(-10), 'issued', '中'],
    [wang, 'p1', d(-2), '关于外架安全网破损的监理通知（草稿）', '密目网破损部位清单附后（拟定，尚未签发）。', null, 'draft', '中'],
    [li, 'p2', d(-20), '关于沟槽开挖超深的监理通知（逾期边界）', 'K1+180 段沟槽超挖 120mm 未按方案处理，要求停工整改。', d(-6), 'issued', '高'],
  ];
  const noticeIds = [];
  for (const [s, pk, day, title, content, deadline, status, priority] of notices) {
    await step('通知单：' + title.slice(0, 18) + '（' + status + '）', async () => {
      const created = await req('/supervision-notices', { method: 'POST', token: s.token, body: {
        code: 'TZD-' + day.replace(/-/g, '') + '-' + uniq(),
        projectId: proj[pk], noticeDate: day, title, content, deadline, status, priority } });
      noticeIds.push(created.id);
      return created;
    });
  }
  await step('通知单回复闭环（录入整改答复）', async () => {
    await req('/supervision-notices/' + noticeIds[0] + '/reply', { method: 'POST', token: wang.token,
      body: { replyContent: '总包已整改：补设垫块 @800mm 双排布置，自查记录与照片已报复核，保护层抽测合格率提升至 95.6%。' } });
    await req('/supervision-notices/' + noticeIds[1] + '/reply', { method: 'POST', token: wang.token,
      body: { replyContent: '排水沟已疏通并新增 2 级沉淀池，坑底无积水，附整改前后对比照片说明。' } });
  });

  // 10. 工作联系单
  section('工作联系单');
  const contacts = [
    [zhou, 'p2', d(-6), '关于申请调整雨污水管道验收时间的联系单', '因连续降雨，原定本周三闭水试验申请顺延两天。', 'sent', '中', null],
    [liu, 'p2', d(-15), '关于环湖路交通导改配合事项的联系单', '请建设单位协调交警在导改前一日发布交通通告。', 'sent', '高', '已与交警支队对接，通告本周五 18:00 官方渠道发布。'],
    [wang, 'p1', d(-1), '关于混凝土浇筑时间调整的联系单（草稿）', '高温天气拟将浇筑作业调整至夜间施工（草稿）。', 'draft', '中', null],
    [chen, 'p1', d(-9), '关于特种作业人员持证复查的联系单', '焊工证 2 人到期，建议总包及时换证并停用待证人员。', 'sent', '高', null],
  ];
  for (const [s, pk, day, title, content, status, priority, reply] of contacts) {
    await step('联系单：' + title.slice(0, 16) + '（' + status + '）', async () => {
      const created = await req('/work-contacts', { method: 'POST', token: s.token, body: {
        code: 'LXD-' + day.replace(/-/g, '') + '-' + uniq(),
        projectId: proj[pk], contactDate: day, title, content, status, priority } });
      if (reply) await req('/work-contacts/' + created.id + '/reply', { method: 'POST', token: li.token, body: { replyContent: reply } });
    });
  }

  // 11. 监理月报
  section('监理月报');
  const monthPrev = d(-40).slice(0, 7), monthNow = d(-10).slice(0, 7);
  const monthlies = [
    [zhao, 'p1', monthPrev, '本月 3#-5# 楼主体结构顺利封顶 2 栋；隐蔽验收 48 批次一次通过率 96%；通知单 3 份全部闭环；未发生质量安全事故。'],
    [zhao, 'p1', monthNow, '本月完成 6#-8# 楼标准层施工 9 个；实测实量合格率 93.8%；安全专项检查 4 次，隐患整改闭环率 100%。'],
    [li, 'p2', monthNow, '本月完成雨污水管道 1.2km、水稳基层 800m；交通导改二期按期完成；沥青摊铺受降雨影响已赶工消化。'],
  ];
  for (const [s, pk, month, content] of monthlies) {
    await step('监理月报 ' + pk + ' / ' + month, () =>
      req('/supervision-monthly-reports', { method: 'POST', token: s.token, body: {
        code: 'YB-' + month.replace('-', '') + '-' + pk.toUpperCase(), projectId: proj[pk], reportMonth: month, content } }));
  }

  // 12. 消息中心
  section('消息中心');
  const msgs = [
    [zhao, wang, '审核提醒', '您有一篇监理日记被退回，请查看退回原因并修订后重新提交。', 'system'],
    [zhao, chen, '专项通知', '本周四 9:00 组织危大工程专项联合检查，请提前准备验收资料。', 'notice'],
    [li, zhou, '资料归档提醒', 'K1+200 段闭水试验报告尚未上传，请明日内补齐归档。', 'task'],
    [admin, zhao, '系统消息', '演示数据由运维脚本批量生成，如需重置请重启服务后重新生成。', 'system'],
    [zhao, wang, '例会通知', '第 40 周监理例会本周五 14:00 项目部会议室召开，请带上周问题闭环清单。', 'meeting'],
    [li, liu, '进度预警', '沥青摊铺受降雨影响滞后 2 天，请评估是否调整总进度计划。', 'warning'],
  ];
  const msgIds = [];
  for (const [from, to, title, content, type] of msgs) {
    await step('消息：' + title + '（发给 ' + to.name + '）', async () => {
      msgIds.push((await req('/messages', { method: 'POST', token: from.token,
        body: { receiverId: to.userId, title, content, type } })).id);
    });
  }
  await step('标记 2 条消息已读（其余保留未读角标）', async () => {
    await req('/messages/' + msgIds[0] + '/read', { method: 'PUT', token: wang.token });
    await req('/messages/' + msgIds[3] + '/read', { method: 'PUT', token: zhao.token });
  });

  // 13. 分项数据库
  section('分项数据库');
  async function buildTree(pk, tree) {
    for (const [parentName, children] of tree) {
      let pid = null;
      await step('分项：' + parentName, async () => {
        pid = (await req('/sub-item-databases', { method: 'POST', token: admin.token,
          body: { projectId: pk, name: parentName, sortOrder: 1, description: '分部工程' } })).id;
      });
      for (const child of children) {
        await step('分项：' + parentName + ' / ' + child, () =>
          req('/sub-item-databases', { method: 'POST', token: admin.token,
            body: { projectId: pk, name: child, parentId: pid, sortOrder: 2, description: '分项工程' } }));
      }
    }
  }
  await buildTree(proj.p1, [
    ['地基与基础', ['桩基工程', '土方开挖', '防水工程']],
    ['主体结构', ['钢筋工程', '模板工程', '混凝土工程']],
    ['建筑装饰装修', ['屋面防水']],
    ['建筑电气', ['防雷接地']],
  ]);
  await buildTree(proj.p2, [
    ['道路工程', ['路基工程', '路面工程']],
    ['给排水工程', ['管道安装']],
  ]);

  // 14. 工作标准配置
  section('工作标准配置');
  const standards = [
    ['旁站监理范围', '旁站管理', 'GB 50319', '混凝土浇筑、预应力张拉、土方回填等关键部位必须全程旁站。'],
    ['监理日记填写规范', '日记管理', 'DBJ 本地标', '日记当日 22:00 前提交，天气、部位、问题三要素齐全并附现场照片。'],
    ['隐蔽验收提前报审', '验收管理', 'GB 50204', '隐蔽工程提前 24 小时报监理验收，未验收不得封闭。'],
    ['危大工程巡查频次', '安全管理', '住建部 37 号令', '超过一定规模的危大工程施工期间每日巡查不少于 1 次。'],
    ['实测实量合格率', '质量管理', '集团标杆标', '混凝土结构垂直度/平整度合格率不低于 95%。'],
    ['安全日志上报时限', '安全管理', '公司制度', '安全日志当日 18:00 前提交，重大隐患即时上报。'],
    ['资料归档命名规则', '资料管理', '公司制度', '资料文件名采用"分部-分项-日期"格式，上传后关联分项树。'],
    ['监理通知单闭环', '协调管理', 'GB/T 50319', '通知单下发后 3 日内必须取得书面回复并复查闭环。'],
  ];
  for (const [name, module, standard, description] of standards) {
    await step('工作标准：' + name, () =>
      req('/work-standard-configs', { method: 'POST', token: admin.token, body: { name, module, standard, description } }));
  }

  // 15. 项目资料上传
  section('项目资料上传');
  const p1Subs = (await req('/sub-item-databases?projectId=' + proj.p1 + '&pageSize=100', { token: admin.token })).list;
  const p2Subs = (await req('/sub-item-databases?projectId=' + proj.p2 + '&pageSize=100', { token: admin.token })).list;
  const docs = [
    [wang, proj.p1, p1Subs, '钢筋工程', '钢筋隐蔽验收记录-3层.txt', '3# 楼 3 层梁板钢筋隐蔽验收记录（演示文本），保护层垫块整改后照片见附件。'],
    [chen, proj.p1, p1Subs, '混凝土工程', '混凝土浇筑令.txt', '浇筑部位 3# 楼顶层；坍落度抽测记录齐全；试块留置 3 组。'],
    [zhou, proj.p2, p2Subs, '管道安装', '闭水试验报告-K1+300.txt', '污水管道 K1+300 段闭水试验，渗水量满足规范，结论合格。'],
    [zhou, proj.p2, p2Subs, '路基工程', '水稳层摊铺检查记录.txt', '水稳基层摊铺厚度、压实度自检记录，检验合格。'],
    [wang, proj.p1, p1Subs, '防水工程', '底板防水验收记录.txt', 'SBS 卷材防水搭接宽度、附加层检查记录。'],
  ];
  for (const [s, pk, subs, subName, filename, content] of docs) {
    const sub = subs.find(x => x.name === subName);
    if (!sub) { continue; }
    await step('上传资料：' + filename, () => uploadDoc(s.token, pk, sub.id, filename, content));
  }

  // 16. 汇总核验
  section('生成结果核验');
  const checks = [
    ['项目台账', '/projects?pageSize=50'], ['人员', '/users?pageSize=50'], ['部门', '/departments?pageSize=50'],
    ['监理日记', '/supervision-diaries?pageSize=100'], ['监理日志', '/supervision-logs?pageSize=50'],
    ['日常巡检', '/daily-inspections?pageSize=50'], ['旁站记录', '/sideline-inspections?pageSize=50'],
    ['安全日志', '/safety-logs?pageSize=50'], ['会议纪要', '/meeting-minutes?pageSize=50'],
    ['监理通知单', '/supervision-notices?pageSize=50'], ['工作联系单', '/work-contacts?pageSize=50'],
    ['监理月报', '/supervision-monthly-reports?pageSize=50'], ['消息', '/messages?pageSize=50'],
    ['分项', '/sub-item-databases?pageSize=50'], ['工作标准', '/work-standard-configs?pageSize=50'],
    ['项目资料', '/project-documents?pageSize=50'], ['操作日志', '/operation-logs?pageSize=10'],
  ];
  console.log('\n================ 数据总量 ================');
  for (const [label, path] of checks) {
    try { const page = await req(path, { token: admin.token }); console.log('  ' + label + ': ' + page.total); }
    catch (e) { console.log('  ' + label + ': 查询失败 - ' + e.message); }
  }
  try {
    const stats = await req('/dashboard/stats', { token: admin.token });
    console.log('\n================ 首页工作台指标（admin 视角）================');
    console.log('  待处理通知单: ' + stats.pendingNotices + '  待回复联系单: ' + stats.pendingContacts);
    console.log('  异常日记: ' + stats.abnormalDiaries + '  异常日志: ' + stats.abnormalLogs +
      '  异常安全日志: ' + stats.abnormalSafetyLogs + '  未读消息: ' + stats.unreadMessages);
  } catch (e) { console.log('  工作台指标查询失败: ' + e.message); }

  console.log('\n================ 演示账号（密码统一 123456）================');
  console.log('  手机号          姓名     角色视角           可见范围');
  console.log('  13800000000    admin    系统管理员         全部项目');
  console.log('  13800000001    赵建国   总监(项目一负责人)  项目一为主');
  console.log('  13800000003    李慧敏   总监(项目二负责人)  项目二');
  console.log('  13800000004    王强     监理员(填报)       项目一');
  console.log('  13800000005    陈静     安全监理员(填报)   项目一');
  console.log('  13800000006    刘洋     总监代表(可审核)   项目二');
  console.log('  13800000007    周敏     资料员(填报)       项目二');
  console.log('  13800000008    吴十     已禁用(边界演示)   登录被拦截');
  console.log('\n================ 执行统计 ================');
  console.log('  成功: ' + okCount + ' 项   失败: ' + failCount + ' 项');
  if (failures.length) { console.log('  失败明细:'); failures.forEach(f => console.log('   - ' + f)); }
  console.log('\n完成！请打开 http://localhost:8081/login.html 用上述任一账号登录演示。');
})().catch(e => {
  console.error('\n[中断] ' + e.message);
  console.error('请确认《一键启动.bat》已运行且后端日志无报错（logs/e2e-backend.log）。');
  process.exit(1);
});
