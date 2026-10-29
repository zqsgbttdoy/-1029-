'use strict';
// 监理通知单附件链路验证：上传 → 建单绑定 → access 换取短链 → content 取文件 → 回复附件合并
// 用法：node notice-attachment-check.cjs [输出目录名]
// 依赖：e2e 后端 8080（H2）+ 静态代理 8081 已启动
const fs = require('node:fs');
const path = require('node:path');

const API = process.env.E2E_API || 'http://127.0.0.1:8080';
const PAGE = process.env.E2E_PAGE || 'http://127.0.0.1:8081';
const outDir = path.resolve(__dirname, process.argv[2] || ('通知单附件验证-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17)));
if (!outDir.startsWith(__dirname + path.sep)) throw new Error('输出必须在测试工作区');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
function check(title, ok, actual) {
  const item = { title, result: ok ? '通过' : '失败', actual };
  results.push(item);
  console.log((ok ? '[PASS] ' : '[FAIL] ') + title + (ok ? '' : ' -> ' + JSON.stringify(actual)));
}

async function req(url, options) {
  const resp = await fetch(url, options);
  const text = await resp.text();
  let body;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { status: resp.status, headers: resp.headers, body };
}

async function login() {
  const r = await req(API + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' })
  });
  if (r.status !== 200 || !r.body || !r.body.data) throw new Error('登录失败：' + r.status + ' ' + JSON.stringify(r.body));
  return r.body.data.token;
}

async function upload(token, filename, content, type) {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: type || 'application/octet-stream' }), filename);
  const r = await req(API + '/api/files/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  if (r.status !== 200 || r.body.code !== 200) throw new Error('上传失败：' + r.status + ' ' + JSON.stringify(r.body));
  return r.body.data;
}

async function ensureProject(token) {
  const page = await req(API + '/api/projects?pageNum=1&pageSize=1', { headers: { Authorization: 'Bearer ' + token } });
  const list = (page.body && page.body.data && page.body.data.list) || [];
  if (list.length) return list[0].id;
  const created = await req(API + '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ name: '附件验证项目', code: 'ATT-' + Date.now(), buildUnit: '测试建设单位', status: 'active' })
  });
  if (created.body.code !== 200) throw new Error('建项目失败：' + JSON.stringify(created.body));
  return created.body.data.id;
}

function parseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try { const arr = JSON.parse(value); return Array.isArray(arr) ? arr : []; } catch (_) { return []; }
}

