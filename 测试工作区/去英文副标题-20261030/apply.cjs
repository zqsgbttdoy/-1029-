// 去掉页面上的英文副标题 "Supervision Site Management(System)" 并微调留白
// 用法：node apply.cjs --dry 先看计数；node apply.cjs --apply 实际写入
const fs = require('node:fs'), path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '补后端');
const APPLY = process.argv.includes('--apply');

const RULES = [
  // 1. 侧栏单行形式（22 个页面）
  { name: 'sidebar-inline', find: '<h2>监理现场管理系统</h2><p>Supervision Site Management</p></div>', to: '<h2>监理现场管理系统</h2></div>' },
  // 2. 侧栏多行形式（index / project-ledger）
  { name: 'sidebar-multiline', re: /^[ \t]*<p>Supervision Site Management<\/p>\r?\n/gm, to: '', expect: 2 },
  // 3. 登录页卡片副标题
  { name: 'login-subtitle', re: /^[ \t]*<p>Supervision Site Management System<\/p>\r?\n/gm, to: '', expect: 1 },
  // 4. 欢迎页顶栏品牌副标题
  { name: 'welcome-span', find: '<b>监理现场管理系统</b><span>Supervision Site Management</span>', to: '<b>监理现场管理系统</b>' },
  // 5. 侧栏副标题样式整行删除
  { name: 'css-sidebar-p', re: /^[ \t]*\.sidebar-logo p \{[^\r\n]*\r?\n/gm, to: '' },
  // 6. 侧栏留白与标题层级：去掉副标题后单行标题居中，略放大字号与字距
  { name: 'css-sidebar-box', find: '.sidebar-logo { padding: 20px; text-align: center;', to: '.sidebar-logo { padding: 22px 16px; text-align: center;' },
  { name: 'css-sidebar-h2', find: '.sidebar-logo h2 { font-size: 16px; font-weight: 600; letter-spacing: 1px; }', to: '.sidebar-logo h2 { font-size: 17px; font-weight: 600; letter-spacing: 2px; }' },
  // 7. 折叠态隐藏列表里不再需要 p
  { name: 'css-collapse', find: '.sidebar .menu-group-title, .sidebar-logo p, .sidebar-logo h2, .menu-item .icon + *', to: '.sidebar .menu-group-title, .sidebar-logo h2, .menu-item .icon + *' },
  // 8. 登录页：删副标题样式，标题与图标间距微调
  { name: 'css-login-p', re: /^[ \t]*\.login-logo p \{[^\r\n]*\r?\n/gm, to: '', expect: 1 },
  { name: 'css-login-h1', find: '.login-logo h1 { font-size: 20px; color: #1e3a8a; margin-top: 8px; }', to: '.login-logo h1 { font-size: 21px; color: #1e3a8a; margin-top: 10px; letter-spacing: 1px; }' },
  // 9. 欢迎页：删副标题样式，品牌名略放大
  { name: 'css-welcome-span', re: /^[ \t]*\.topbar \.brand span \{[^\r\n]*\r?\n/gm, to: '', expect: 1 },
  { name: 'css-welcome-b', find: '.topbar .brand b { font-size: 16px;', to: '.topbar .brand b { font-size: 17px;' }
];

const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).sort();
const tally = Object.fromEntries(RULES.map(r => [r.name, 0]));
const touched = [];

for (const file of files) {
  const full = path.join(ROOT, file);
  const before = fs.readFileSync(full, 'utf8');
  let text = before;
  const hits = [];
  for (const rule of RULES) {
    let count = 0;
    if (rule.re) {
      text = text.replace(rule.re, () => { count++; return rule.to; });
    } else if (text.includes(rule.find)) {
      count = text.split(rule.find).length - 1;
      text = text.split(rule.find).join(rule.to);
    }
    if (count) { tally[rule.name] += count; hits.push(rule.name + '×' + count); }
  }
  if (hits.length) {
    touched.push(file + ' -> ' + hits.join(', '));
    if (APPLY) fs.writeFileSync(full, text, 'utf8');
  }
}

console.log((APPLY ? 'APPLY' : 'DRY') + ' 涉及文件 ' + touched.length + ' / ' + files.length);
touched.forEach(line => console.log('  ' + line));
console.log('规则命中：' + JSON.stringify(tally));
if (touched.length && touched.some(l => l.includes('sidebar-inline'))) console.log('提示：sidebar-inline 预期 22，multiline 预期 2，login-subtitle 预期 1，welcome-span 预期 1');
