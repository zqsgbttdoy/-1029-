// 静态核验：页面内联事件处理器 / onclick 中引用的函数是否都有定义
// 用途：定位"点了没反应"类缺陷（函数不存在时浏览器只在控制台报 ReferenceError）
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '补后端');
const file = path.join(root, 'supervision-notice.html');
const html = fs.readFileSync(file, 'utf8');

// 1) 收集所有内联 on* 属性里调用的函数名
const handlers = [];
const attrRe = /\son[a-z]+\s*=\s*"([^"]*)"/g;
let m;
while ((m = attrRe.exec(html))) handlers.push(m[1]);

// 2) 收集 <a href="javascript:xxx()"> 形式
const jsHref = [];
const hrefRe = /href\s*=\s*"javascript:([^"]*)"/g;
while ((m = hrefRe.exec(html))) jsHref.push(m[1]);

// 3) 收集内联脚本
const scripts = [];
const scriptRe = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
while ((m = scriptRe.exec(html))) scripts.push(m[1]);

const code = scripts.join('\n;\n');
const declared = new Set();
const defRe = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
while ((m = defRe.exec(code))) declared.add(m[1]);
const varRe = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function/g;
while ((m = varRe.exec(code))) declared.add(m[1]);
const varListRe = /(?:var|let|const)\s+([^;]+);/g;
while ((m = varListRe.exec(code))) {
    m[1].split(',').forEach(function (part) {
        const name = part.split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    });
}

// 4) 提取调用名（排除 alert 等原生 API）
const natives = new Set(['alert', 'confirm', 'prompt', 'open', 'print', 'location', 'close', 'focus', 'reload']);
const calls = new Map();
function scan(text, source) {
    const callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
    let c;
    while ((c = callRe.exec(text))) {
        const name = c[1];
        // 形如 event.stopPropagation() / document.getElementById() 的成员方法调用不计入
        const before = text.slice(0, c.index).replace(/\s+$/, '');
        if (before.endsWith('.')) continue;
        if (natives.has(name)) continue;
        if (['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'this'].indexOf(name) > -1) continue;
        if (!calls.has(name)) calls.set(name, new Set());
        calls.get(name).add(source);
    }
}
handlers.forEach(function (h) { scan(h, '内联事件'); });
jsHref.forEach(function (h) { scan(h, 'javascript: href'); });

const missing = [];
calls.forEach(function (sources, name) {
    if (!declared.has(name)) missing.push({ 函数: name, 出现位置: Array.from(sources).join('/') });
});

// 5) 语法检查（与 qa22-page-checks 同口径）
let syntax = 'OK';
try { new vm.Script(code, { filename: 'supervision-notice.inline.js' }); }
catch (e) { syntax = e.message; }

// 6) 关键 ID 引用核验：脚本里 getElementById('x') 的 x 是否在 HTML 中存在
const ids = new Set();
const idRe = /\bid\s*=\s*"([^"]+)"/g;
while ((m = idRe.exec(html))) ids.add(m[1]);
const missingIds = [];
const getIdRe = /getElementById\(\s*'([^']+)'\s*\)/g;
const seenId = new Set();
while ((m = getIdRe.exec(code))) {
    const id = m[1];
    if (seenId.has(id)) continue;
    seenId.add(id);
    if (!ids.has(id)) missingIds.push(id);
}

const result = {
    检查页面: 'supervision-notice.html',
    内联事件数: handlers.length + jsHref.length,
    脚本函数定义数: declared.size,
    语法检查: syntax,
    未定义的处理器: missing,
    引用了不存在的元素ID: missingIds
};
console.log(JSON.stringify(result, null, 2));

const outDir = path.join(__dirname, '全面验证-20261021');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '通知单页面处理器核验.json'), JSON.stringify(result, null, 2), 'utf8');
const bad = missing.length + missingIds.length;
console.log(bad === 0 && syntax === 'OK' ? '\n结果：全部通过' : '\n结果：存在 ' + bad + ' 项问题');
process.exit(bad === 0 && syntax === 'OK' ? 0 : 1);
