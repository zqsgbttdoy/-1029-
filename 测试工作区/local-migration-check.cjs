'use strict';
// 只读比较迁移前后快照与原附件，不修改数据库，也不输出业务正文或凭据。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const [beforeArg, afterArg, filesArg, outArg] = process.argv.slice(2);
if (!beforeArg || !afterArg || !filesArg || !outArg) throw new Error('参数：迁移前快照目录 迁移后快照目录 文件清单目录 报告子目录');
const out = path.resolve(__dirname, outArg);
if (!out.startsWith(__dirname + path.sep)) throw new Error('报告必须放在测试工作区');
const data = path.join(root, 'local-data');
function properties(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(s => s && !s.startsWith('#')).map(s => {
    const pos = s.indexOf('=');
    if (pos < 1) throw new Error('无效核验清单');
    return [s.slice(0, pos), s.slice(pos + 1)];
  }));
}
function privatePath(relative, file) {
  const resolved = path.resolve(root, relative, file);
  if (!resolved.startsWith(data + path.sep)) throw new Error('只允许读取 local-data 下的私有快照');
  return resolved;
}
const before = properties(privatePath(beforeArg, 'tables.properties'));
const after = properties(privatePath(afterArg, 'tables.properties'));
const tables = Object.keys(before).filter(k => k.endsWith('.count')).map(k => k.slice(0, -6));
const results = tables.map(table => ({ table, count: Number(after[table + '.count']), pass: Object.keys(before).filter(k => k.startsWith(table + '.')).every(k => before[k] === after[k]) }));
const manifest = properties(privatePath(filesArg, 'files.properties'));
let filesChecked = 0;
const fileFailures = [];
for (const [relative, digest] of Object.entries(manifest)) {
  const file = path.resolve(data, 'uploads', relative);
  if (!file.startsWith(path.join(data, 'uploads') + path.sep)) throw new Error('附件路径越界');
  if (!fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== digest) fileFailures.push(relative);
  filesChecked++;
}
const report = {
  checkedAt: new Date().toISOString(), mode: '只读；无业务数据修改',
  tables: results, tableCount: results.length,
  snapshotKeysUnchanged: Object.keys(before).length === Object.keys(after).length && Object.keys(before).every(k => before[k] === after[k]),
  filesChecked, fileFailures,
  passed: results.filter(r => r.pass).length + filesChecked - fileFailures.length,
  failed: results.filter(r => !r.pass).length + fileFailures.length
};
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, '迁移后只读核验.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ tableCount: report.tableCount, filesChecked, passed: report.passed, failed: report.failed, snapshotKeysUnchanged: report.snapshotKeysUnchanged }));
if (report.failed || !report.snapshotKeysUnchanged) process.exitCode = 1;
