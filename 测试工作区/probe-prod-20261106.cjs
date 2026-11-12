// 只读探针：核对正式(local)服务能否登录、现有项目与成员，供浏览器验收复用真实数据。
// 不做任何写操作。
const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8081';

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.token ? { Authorization: 'Bearer ' + opts.token } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}

(async () => {
  const pwd = process.env.PROBE_PWD || '123456';
  const login = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: pwd } });
  console.log('LOGIN', login.status, login.json && login.json.data ? (login.json.data.token ? 'TOKEN_OK' : JSON.stringify(login.json.data).slice(0, 200)) : login.text.slice(0, 200));
  const token = login.json && login.json.data && (login.json.data.token || login.json.data.accessToken);
  if (!token) { console.log('NO_TOKEN -> 需要用真实密码。停止。'); return; }

  const projects = await req('/api/projects?size=200', { token });
  const plist = (projects.json && projects.json.data && (projects.json.data.content || projects.json.data.records || projects.json.data.list) || projects.json && projects.json.data && Array.isArray(projects.json.data) ? (projects.json.data.content || projects.json.data.records || projects.json.data.list || projects.json.data) : []);
  const arr = Array.isArray(plist) ? plist : [];
  console.log('PROJECTS status=' + projects.status + ' count=' + arr.length);
  for (const p of arr.slice(0, 40)) console.log('  project', p.id, JSON.stringify(p.name), 'status=' + p.status, 'managerId=' + (p.managerId || p.projectManagerId || ''));

  // 挑选第一个 active 项目，查其成员候选
  const pick = arr.find(p => (p.status == null || String(p.status).toLowerCase() === 'active')) || arr[0];
  if (pick) {
    const members = await req('/api/field/projects/' + pick.id + '/member-options', { token });
    console.log('MEMBER-OPTIONS project=' + pick.id + ' status=' + members.status);
    console.log('  ' + (members.text || '').slice(0, 600));
  } else {
    console.log('NO_PROJECT 现有库无项目，浏览器验收需先存在项目（不新建避免污染）');
  }
})().catch(e => { console.error('PROBE_ERROR', e && e.message); process.exit(1); });
