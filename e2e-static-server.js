// 仅本地 E2E 验证使用：静态文件托管 + /api 反向代理
// 静态根目录：补后端\（HTML 与 assets 同级，login.html 引用 assets/app.js）
// /api/* 透传到 http://localhost:8080/api/*
const http = require('http');
const fs = require('fs');
const path = require('path');

const STATIC_ROOT = path.join(__dirname, '补后端');
const BACKEND = { host: '127.0.0.1', port: Number(process.env.E2E_BACKEND_PORT || 8080) };
const PORT = Number(process.env.E2E_STATIC_PORT || 8081);
// 默认仅监听本机（演示模式安全）；内网正式部署时由启动脚本设 E2E_STATIC_HOST=0.0.0.0 开放给局域网同事访问
const HOST = process.env.E2E_STATIC_HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf',
};

http.createServer((req, res) => {
  // 演示更新立即生效，避免旧页面/脚本与新后端混用。
  res.setHeader('Cache-Control', 'no-store');
  // /api/* 反向代理到后端
  if (req.url.startsWith('/api/') || req.url === '/api') {
    const proxyReq = http.request({
      host: BACKEND.host, port: BACKEND.port,
      path: req.url, method: req.method, headers: { ...req.headers, host: `${BACKEND.host}:${BACKEND.port}` },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 502, message: '后端不可达: ' + err.message }));
    });
    req.pipe(proxyReq);
    return;
  }

  // 静态文件
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch (_) { res.writeHead(400); res.end('Bad Request'); return; }
  if (/^\/(backend|deploy|uploads|tools)(\/|$)/i.test(urlPath)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (urlPath === '/') urlPath = '/login.html';
  const filePath = path.normalize(path.join(STATIC_ROOT, urlPath));
  if (!filePath.startsWith(STATIC_ROOT + path.sep)) { // 防目录穿越
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}).listen(PORT, HOST, () => {
  console.log(`E2E static server: http://localhost:${PORT}/login.html (root=${STATIC_ROOT}, /api -> :${BACKEND.port}, bind=${HOST})`);
});
