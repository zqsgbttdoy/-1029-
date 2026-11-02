// 近期修复项回归：只访问 18131 独立环境（新 H2 内存库），不触碰 8080/8081 正式实例。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const BASE = 'http://127.0.0.1:18131', CDP_HOST = 'http://127.0.0.1:19232';
const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const results = [], sleep = ms => new Promise(r => setTimeout(r, ms));
const run = 'REG' + Date.now().toString(36).toUpperCase();
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', e => { const msg = JSON.parse(e.data), p = this.pending.get(msg.id); if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === 'Page.javascriptDialogOpening') { this.dialogs = (this.dialogs || 0) + 1; void this.send('Page.handleJavaScriptDialog', { accept: true }); } }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP超时：' + method)); }, method === 'Page.captureScreenshot' ? 60000 : 20000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
  async wait(expression, label) { for (let i = 0; i < 150; i++) { try { if (await this.eval(expression)) return; } catch (_) {} await sleep(100); } throw new Error('等待超时：' + label); }
  async navigate(page) { await this.send('Page.navigate', { url: BASE + '/' + page }); await this.wait(`location.pathname.endsWith(${JSON.stringify(page.split('?')[0])}) && document.readyState==='complete'`, page); }
  async click(selector) { const box = await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}); if(!el||el.hidden||el.disabled) throw Error('控件不可点: '+${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`); await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box }); }
  async fill(selector, value) { await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async shot(name) { await this.send('Page.bringToFront'); await sleep(120); const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); }
  async width(width) { await this.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(150); assert.equal(await this.eval('innerWidth'), width); }
  installDialogGuard() { return this.eval(`(()=>{window.__nativeDialogCalls=[];['alert','confirm','prompt'].forEach(function(n){var f=window[n];window[n]=function(){window.__nativeDialogCalls.push(n);return f?f.apply(window,arguments):undefined;};});return window.__nativeDialogCalls;})()`); }
  async toastText() { return this.eval(`document.querySelector('.app-toast') ? document.querySelector('.app-toast').textContent : ''`); }
  async waitForToast(pattern, label) { for (let i = 0; i < 80; i++) { const t = await this.toastText(); if (pattern.test(t)) return t; await sleep(100); } throw new Error('未出现预期提示：' + label + '（最后 toast=' + await this.toastText() + '）'); }
}
let s, token;
async function api(url, method = 'GET', body, auth = true) {
  const r = await fetch(BASE + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(auth && token ? { Authorization: 'Bearer ' + token } : {}), ...(method !== 'GET' ? { 'Idempotency-Key': 'key-' + run + '-' + Math.random().toString(36).slice(2) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
}
async function check(name, fn) { const detail = await fn(); results.push({ name, pass: true, detail }); console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); }
const visible = () => s.eval(`(()=>{const clipped=el=>{for(let p=el.parentElement;p&&p!==document.documentElement;p=p.parentElement){const o=getComputedStyle(p).overflowX;if(o==='hidden'||o==='auto'||o==='scroll')return true;}return false;};const bad=[];for(const el of document.querySelectorAll('body *')){const st=getComputedStyle(el);if(st.display==='none'||st.visibility==='hidden'||!el.getClientRects().length)continue;const r=el.getBoundingClientRect();if(r.width>0&&r.right>innerWidth+2&&r.left>=0&&!clipped(el))bad.push({el:(el.tagName+'.'+String(el.className).slice(0,40)),right:Math.round(r.right)});}return {width:innerWidth,docScroll:document.documentElement.scrollWidth,overflowing:bad.slice(0,5)};})()`);
const code = 'REG-' + run, pname = '回归测试工程' + run.slice(-4), childName = '回归子部门' + run.slice(-4), leafName = '回归空部门' + run.slice(-4);
(async () => {
  const page = await (await fetch(CDP_HOST + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  s = new CDP(ws); await s.send('Page.enable'); await s.send('Runtime.enable'); await s.width(1440);
  try {
    await s.eval(`if(location.origin===${JSON.stringify(BASE)}) sessionStorage.removeItem('supervision.session.v2')`);
    await s.navigate('login.html');
    await s.fill('#username', 'admin'); await s.fill('#password', '123456');
    await s.click('#loginBtn');
    await s.wait(`!!window.App && !!App.getToken() && !location.pathname.endsWith('login.html')`, '真实登录');
    token = await s.eval('App.getToken()');
    await check('真实登录成功且只访问独立环境', async () => { assert.equal(await s.eval('location.origin'), BASE); return { run }; });

    // ============ A. 项目台账：详情弹窗 + 表单字段校验 ============
    await s.navigate('project-ledger.html');
    await s.wait(`document.querySelector('#tableBody td') && !document.querySelector('#tableBody').textContent.includes('加载中')`, '台账列表');
    await s.installDialogGuard();
    await s.click('button[onclick="openCreateModal()"]');
    await s.eval(`document.querySelectorAll('.app-toast').forEach(t=>t.remove())`);
    await s.click('button[onclick="saveProject()"]');
    await check('项目表单空保存被必填校验拦截', async () => { const t = await s.waitForToast(/请填写以下必填项/, '必填汇总'); assert.ok(t.includes('项目编号') && t.includes('项目名称') && t.includes('建设单位')); return t; });
    await s.fill('#projectCode', code); await s.fill('#projectName', pname); await s.fill('#projectStatus', 'active'); await s.fill('#buildUnit', '回归建设单位'); await s.fill('#chiefEngineer', '2'); await s.fill('#startDate', '2026-01-01'); await s.fill('#endDate', '2026-12-31');
    await s.click('button[onclick="saveProject()"]');
    await check('UI新建项目保存成功', async () => { const t = await s.waitForToast(/保存成功/, '新建保存'); await s.wait(`document.querySelector('#tableBody').textContent.includes(${JSON.stringify(pname)})`, '新项目入表'); return t; });
    const dup = await api('/projects', 'POST', { name: pname + '重复', code, buildUnit: 'X', status: 'active' });
    await check('后端拒绝重复项目编号', async () => { assert.equal(dup.status, 400); assert.equal(dup.j.message, '项目编号已存在'); return dup.j.message; });
    const badStatus = await api('/projects', 'POST', { name: '非法状态' + run, code: 'BAD-' + run, buildUnit: 'X', status: 'running' });
    await check('后端拒绝非法项目状态枚举', async () => { assert.equal(badStatus.status, 400); assert.ok(badStatus.j.message.includes('项目状态')); return badStatus.j.message; });
    await s.eval(`document.querySelectorAll('.app-toast').forEach(t=>t.remove())`);
    await s.click(`#tableBody button[onclick^="viewProject"]`);
    await s.wait(`document.querySelector('#viewModal.show')`, '详情弹窗');
    await check('项目详情弹窗只读回显完整', async () => {
      const v = await s.eval(`(()=>{const g=id=>document.getElementById(id).textContent;return {code:g('view_code'),name:g('view_name'),status:g('view_status'),chief:g('view_chief'),start:g('view_startDate'),end:g('view_endDate'),addr:g('view_address'),desc:g('view_description'),editable:!!document.querySelector('#viewModal input,#viewModal select,#viewModal textarea')}})()`);
      assert.equal(v.name, pname); assert.equal(v.code, code); assert.equal(v.status, '进行中'); assert.equal(v.chief, '赵总监'); assert.equal(v.start, '2026-01-01'); assert.equal(v.end, '2026-12-31'); assert.equal(v.addr, '—'); assert.equal(v.desc, '—'); assert.equal(v.editable, false);
      return v;
    });
    await s.shot('01-项目详情弹窗');
    await s.click('#viewModal button[onclick="editFromView()"]');
    await check('详情弹窗可跳转编辑且字段回填', async () => { await s.wait(`document.querySelector('#createModal.show') && document.getElementById('modalTitle').textContent==='编辑项目'`, '编辑弹窗'); const v = await s.eval(`({code:document.getElementById('projectCode').value,name:document.getElementById('projectName').value,status:document.getElementById('projectStatus').value})`); assert.deepEqual(v, { code, name: pname, status: 'active' }); return v; });
    await s.fill('#projectName', pname + '改名'); await s.click('button[onclick="saveProject()"]');
    await check('编辑保存状态字段真实落库', async () => { await s.waitForToast(/保存成功/, '编辑保存'); const list = await api('/projects?name=' + encodeURIComponent(pname)); assert.ok(list.j.data.list.some(p => p.name === pname + '改名'), JSON.stringify(list.j.data.list.map(p=>p.name))); return '改名生效'; });
    await s.eval(`document.querySelectorAll('.app-toast').forEach(t=>t.remove())`);
    await s.click(`#tableBody button[onclick^="confirmDelete"]`);
    await s.wait(`document.querySelector('#deleteModal.show')`, '删除确认弹窗');
    await check('项目删除走自定义确认弹窗', async () => { const t = await s.eval(`document.getElementById('deleteConfirmText').textContent`); assert.ok(t.includes(pname + '改名')); await s.click(`#deleteModal button[onclick="closeModal('deleteModal')"]`); return t; });
    await s.width(375); await s.shot('02-375项目台账');
    await s.width(1440);
    await check('项目台账375窄屏无撑宽元素', async () => { const l = await (async () => { await s.width(375); const r = await visible(); await s.width(1440); return r; })(); assert.ok(l.docScroll <= l.width + 1, JSON.stringify(l)); assert.deepEqual(l.overflowing, [], JSON.stringify(l.overflowing)); return { width: l.width, docScroll: l.docScroll }; });

    // ============ B. 部门管理：搜索框 + 删除校验 ============
    await s.navigate('department-management.html');
    await s.wait(`document.querySelector('.tree-node')`, '部门树');
    await s.installDialogGuard();
    const baseline = await s.eval(`document.querySelectorAll('.tree-node').length`);
    await s.fill('#deptSearch', '监理');
    await check('部门搜索命中保留祖先并可恢复', async () => {
      const hit = await s.eval(`(()=>{const n=[...document.querySelectorAll('.tree-node')];return {count:n.length,texts:n.map(x=>x.textContent.trim())}})()`);
      assert.equal(hit.count, 2, JSON.stringify(hit)); assert.ok(hit.texts.some(t => t.includes('总公司')) && hit.texts.some(t => t.includes('监理一部')), JSON.stringify(hit.texts));
      assert.ok(!hit.texts.some(t => t.includes('回归子部门') || t.includes('回归空部门')), '无关新建部门不应命中');
      await s.fill('#deptSearch', '不存在部门XYZ');
      assert.equal(await s.eval(`document.querySelector('#treeBody').textContent.includes('未找到匹配部门')`), true);
      await s.fill('#deptSearch', '');
      const restored = await s.eval(`document.querySelectorAll('.tree-node').length`); assert.equal(restored, baseline, '清空后应恢复全部节点');
      return { baseline, hit: hit.texts };
    });
    await s.shot('03-部门搜索恢复');
    const parentNode = await s.eval(`(()=>{for(const n of document.querySelectorAll('.tree-node')) if(n.textContent.includes('总公司')) return n.getAttribute('onclick');})()`);
    await s.eval(`window.${parentNode}`);
    await s.click('.detail-panel button[onclick="confirmDelete()"]');
    await s.click(`#deleteModal button[onclick="executeDelete()"]`);
    await check('有子部门的删除被后端拦截并提示', async () => {
      const t = await s.waitForToast(/请先删除子部门/, '子部门拦截'); assert.equal(t, '该部门下存在子部门，请先删除子部门'); return t;
    });
    await s.eval(`document.querySelectorAll('.app-toast').forEach(t=>t.remove())`);
    await s.eval(`document.getElementById('deleteModal').classList.remove('show')`);
    await s.click('.detail-panel button[onclick="openCreateModal()"]');
    await s.wait(`document.querySelector('#createModal.show')`, '新建部门弹窗');
    await s.fill('#deptName', childName); await s.click(`#createModal button[onclick="saveDept()"]`);
    await s.waitForToast(/创建成功/, '新建子部门');
    await s.fill('#deptSearch', childName);
    await s.wait(`document.querySelector('.tree-node')`, '命中新部门');
    await check('UI新建子部门成功', async () => { const t = await s.eval(`[...document.querySelectorAll('.tree-node')].map(n=>n.textContent).join('|')`); assert.ok(t.includes(childName), t); return childName; });
    await s.fill('#deptSearch', '');
    await s.eval(`document.querySelectorAll('.app-toast').forEach(t=>t.remove())`);
    const longName = await api('/departments', 'POST', { name: 'x'.repeat(101) });
    await check('部门名称超100字符被DTO拦截', async () => { assert.equal(longName.status, 400); assert.ok(JSON.stringify(longName.j).includes('100'), JSON.stringify(longName.j)); return longName.j; });
    await s.click('.detail-panel button[onclick="openCreateModal()"]');
    await s.wait(`document.querySelector('#createModal.show')`, '重新打开新建部门弹窗');
    await s.eval(`document.querySelectorAll('.app-toast').forEach(t=>t.remove())`);
    await s.fill('#deptName', 'x'.repeat(101));
    await s.click(`#createModal button[onclick="saveDept()"]`);
    await check('UI保存超长部门名提示后端DTO消息', async () => { const t = await s.waitForToast(/不能超过100个字符/, 'DTO名称限长'); assert.ok(t.includes('部门名称'), t); await s.click(`#createModal button[onclick="closeModal('createModal')"]`); return t; });
    const leaf = await api('/departments', 'POST', { name: leafName, parentId: null, status: 'active' });
    await check('空部门可删除且删后视为不存在', async () => {
      assert.equal(leaf.status, 200); const id = leaf.j.data.id;
      const del = await api('/departments/' + id, 'DELETE'); assert.equal(del.status, 200);
      const got = await api('/departments/' + id); assert.equal(got.status, 400); assert.equal(got.j.message, '部门不存在');
      return { id };
    });
    const memberDept = await api('/departments', 'POST', { name: '回归人员部门' + run.slice(-4), parentId: null, status: 'active' });
    const qaUser = await api('/users', 'POST', { name: '回归成员' + run.slice(-4), phone: '139' + String(Date.now()).slice(-8), deptId: memberDept.j.data.id, status: 'active', password: 'Reg-Test-123' });
    await check('部门在职人员删除拦截文案', async () => {
      assert.equal(memberDept.status, 200); assert.equal(qaUser.status, 200);
      const blocked = await api('/departments/' + memberDept.j.data.id, 'DELETE'); assert.equal(blocked.status, 400); assert.ok(blocked.j.message.includes('名在职/休假人员，请先转移或离职后再删除'), blocked.j.message);
      await api('/users/' + qaUser.j.data.id, 'DELETE').catch(()=>{});
      await api('/departments/' + memberDept.j.data.id, 'DELETE').catch(()=>{});
      return blocked.j.message;
    });

    // ============ C. 接口安全与权限 ============
    await check('未认证请求一律401', async () => {
      for (const url of ['/departments', '/users?pageSize=2', '/projects', '/supervision-diaries']) { const r = await api(url, 'GET', undefined, false); assert.equal(r.status, 401, url); }
      return '4项';
    });
    await check('【发现项 F-1】用户接口返回体含密码散列（需发布前处理）', async () => {
      const list = await api('/users?pageSize=5'); assert.equal(list.status, 200);
      const one = await api('/users/' + list.j.data.list[0].id);
      const leakList = JSON.stringify(list.j.data).includes('password');
      const leakOne = JSON.stringify(one.j.data || {}).includes('password');
      const sample = (list.j.data.list[0].password || '').slice(0, 7);
      return { listLeak: leakList, detailLeak: leakOne, prefix: sample, severity: leakList || leakOne ? 'HIGH' : 'none' };
    });
    await check('手机号DTO格式校验', async () => {
      const r = await api('/users', 'POST', { name: '坏手机号', phone: '12345', password: 'Abc123456' }); assert.equal(r.status, 400); assert.ok(JSON.stringify(r.j).includes('手机号'), JSON.stringify(r.j)); return r.j;
    });
    const noRole = await api('/users', 'POST', { name: '回归无角色' + run.slice(-4), phone: '138' + String(Date.now()).slice(-8), status: 'active', password: 'Reg-Test-123' });
    await check('普通越权写读接口403（departments/权限树/项目授权）', async () => {
      assert.equal(noRole.status, 200);
      const login = await api('/auth/login', 'POST', { username: noRole.j.data.name, password: 'Reg-Test-123' });
      assert.equal(login.status, 200); const normalToken = login.j.data.token;
      const g1 = await fetch(BASE + '/api/departments', { headers: { Authorization: 'Bearer ' + normalToken } }); assert.equal(g1.status, 403);
      const g2 = await fetch(BASE + '/api/permissions/tree', { headers: { Authorization: 'Bearer ' + normalToken } }); assert.equal(g2.status, 403);
      const g3 = await fetch(BASE + '/api/users/project-map', { headers: { Authorization: 'Bearer ' + normalToken } }); assert.equal(g3.status, 403);
      const w1 = await fetch(BASE + '/api/projects/1', { method: 'PUT', headers: { Authorization: 'Bearer ' + normalToken, 'Content-Type': 'application/json', 'Idempotency-Key': 'np-' + run }, body: JSON.stringify({ name: '越权改名', code: 'X', buildUnit: 'X', status: 'active' }) }); assert.equal(w1.status, 403);
      await api('/users/' + noRole.j.data.id, 'DELETE').catch(()=>{});
      return '4项403';
    });

    // ============ D. 原生弹窗替换为自定义组件（运行时无原生对话框） ============
    await check('页面交互全程未触发原生alert/confirm/prompt', async () => {
      const calls = await s.eval(`window.__nativeDialogCalls ? window.__nativeDialogCalls.length : -1`);
      assert.equal(calls, 0, '原生调用次数=' + calls);
      assert.equal(s.dialogs || 0, 0, 'CDP捕获原生对话框次数');
      assert.equal(await s.eval(`typeof App.confirm==='function' && typeof App.prompt==='function'`), true);
      return { nativeCalls: calls, cdpDialogs: s.dialogs || 0 };
    });

    // ============ E. 窄屏布局与滚动（375/320） ============
    const pages = ['project-ledger.html', 'department-management.html', 'personnel-management.html', 'permission-settings.html', 'supervision-diary.html', 'index.html'];
    for (const width of [375, 320]) {
      for (const p of pages) {
        await s.width(width); await s.navigate(p);
        await s.wait(`document.readyState==='complete' && !!window.App`, p);
        await sleep(600);
        await check(width + ' ' + p + ' 无横向溢出', async () => { const r = await visible(); assert.ok(r.docScroll <= r.width + 1, JSON.stringify(r)); assert.deepEqual(r.overflowing, [], JSON.stringify(r.overflowing)); return { width: r.width, docScroll: r.docScroll }; });
        await s.shot(String(width) + '-' + p.replace('.html', ''));
      }
    }
    await s.width(1440);
    await check('无浏览器运行异常', async () => { assert.deepEqual(s.errors, []); return s.errors; });
  } catch (e) {
    results.push({ name: '阻塞', pass: false, error: e.message }); console.error(e);
    await s.shot('FAIL-current').catch(() => {});
    fs.writeFileSync(path.join(OUT, 'failure-dom.txt'), await s.eval('document.body.innerText').catch(() => ''));
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ run, base: BASE, results, errors: s.errors }, null, 2));
    console.log('证据目录：' + OUT); s.ws.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
