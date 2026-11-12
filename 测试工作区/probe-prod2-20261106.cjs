// 只读探针2：列出全部用户、两个项目的成员候选，判断能否在不新建数据的前提下做多选验收。
const BASE = 'http://127.0.0.1:8081';
async function login() {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '123456' }) });
  const j = await r.json(); return j.data.token || j.data.accessToken;
}
async function req(path, token) {
  const res = await fetch(BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { status: res.status, json: await res.json().catch(() => null), text: '' };
}
(async () => {
  const t = await login();
  const users = await req('/api/users?size=200', t);
  const ul = (users.json && users.json.data && (users.json.data.content || users.json.data.records || users.json.data.list)) || [];
  console.log('USERS count=' + ul.length);
  for (const u of ul) console.log('  user id=' + u.id, JSON.stringify(u.name || u.realName || u.username), 'status=' + u.status, 'projectId=' + (u.projectId || ''), 'position=' + (u.position || ''));
  for (const pid of [3, 2]) {
    const mo = await req('/api/field/projects/' + pid + '/member-options', t);
    console.log('MEMBER-OPTIONS project=' + pid + ' => ' + JSON.stringify(mo.json && mo.json.data));
    // 现有日志，用于测后定位与不重复计数
    const logs = await req('/api/field/supervision-logs?projectId=' + pid + '&size=200', t);
    const ll = (logs.json && logs.json.data && (logs.json.data.content || logs.json.data.records || logs.json.data.list)) || [];
    console.log('  existing supervision-logs project=' + pid + ' count=' + ll.length + ' ids=' + JSON.stringify(ll.map(x => x.id)));
  }
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
