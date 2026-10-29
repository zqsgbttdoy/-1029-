/**
 * 用户-角色绑定接口核对（本地 8080）
 * 目的：验证第二轮新增的 bind/unbind/user-map/用户侧角色读写接口，并保证核对后回到原状。
 * 用法：node 测试工作区/role-bind-check.cjs
 */
const BASE = process.env.SUP_API_BASE || 'http://127.0.0.1:8080/api';
const results = [];
let token = '';

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? '[OK] ' : '[FAIL] ') + name + (detail ? ' | ' + detail : ''));
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 保留原始文本便于定位 */ }
  return { status: res.status, json, text };
}

function ok(r) { return r.json && r.json.code === 200; }

(async () => {
  const login = await req('POST', '/auth/login', { username: 'admin', password: process.env.SUP_ADMIN_PWD || '123456' });
  if (!ok(login)) { console.error('登录失败：HTTP ' + login.status + ' ' + login.text.slice(0, 200)); process.exit(1); }
  token = login.json.data.token;
  record('admin 登录', true, '');

  const roles = await req('GET', '/roles?pageSize=200');
  const list = (ok(roles) && roles.json.data.list) || [];
  record('读取角色列表', list.length > 0, '共 ' + list.length + ' 个角色，均带 userCount：' + list.every(r => typeof r.userCount === 'number'));

  const mapResp = await req('GET', '/roles/user-map');
  const map = (ok(mapResp) && mapResp.json.data) || {};
  const boundUsers = Object.keys(map);
  record('读取用户→角色映射', ok(mapResp) && boundUsers.length > 0, '已有绑定的用户数：' + boundUsers.length);

  // 选一个非 admin 角色做绑定/解绑闭环，结束后恢复原状
  const target = list.find(r => r.code !== 'admin');
  const usersResp = await req('GET', '/users?pageSize=500');
  const users = (ok(usersResp) && usersResp.json.data.list) || [];
  if (!target || !users.length) {
    record('绑定闭环用例', false, '缺少可用角色或用户');
  } else {
    const memberIds = (target.userCount || 0);
    const candidate = users.find(u => !(map[String(u.id)] || []).includes(target.id));
    const already = await req('GET', '/roles/' + target.id + '/users');
    const beforeIds = ((ok(already) && already.json.data) || []).map(m => m.id);
    record('读取角色成员名单', ok(already) && beforeIds.length === memberIds, '角色“' + target.name + '”成员数：' + beforeIds.length + '，列表徽标：' + memberIds);

    const bind = await req('POST', '/roles/' + target.id + '/users/' + candidate.id);
    const bind2 = await req('POST', '/roles/' + target.id + '/users/' + candidate.id);
    const afterBind = await req('GET', '/roles/' + target.id + '/users');
    const afterIds = ((ok(afterBind) && afterBind.json.data) || []).map(m => m.id);
    record('绑定成员并幂等重复绑定', ok(bind) && ok(bind2) && afterIds.includes(candidate.id)
      && afterIds.length === beforeIds.length + 1,
      '绑定后成员数：' + beforeIds.length + '→' + afterIds.length);

    const noPwd = ((ok(afterBind) && afterBind.json.data) || []).every(m => !('password' in m));
    record('成员名单不含密码字段', noPwd, '');

    const userRoles = await req('GET', '/users/' + candidate.id + '/roles');
    record('人员侧读取已绑角色', ok(userRoles) && userRoles.json.data.includes(target.id), JSON.stringify(userRoles.json && userRoles.json.data));

    const unbind = await req('DELETE', '/roles/' + target.id + '/users/' + candidate.id);
    const afterUnbind = await req('GET', '/roles/' + target.id + '/users');
    const afterIds2 = ((ok(afterUnbind) && afterUnbind.json.data) || []).map(m => m.id);
    record('解除绑定并回到原状', ok(unbind) && afterIds2.length === beforeIds.length, '解除后成员数：' + afterIds2.length);

    // 内置 admin 账号保护：不得被移出系统管理员角色
    const adminUser = users.find(u => u.name === 'admin');
    const adminRole = list.find(r => r.code === 'admin');
    if (adminUser && adminRole) {
      const guard = await req('DELETE', '/roles/' + adminRole.id + '/users/' + adminUser.id);
      record('内置管理员不可被解除管理员角色', guard.json && guard.json.code === 400,
        'HTTP ' + guard.status + ' / ' + (guard.json && guard.json.message));
    }
  }

  const failed = results.filter(r => !r.pass);
  console.log('\n合计 ' + results.length + ' 项，通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('脚本异常：', e); process.exit(2); });
