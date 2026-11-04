const BASE = 'http://127.0.0.1:8080/api';
async function req(p, o = {}) {
  const r = await fetch(BASE + p, o);
  const j = await r.json().catch(() => ({}));
  return j;
}
(async () => {
  const login = await req('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '123456' }) });
  const token = login.data && login.data.token;
  const res = await req('/projects?pageSize=300', { headers: { Authorization: 'Bearer ' + token } });
  const d = res.data || {};
  const list = d.records || d.list || [];
  console.log('项目总数 total =', d.total, ' 返回条数 =', list.length);
  list.forEach(p => console.log(`  id=${p.id}  ${p.name}`));
})();
