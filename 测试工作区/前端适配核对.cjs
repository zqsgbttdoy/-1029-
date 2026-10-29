// 前端适配全量核对脚本（一次性工具，可重复执行）
// 用法: node 前端适配核对.cjs [输出目录名]
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, '补后端');
const OUT_DIR = path.join(__dirname, process.argv[2] || '前端适配核对-20261023');
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
function add(scope, item, ok, detail) {
  results.push({ scope, item, status: ok ? 'PASS' : 'FAIL', detail });
}

// ========== 1. 静态页面：responsive.css / style.css / viewport 覆盖 ==========
const SKIP_PAGES = ['login.html', 'welcome.html']; // 无侧栏页面，历史决策为 SKIP
const htmlFiles = fs.readdirSync(BASE).filter(f => f.endsWith('.html')).sort();
for (const f of htmlFiles) {
  const c = fs.readFileSync(path.join(BASE, f), 'utf8');
  const hasResponsive = /assets\/responsive\.css/.test(c);
  const hasStyle = /assets\/style\.css/.test(c);
  const hasViewport = /name=["']viewport/.test(c);
  const isSkip = SKIP_PAGES.includes(f);
  if (!isSkip) {
    add('静态页', f, hasResponsive && hasStyle && hasViewport,
      `responsive=${hasResponsive ? '有' : '缺'} style=${hasStyle ? '有' : '缺'} viewport=${hasViewport ? '有' : '缺'}`);
  } else {
    add('静态页', f, hasViewport, `(SKIP响应式页) viewport=${hasViewport ? '有' : '缺'}`);
  }
  // link 必须插在 </head> 前且位于 inline <style> 之后才稳定生效（抽样只查位置合法）
  const idxResp = c.indexOf('assets/responsive.css');
  const idxHead = c.lastIndexOf('</head>');
  if (hasResponsive && idxResp > idxHead) {
    add('静态页', f + '(link位置)', false, 'responsive.css 引用在 </head> 之后');
  }
}

// ========== 2. 全局 CSS / JS 基座关键规则 ==========
const styleCss = fs.readFileSync(path.join(BASE, 'assets/style.css'), 'utf8');
// 现状：全局隐藏规则已集中到 responsive.css 顶部（非 style.css），@keyframes 仍在全局层 style.css
const styleCssNoComment = styleCss.replace(/\/\*[\s\S]*?\*\//g, '');
add('基座CSS', 'style.css 含@keyframes且规则无@media包裹', /@keyframes/.test(styleCssNoComment) && !/@media/.test(styleCssNoComment), '动画须脱离媒体查询，否则跨断点resize动画失效');

const respCss = fs.readFileSync(path.join(BASE, 'assets/responsive.css'), 'utf8');
const respNoComments = respCss.replace(/\/\*[\s\S]*?\*\//g, '');
add('基座CSS', 'responsive.css 全局层隐藏汉堡按钮', (/^\.mobile-menu-btn\s*\{[^}]*display:\s*none\s*!important/m).test(respNoComments.substring(0, respNoComments.indexOf('@media'))), '须在任何@media之外的全局段');
add('基座CSS', 'responsive.css 全局层隐藏遮罩层', (/^\.sidebar-backdrop\s*\{[^}]*display:\s*none\s*!important/m).test(respNoComments.substring(0, respNoComments.indexOf('@media'))), '');
add('基座CSS', 'responsive.css ≤768 反转显示汉堡按钮', /@media[^{]*max-width:\s*768px[\s\S]*\.mobile-menu-btn\s*\{[^}]*display:\s*flex\s*!important/.test(respCss), '');
add('基座CSS', 'responsive.css 桌面防御 transform:none', /@media[^}]*min-width:\s*76?9?px[\s\S]*?\.sidebar\s*\{[^}]*transform:\s*none\s*!important/.test(respCss), '');
add('基座CSS', '移动端输入框 font-size:16px 防iOS缩放', /font-size:\s*16px\s*!important/.test(respCss), '');
const respNoKeyframes = (respCss.replace(/\/\*[\s\S]*?\*\//g, '').match(/@keyframes/g) || []).length === 0;
add('基座CSS', 'responsive.css 不重复定义@keyframes', respNoKeyframes, '');

const appJs = fs.readFileSync(path.join(BASE, 'assets/app.js'), 'utf8');
add('基座JS', 'app.js 含 initMobileMenu', /function initMobileMenu|initMobileMenu\s*\(/.test(appJs), '');
add('基座JS', 'app.js 防重复注入标记', /__mobileMenuInited/.test(appJs), '');
add('基座JS', 'app.js resize 跨断点清理', /resize/.test(appJs) && /toggleMenu/.test(appJs), '');

// ========== 3. 小程序适配层 ==========
const MP = path.join(BASE, 'miniprogram');
if (fs.existsSync(MP)) {
  const cfgRaw = fs.readFileSync(path.join(MP, 'config.js'), 'utf8');
  const mBase = cfgRaw.match(/baseUrl\s*:\s*['"]([^'"]+)['"]/);
  const cfg = { baseUrl: mBase ? mBase[1] : '' };
  add('小程序', 'config.js baseUrl 指向 8081 静态代理', /:8081/.test(cfg.baseUrl) && !/\/api\/?$/.test(cfg.baseUrl), 'baseUrl=' + cfg.baseUrl);

  const pcj = JSON.parse(fs.readFileSync(path.join(MP, 'project.config.json'), 'utf8'));
  add('小程序', 'project.config.json urlCheck=false', pcj.setting && pcj.setting.urlCheck === false, 'urlCheck=' + (pcj.setting && pcj.setting.urlCheck));

  // wxml 中禁止 HTML 实体写法（历史报错根因）
  const wxmlFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.wxml')) wxmlFiles.push(p);
    }
  })(path.join(MP, 'pages'));
  let entityHit = [];
  for (const w of wxmlFiles) {
    const c = fs.readFileSync(w, 'utf8');
    const re = /\{\{[^}]*&(?:amp|lt|gt|quot|#\d+);[^}]*\}\}/g;
    let m;
    while ((m = re.exec(c)) !== null) entityHit.push(path.relative(MP, w) + ' → ' + m[0].slice(0, 60));
  }
  add('小程序', 'wxml {{}} 内无 HTML 实体(共' + wxmlFiles.length + '个wxml)', entityHit.length === 0, entityHit.join(' | '));

  // app.json 页面注册与实际文件一致（页面级 index.json 在 app.json 已配全局 window 时可省略）
  const appJson = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));
  let missing = [];
  const needPageJson = !appJson.window;
  for (const p of appJson.pages) {
    for (const ext of needPageJson ? ['.js', '.wxml', '.json'] : ['.js', '.wxml']) {
      if (!fs.existsSync(path.join(MP, p + ext))) missing.push(p + ext);
    }
  }
  add('小程序', 'app.json 注册的页面文件齐全' + (needPageJson ? '' : '(全局window已配,页面json可省)'), missing.length === 0, missing.join(','));
} else {
  add('小程序', 'miniprogram 目录', false, '目录不存在');
}

// ========== 输出 ==========
const fails = results.filter(r => r.status === 'FAIL');
const lines = [];
lines.push('前端适配核对报告  ' + new Date().toISOString());
lines.push('='.repeat(70));
let lastScope = '';
for (const r of results) {
  if (r.scope !== lastScope) { lines.push(''); lines.push('【' + r.scope + '】'); lastScope = r.scope; }
  lines.push((r.status === 'PASS' ? '  ✅ ' : '  ❌ ') + r.item + (r.detail ? '  [' + r.detail + ']' : ''));
}
lines.push('');
lines.push(`合计 ${results.length} 项，PASS ${results.length - fails.length}，FAIL ${fails.length}`);
const report = lines.join('\r\n');
console.log(report);
fs.writeFileSync(path.join(OUT_DIR, '前端适配核对报告.txt'), report, 'utf8');
fs.writeFileSync(path.join(OUT_DIR, '前端适配核对结果.csv'),
  '范围,检查项,结果,备注\r\n' + results.map(r => `${r.scope},${r.item},${r.status},${r.detail}`).join('\r\n'), 'utf8');
process.exitCode = fails.length > 0 ? 1 : 0;