async function main() {
  const token = await login();
  check('管理员登录成功并拿到令牌', !!token, { tokenLength: token && token.length });
  const projectId = await ensureProject(token);
  check('存在可用项目', !!projectId, { projectId });

  // 1. 上传并创建带附件的通知单（模拟前端“新建时附件”）
  const pdf = await upload(token, '钢筋间距检测报告.txt', 'attachment-smoke-content', 'text/plain');
  check('上传附件返回 url/name/size', !!pdf.url && !!pdf.name, pdf);

  const noticeBody = {
    code: 'TZ-ATT-' + Date.now(),
    projectId,
    noticeDate: new Date().toISOString().slice(0, 10),
    title: '附件链路验证通知单',
    content: '用于验证附件点击下载/预览链路',
    status: 'issued',
    attachments: JSON.stringify([pdf])
  };
  const created = await req(API + '/api/supervision-notices', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(noticeBody)
  });
  check('创建通知单成功', created.status === 200 && created.body.code === 200, created.body);
  const noticeId = created.body.data && created.body.data.id;

  const detail = await req(API + '/api/supervision-notices/' + noticeId, { headers: { Authorization: 'Bearer ' + token } });
  const saved = parseList(detail.body.data && detail.body.data.attachments);
  check('详情接口回显附件', saved.length === 1 && saved[0].url === pdf.url, saved);

  // 2. 前端点击附件的真实链路：/files/access 换 120 秒短链 → 浏览器直接打开短链
  const access = await req(API + '/api/files/access?url=' + encodeURIComponent(pdf.url), { headers: { Authorization: 'Bearer ' + token } });
  const signed = access.body && access.body.data && access.body.data.url;
  check('access 接口返回短时链接', access.status === 200 && /^\/api\/files\/content\?ticket=/.test(signed || ''), access.body);

  const content = await fetch(API + signed);
  const bytes = Buffer.from(await content.arrayBuffer());
  check('短链可直接取到文件（无需登录头）', content.status === 200 && bytes.toString() === 'attachment-smoke-content',
    { status: content.status, size: bytes.length });
  check('响应头含正确 MIME 与安全头',
    /text\/plain/.test(content.headers.get('content-type') || '') && content.headers.get('x-content-type-options') === 'nosniff',
    { contentType: content.headers.get('content-type'), nosniff: content.headers.get('x-content-type-options') });
  check('响应头声明文件名（下载/预览由前端决定）', !!content.headers.get('content-disposition'), content.headers.get('content-disposition'));

  const raw = await fetch(API + pdf.url);
  check('原始 /api/uploads 路径禁止直连', raw.status === 401 || raw.status === 403 || raw.status === 404, { status: raw.status });

  // 3. 回复时的附件与照片（修复前后端丢弃这两个字段）
  const replyFile = await upload(token, '整改完成报告.txt', 'reply-content', 'text/plain');
  const replyPhoto = await upload(token, '整改后现场.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), 'image/png');
  const reply = await req(API + '/api/supervision-notices/' + noticeId + '/reply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({
      replyContent: '已按通知要求完成整改',
      attachments: JSON.stringify([replyFile]),
      photos: JSON.stringify([replyPhoto])
    })
  });
  check('回复接口接受附件字段', reply.status === 200 && reply.body.code === 200, reply.body);

  const afterReply = await req(API + '/api/supervision-notices/' + noticeId, { headers: { Authorization: 'Bearer ' + token } });
  const merged = parseList(afterReply.body.data && afterReply.body.data.attachments);
  const replyItem = merged.find(a => a.url === replyFile.url);
  check('回复附件落库并标记来源', !!replyItem && replyItem.source === 'reply', { merged });
  check('新建时附件未被回复覆盖', merged.some(a => a.url === pdf.url), merged);

  // 整改照片与附件同链路：必须落进 photos 列，否则用户选完照片提交后会凭空消失
  const afterPhotos = parseList(afterReply.body.data && afterReply.body.data.photos);
  check('回复照片落库并标记来源', afterPhotos.some(p => p.url === replyPhoto.url && p.source === 'reply'), { photos: afterPhotos });

  const replyAccess = await req(API + '/api/files/access?url=' + encodeURIComponent(replyFile.url), { headers: { Authorization: 'Bearer ' + token } });
  check('回复附件可换取短链', replyAccess.status === 200 && !!(replyAccess.body.data && replyAccess.body.data.url), replyAccess.body);

  const photoAccess = await req(API + '/api/files/access?url=' + encodeURIComponent(replyPhoto.url), { headers: { Authorization: 'Bearer ' + token } });
  check('回复照片可换取短链', photoAccess.status === 200 && !!(photoAccess.body.data && photoAccess.body.data.url), photoAccess.body);

  // 4. 页面可达性：确认修复后的页面能被静态代理正常返回
  const page = await fetch(PAGE + '/supervision-notice.html');
  const html = await page.text();
  check('页面可访问且已接入 access 换链接口', page.status === 200 && html.includes('/files/access'), { status: page.status });

  const summary = {};
  results.forEach(r => { summary[r.result] = (summary[r.result] || 0) + 1; });
  fs.writeFileSync(path.join(outDir, '通知单附件验证.json'), JSON.stringify({
    note: 'HTTP 层验证：上传、绑定、短链换取、内容下发、回复附件合并；页面部分校验脚本接入点。',
    api: API, page: PAGE, summary, results
  }, null, 2));
  console.log(JSON.stringify(summary));
  if (summary['失败']) process.exitCode = 1;
}

main().catch(e => {
  check('验证脚本执行', false, e.message);
  const summary = {}; results.forEach(r => { summary[r.result] = (summary[r.result] || 0) + 1; });
  fs.writeFileSync(path.join(outDir, '通知单附件验证.json'), JSON.stringify({ summary, results, error: e.message }, null, 2));
  console.error(e);
  process.exitCode = 1;
});
