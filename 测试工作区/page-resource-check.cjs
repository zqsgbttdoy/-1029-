'use strict';
// 页面资源可用性检查：复用项目自带 e2e-static-server.js（真实 HTTP 静态服务），
// 对 补后端/*.html 与关键共享资源做 HTTP 200 / Content-Type / 内容指纹校验。
// 不依赖后端进程（不请求 /api），不修改页面与业务源码。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const workspace = path.resolve(__dirname, '..');
const root = path.join(workspace, '补后端');
const outDir = path.resolve(__dirname, process.env.QA_OUTPUT_DIR || '全面验证-20261021');
if (!outDir.startsWith(__dirname + path.sep)) throw new Error('输出必须在测试工作区');
const port = Number(process.env.QA_STATIC_PORT || 18091);
const base = `http://127.0.0.1:${port}`;

fs.mkdirSync(outDir, { recursive: true });
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, [path.join(workspace, 'e2e-static-server.js')], {
  cwd: workspace,
  env: { ...process.env, E2E_STATIC_PORT: String(port), E2E_BACKEND_PORT: '18090' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', chunk => { serverLog += chunk.toString(); });
child.stderr.on('data', chunk => { serverLog += chunk.toString(); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + '/login.html', { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) return true;
    } catch (_) { /* 服务尚未监听 */ }
    await sleep(200);
  }
  return false;
}

async function inspect(route, expectType) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(10000), redirect: 'manual' });
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  const text = buffer.toString('utf8');
  const result = {
    route,
    status: response.status,
    contentType,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
  result.pass = response.status === 200
    && (!expectType || contentType.toLowerCase().includes(expectType))
    && buffer.length > 0
    && (expectType !== 'text/html' || /<html[\s>]/i.test(text));
  return result;
}

async function main() {
  const ready = await waitReady();
  if (!ready) throw new Error('静态服务未能在 15 秒内就绪：' + serverLog);
  const pages = fs.readdirSync(root).filter(f => f.endsWith('.html')).sort();
  const results = [];
  for (const page of pages) results.push(await inspect('/' + encodeURIComponent(page), 'text/html'));
  for (const asset of ['assets/app.js', 'assets/field-records.js', 'assets/style.css', 'assets/responsive.css', 'assets/field-records.css', 'miniprogram/utils/schema.js']) {
    results.push(await inspect('/' + asset, null));
  }
  const unknown = await inspect('/__qa_missing_page__.html', null);
  const uploads = await inspect('/uploads/', null);
  const pageResults = results.filter(r => r.route.endsWith('.html'));
  const assetResults = results.filter(r => !r.route.endsWith('.html'));
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    server: 'e2e-static-server.js（Node 静态服务，非 Nginx）',
    base,
    htmlPages: pageResults.length,
    pagesPassed: pageResults.filter(r => r.pass).length,
    assets: assetResults.length,
    assetsPassed: assetResults.filter(r => r.pass).length,
    unknownPageStatus: unknown.status,
    uploadsDirectoryStatus: uploads.status,
    counts: {
      通过: results.filter(r => r.pass).length + (unknown.status === 404 ? 1 : 0) + (uploads.status === 403 ? 1 : 0),
      失败: results.filter(r => !r.pass).length,
    },
    boundaryChecks: [
      { title: '未知页面返回 404', expected: 404, actual: unknown.status, pass: unknown.status === 404 },
      { title: '上传物理目录不可匿名访问', expected: 403, actual: uploads.status, pass: uploads.status === 403 },
    ],
    results,
  };
  fs.writeFileSync(path.join(outDir, '页面资源可用性.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    htmlPages: report.htmlPages,
    pagesPassed: report.pagesPassed,
    assetsPassed: report.assetsPassed,
    boundaryChecks: report.boundaryChecks,
    output: path.join(outDir, '页面资源可用性.json'),
  }, null, 2));
  if (report.pagesPassed !== report.htmlPages || report.assetsPassed !== report.assets
      || report.boundaryChecks.some(c => !c.pass)) process.exitCode = 1;
}

main().catch(error => {
  fs.writeFileSync(path.join(outDir, '页面资源可用性.json'), JSON.stringify({
    startedAt, finishedAt: new Date().toISOString(), error: error.message, serverLog,
  }, null, 2), 'utf8');
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  child.kill();
  await sleep(300);
});
