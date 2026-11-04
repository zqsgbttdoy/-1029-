const BASE = 'http://127.0.0.1:8080/api';
const TEST_PREFIX = ['目录关联验收项目', '浏览器目录验收项目', '浏览器无目录项目', '浏览器跨项目对照'];
const TEST_IDS = new Set([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
const KEEP = ['雪后多伦多', '雨后温哥华'];
async function req(p, o = {}) { const r = await fetch(BASE + p, o); return r.json().catch(() => ({})); }
(async () => {
  const login = await req('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '123456' }) });
  const H = { Authorization: 'Bearer ' + login.data.token };
  const res = await req('/projects?pageSize=300', { headers: H });
  const list = res.data.records || res.data.list || [];
  let removed = 0;
  for (const p of list) {
    const isTest = TEST_IDS.has(p.id) && TEST_PREFIX.some(pre => p.name.startsWith(pre));
    const isKeep = KEEP.includes(p.name);
    if (isTest && !isKeep) {
      const d = await req('/projects/' + p.id, { method: 'DELETE', headers: H });
      console.log((d.code === 200 ? '已删除' : '失败') + `  id=${p.id}  ${p.name}  (code=${d.code}${d.message ? ' ' + d.message : ''})`);
      if (d.code === 200) removed++;
    }
  }
  console.log('\n共软删除测试项目：', removed, '个');
  const after = await req('/projects?pageSize=300', { headers: H });
  console.log('清理后剩余项目：', after.data.total);
  (after.data.records || []).forEach(p => console.log(`  id=${p.id}  ${p.name}`));
})();
