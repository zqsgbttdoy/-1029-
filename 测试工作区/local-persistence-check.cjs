'use strict';
// 独立文件库的真实进程重启验证；固定隔离端口，不请求用户的 8080/8081。
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const out = path.resolve(__dirname, process.argv[2] || '全面验证-20261022-数据留存');
if (!out.startsWith(__dirname + path.sep)) throw new Error('报告只能写入测试工作区');
fs.mkdirSync(out, { recursive: true });
const reportFile = path.join(out, '文件库进程重启验证.json');
if (fs.existsSync(reportFile)) throw new Error('已有验证报告，请使用新的输出目录');
const dataDir = path.join(root, 'local-data', 'verification', randomUUID());
let jar = path.join(root, '补后端/backend/target/supervision-site-management-1.0.0.jar');
const java = process.env.QA_JAVA || path.join(process.env.JAVA_HOME || 'C:/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot', 'bin/java.exe');
const base = 'http://127.0.0.1:18090';
const results = [];
let child, token, launchCount = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function check(title, ok) {
  results.push({ title, pass: !!ok });
  console.log((ok ? '[PASS] ' : '[FAIL] ') + title);
  if (!ok) throw new Error(title);
}
async function rebuildIsolatedPackage() {
  // 复制源码到独立构建目录，绝不覆盖用户正在使用的 jar 或手工数据库。
  const source = path.join(root, '补后端/backend');
  const build = path.join(dataDir, 'rebuild-backend');
  fs.mkdirSync(build, { recursive: true });
  fs.copyFileSync(path.join(source, 'pom.xml'), path.join(build, 'pom.xml'));
  fs.cpSync(path.join(source, 'src/main'), path.join(build, 'src/main'), { recursive: true, errorOnExist: true, force: false });
  const log = fs.openSync(path.join(out, 'isolated-rebuild.log'), 'a');
  const env = { ...process.env, JAVA_HOME: path.dirname(path.dirname(java)), QA_REBUILD_MVN: process.env.QA_MVN || 'mvn.cmd', QA_REBUILD_POM: path.join(build, 'pom.xml'), QA_REBUILD_REPO: path.join(root, '.m2-cache') };
  Object.keys(env).filter(k => /^SPRING_|^APP_LOCAL_DATA_DIR$|^APP_UPLOAD_DIR$/.test(k)).forEach(k => delete env[k]);
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', ['-NoProfile', '-Command', '& $env:QA_REBUILD_MVN -o -B -f $env:QA_REBUILD_POM "-Dmaven.repo.local=$env:QA_REBUILD_REPO" "-Dmaven.test.skip=true" package; exit $LASTEXITCODE'], { cwd: build, env, stdio: ['ignore', log, log] });
      proc.once('error', reject);
      proc.once('exit', code => code === 0 ? resolve() : reject(new Error('隔离重建失败，查看 isolated-rebuild.log')));
    });
  } finally { fs.closeSync(log); }
  jar = path.join(build, 'target/supervision-site-management-1.0.0.jar');
  check('从源码独立重建程序包成功，未触碰运行中的程序包', fs.existsSync(jar));
}
async function freePort() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error('18090 已被占用，禁止复用未知实例')));
    probe.listen(18090, '127.0.0.1', () => probe.close(resolve));
  });
}
async function launch() {
  await freePort();
  const env = { ...process.env };
  Object.keys(env).filter(k => /^SPRING_|^APP_LOCAL_DATA_DIR$|^APP_UPLOAD_DIR$/.test(k)).forEach(k => delete env[k]);
  const log = fs.openSync(path.join(out, 'local-runtime-' + (++launchCount) + '.log'), 'a');
  child = spawn(java, ['-Dfile.encoding=UTF-8', '-jar', jar, '--spring.profiles.active=local', '--server.port=18090', '--app.local.data-dir=' + dataDir.replace(/\\/g, '/')], { cwd: root, env, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  let spawnError;
  child.once('error', e => { spawnError = e; });
  for (let i = 0; i < 150; i++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('隔离后端启动失败，请查 local-runtime 日志');
    try {
      const r = await fetch(base + '/api/local/status', { signal: AbortSignal.timeout(1000) });
      const state = await r.json();
      if (r.ok && state.ready && state.persistent && state.pid === child.pid) return;
    } catch (_) { }
    await sleep(1000);
  }
  throw new Error('隔离后端未就绪');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('隔离后端未停止')), 15000);
    current.once('exit', () => { clearTimeout(timeout); resolve(); });
    current.kill();
  });
  child = null;
  await sleep(500);
}
async function request(route, method = 'GET', body, extra = {}, expected = 200) {
  const r = await fetch(base + '/api' + route, {
    method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000)
  });
  const json = await r.json();
  if (r.status !== expected || (expected === 200 && json.code !== 200)) throw new Error(method + ' ' + route + ' HTTP=' + r.status + ' ' + (json.message || ''));
  return json.data;
}
async function login(password) {
  token = null;
  token = (await request('/auth/login', 'POST', { username: 'admin', password })).token;
}
async function upload(name, content, type) {
  const body = new FormData();
  body.append('file', new Blob([content], { type }), name);
  const r = await fetch(base + '/api/files/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body });
  const json = await r.json();
  if (!r.ok || json.code !== 200) throw new Error('隔离附件上传失败');
  return json.data;
}
async function main() {
  await launch();
  await login('123456');
  check('全新文件库启动并初始化 admin', !!token);
  const project = await request('/projects', 'POST', { name: '独立留存测试项目', code: 'LOCAL-' + Date.now(), buildUnit: '测试建设单位', status: 'active', managerId: 1 });
  const department = await request('/departments', 'POST', { name: '手工留存部门', status: 'active' });
  const text = '重启后附件原文仍在';
  const file = await upload('留存附件.txt', text, 'text/plain');
  const photo = await upload('留存照片.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), 'image/png');
  const notice = await request('/supervision-notices', 'POST', { projectId: project.id, code: 'LOCAL-NOTICE', noticeDate: '2026-10-22', title: '真实进程留存验证', content: '已保存的手工正文', status: 'issued', attachments: JSON.stringify([file]), photos: JSON.stringify([photo]) });
  let diary = await request('/supervision-diaries', 'POST', { projectId: project.id, diaryDate: '2026-10-22', weather: '晴', construction: '管理员完整填写内容', photos: JSON.stringify([photo]) }, { 'Idempotency-Key': randomUUID() });
  check('保存草稿不自动审批', diary.status === 'draft');
  diary = await request('/supervision-diaries/' + diary.id + '/submit', 'POST', null, { 'X-Record-Version': String(diary.lockVersion) });
  check('提交后仍待审核', diary.status === 'submitted');
  diary = await request('/supervision-diaries/' + diary.id + '/approve', 'POST', { status: 'approved' }, { 'X-Record-Version': String(diary.lockVersion) });
  check('admin 明确确认后审批通过', diary.status === 'approved');
  const changed = 'Test-Only-' + randomUUID().slice(0, 12);
  await request('/auth/change-password', 'POST', { oldPassword: '123456', newPassword: changed });
  const users = (await request('/users?pageSize=200')).total;
  for (let i = 1; i <= 3; i++) {
    await stop();
    check('第' + i + '次停止后数据库文件存在', fs.existsSync(path.join(dataDir, 'db/supervision.mv.db')));
    if (i === 3) await rebuildIsolatedPackage();
    await launch();
    await login(changed);
    check('第' + i + '次重启保留修改后的密码及种子数量', !!token && (await request('/users?pageSize=200')).total === users);
    const saved = await request('/supervision-notices/' + notice.id);
    check('第' + i + '次重启保留通知单主键正文状态', saved.id === notice.id && saved.content === notice.content && saved.status === notice.status);
    check('第' + i + '次重启保留附件与照片关联', saved.attachments === notice.attachments && saved.photos === notice.photos);
    const access = await request('/files/access?url=' + encodeURIComponent(file.url));
    const response = await fetch(new URL(access.url, base));
    check('第' + i + '次重启原附件可下载', response.ok && await response.text() === text);
    check('第' + i + '次重启保留审批结果', (await request('/supervision-diaries/' + diary.id)).status === 'approved');
    check('第' + i + '次重启保留已有部门及项目记录', (await request('/departments?pageSize=200')).list.some(d => d.id === department.id && d.name === department.name) && (await request('/projects/' + project.id)).code === project.code);
    const added = await request('/departments', 'POST', { name: '重启后新增部门' + i, status: 'active' });
    check('第' + i + '次重启可新增且自增编号不冲突', added.id > department.id);
  }
  await stop();
}
main().catch(e => { results.push({ title: '执行异常', pass: false, error: e.message }); console.error(e.message); process.exitCode = 1; }).finally(async () => {
  await stop().catch(e => { console.error(e.message); process.exitCode = 1; });
  fs.writeFileSync(reportFile, JSON.stringify({ base, launches: launchCount, passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, results }, null, 2));
});
