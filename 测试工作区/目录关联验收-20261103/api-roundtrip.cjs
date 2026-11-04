// 附件级工程资料目录 dirs 全链路往返集成测试（直连本机后端 8080，无需 GUI）。
// 覆盖 6 类业务表单：safety-log / meeting-minutes / monthly-report / work-contact / diary / log。
// 断言：写入 attachments[].dirs 后，GET 记录解析回的 attachments JSON 中 dirs 与写入完全一致（持久化 + 详情/编辑回显同源）。
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080';
const results = [];
let token;

async function api(url, method = 'GET', body, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
    ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}),
    ...extraHeaders
  };
  const response = await fetch(BASE + '/api' + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch (_) { throw new Error(`${method} ${url}: HTTP ${response.status} 非 JSON：${text.slice(0, 200)}`); }
  if (!response.ok || result.code !== 200) throw new Error(`${method} ${url}: ${JSON.stringify(result)}`);
  return result.data;
}

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(detail => { results.push({ name, pass: true }); console.log('PASS ' + name + (detail ? ' ' + JSON.stringify(detail) : '')); })
    .catch(err => { results.push({ name, pass: false, error: String(err.message || err) }); console.log('FAIL ' + name + ' -> ' + (err.message || err)); throw err; });
}

// 真实上传一个文件（multipart），返回后端登记的 url；附件 URL 必须来自 /files/upload 才能通过归属校验。
async function uploadRealFile(name) {
  const form = new FormData();
  // 最小合法 PNG 字节流（扩展名白名单校验为主）
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  form.append('file', new Blob([bytes], { type: 'image/png' }), name);
  const response = await fetch(BASE + '/api/files/upload', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch (_) { throw new Error('上传返回非 JSON：HTTP ' + response.status + ' ' + text.slice(0, 200)); }
  if (!response.ok || result.code !== 200) throw new Error('文件上传失败：' + JSON.stringify(result));
  return result.data.url;
}

// 从末级目录构造附件 dirs（完整路径数组，与前端 selectedDirPaths 语义一致）
const leafDirs = ['主楼单位工程 / 钢筋分项工程', '裙楼单位工程 / 模板分项工程'];
function attachmentsWithDirs(url) {
  return JSON.stringify([{ url, name: '目录绑定验收.png', size: 1024, dirs: leafDirs.slice() }]);
}

(async () => {
  const run = randomUUID().slice(0, 8);
  token = (await api('/auth/login', 'POST', { username: 'admin', password: '123456' })).token;

  // 项目 + 目录树（多级，取末级叶子）
  const project = await api('/projects', 'POST', { name: '目录关联验收项目-' + run, code: 'DIRTEST-' + run, buildUnit: '验收建设单位', status: 'active', managerId: 1 });
  const rootA = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '主楼单位工程', sortOrder: 1 });
  await api('/sub-item-databases', 'POST', { projectId: project.id, parentId: rootA.id, name: '钢筋分项工程', sortOrder: 1 });
  const rootB = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '裙楼单位工程', sortOrder: 2 });
  const leafB = await api('/sub-item-databases', 'POST', { projectId: project.id, parentId: rootB.id, name: '模板分项工程', sortOrder: 1 });
  // 一个被删除（inactive）的目录，不应出现在候选
  const dropped = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '已删除目录', sortOrder: 3 });
  await api('/sub-item-databases/' + dropped.id, 'DELETE');

  const fakeUrl = await uploadRealFile('dirtest-' + run + '.png');

  // 数据契约：/sub-item-databases/tree 返回全部节点（含 status=inactive 软删除），
  // 前端目录选择器必须自行按 status!=='inactive' 过滤，只有 active 末级叶子可绑定。
  await check('目录树接口返回全部节点；按 active 过滤后得有效叶子、剔除已删除目录', async () => {
    const tree = await api('/sub-item-databases/tree?projectId=' + project.id);
    const allLeaves = [];
    const activeLeaves = [];
    (function walk(nodes) { (nodes || []).forEach(n => { if (n.children && n.children.length) walk(n.children); else { allLeaves.push(n); if (n.status !== 'inactive') activeLeaves.push(n); } }); })(tree);
    assert.ok(allLeaves.some(n => n.id === dropped.id), '原始树应包含被删除节点（契约：后端不过滤）');
    const ids = activeLeaves.map(n => n.id);
    assert.ok(ids.includes(leafB.id), '有效叶子应包含末级目录 ' + leafB.id);
    assert.ok(!ids.includes(dropped.id), '按 active 过滤后不应包含已删除目录');
    return { allLeafCount: allLeaves.length, activeLeafIds: ids };
  });

  const forms = [
    { label: '安全日志 safety-log', path: '/safety-logs', build: () => ({ code: 'SL-' + run, projectId: project.id, logDate: '2026-11-03', status: 'draft', content: '验收', attachments: attachmentsWithDirs(fakeUrl) }) },
    { label: '会议纪要 meeting-minutes', path: '/meeting-minutes', build: () => ({ code: 'MM-' + run, projectId: project.id, meetingDate: '2026-11-03', title: '例会', status: 'draft', content: '验收', attachments: attachmentsWithDirs(fakeUrl) }) },
    { label: '监理月报 monthly-report', path: '/supervision-monthly-reports', build: () => ({ code: 'MR-' + run, projectId: project.id, reportMonth: '2026-11', status: 'draft', content: '验收', attachments: attachmentsWithDirs(fakeUrl) }) },
    { label: '工作联系单 work-contact', path: '/work-contacts', build: () => ({ code: 'WC-' + run, projectId: project.id, contactDate: '2026-11-03', title: '接收单位', status: 'draft', content: '验收', photos: '[]', attachments: attachmentsWithDirs(fakeUrl) }) },
    { label: '监理日记 diary', path: '/supervision-diaries', build: () => ({ code: 'DI-' + run, projectId: project.id, diaryDate: '2026-11-03', status: 'draft', weather: '晴', attachments: attachmentsWithDirs(fakeUrl) }), fieldRecord: true },
    { label: '监理日志 log', path: '/supervision-logs', build: () => ({ code: 'LO-' + run, projectId: project.id, logDate: '2026-11-03', status: 'draft', weather: '晴', attachments: attachmentsWithDirs(fakeUrl) }), fieldRecord: true }
  ];

  for (const form of forms) {
    await check(form.label + '：新建后附件 dirs 原样持久化（GET 详情解析一致）', async () => {
      const created = await api(form.path, 'POST', form.build());
      const fetched = await api(form.path + '/' + created.id);
      const atts = JSON.parse(fetched.attachments || '[]');
      assert.equal(atts.length, 1, '应有 1 个附件');
      assert.deepEqual(atts[0].dirs, leafDirs, '附件 dirs 应与写入完全一致');
      assert.equal(atts[0].url, fakeUrl, '附件 url 应保留');
      return { id: created.id, dirs: atts[0].dirs };
    });
  }

  // PUT 更新（编辑回显同源）：用独立编号避免与上面已创建的 work-contact 冲突
  await check('编辑（PUT）后再次读取 dirs 仍持久且可替换', async () => {
    const putCode = 'WCP-' + run;
    const created = await api('/work-contacts', 'POST', { code: putCode, projectId: project.id, contactDate: '2026-11-03', title: '接收单位', status: 'draft', content: '验收', photos: '[]', attachments: attachmentsWithDirs(fakeUrl) });
    const newAttachments = JSON.stringify([{ url: fakeUrl, name: 'x.png', size: 1, dirs: ['主楼单位工程 / 钢筋分项工程'] }]);
    await api('/work-contacts/' + created.id, 'PUT', { code: putCode, projectId: project.id, contactDate: '2026-11-03', title: '接收单位', content: '验收', status: 'draft', photos: '[]', attachments: newAttachments });
    const fetched = await api('/work-contacts/' + created.id);
    assert.deepEqual(JSON.parse(fetched.attachments)[0].dirs, ['主楼单位工程 / 钢筋分项工程']);
    return { ok: true };
  });

  const passed = results.filter(r => r.pass).length;
  console.log(`\n合计 ${passed}/${results.length} 通过`);
  if (passed !== results.length) process.exitCode = 1;
})().catch(err => { console.error('测试中断：', err.message); process.exitCode = 1; });
