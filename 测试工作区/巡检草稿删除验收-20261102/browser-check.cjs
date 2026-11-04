// 日常巡检列表“草稿行删除”真实浏览器核对：独立 e2e（18130/18131）+ 无头 Edge（19242）
// 覆盖：本人草稿行与已保存行都有删除按钮、草稿确认文案区分、取消不发请求、确认后行消失、服务器 404、旁站/日记无删除按钮、375 无溢出、无 JS 异常
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const BASE = 'http://127.0.0.1:18131', CDP_PORT = 19242;
const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const results = [], sleep = ms => new Promise(r => setTimeout(r, ms));
const logLines = [];
for (const level of ['log', 'error']) {
  const raw = console[level].bind(console);
  console[level] = (...args) => { logLines.push(args.map(a => a instanceof Error ? (a.message + ' | ' + String(a.stack).split('\n')[1]) : typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); raw(...args); };
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data), p = this.pending.get(msg.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP超时：' + method)); }, method === 'Page.captureScreenshot' ? 60000 : 20000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
  async wait(expression, label) { for (let i = 0; i < 150; i++) { try { if (await this.eval(expression)) return; } catch (_) {} await sleep(100); } throw new Error('等待超时：' + label); }
  async navigate(page) { await this.send('Page.navigate', { url: BASE + '/' + page }); await this.wait(`location.pathname.endsWith(${JSON.stringify(page.split('?')[0])}) && document.readyState==='complete'`, page); await sleep(150); }
  async click(selector) {
    const p = await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('控件不存在: '+${JSON.stringify(selector)}); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
  }
  async shot(name) { await this.send('Page.bringToFront'); await this.eval('window.scrollTo(0,0)'); await sleep(200); const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); }
  async width(width, height = 900) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(250); assert.equal(await this.eval('innerWidth'), width); }
}
let s;
async function check(name, fn) { const detail = await fn(); results.push({ name, pass: true, detail }); console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); }
async function dialogText() {
  return s.eval(`(()=>{const ok=document.querySelector('[data-act="ok"]'); return ok ? ok.closest('div').parentElement.textContent : '';})()`);
}

(async () => {
  const page = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  if (!page) throw new Error('没有独立核对页');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  s = new CDP(ws);
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Page.bringToFront'); await s.width(1440);
  const ids = {};
  try {
    // 登录
    await s.navigate('login.html');
    await s.eval(`(()=>{document.querySelector('#username').value='admin';document.querySelector('#password').value='123456';})()`);
    await s.click('#loginBtn');
    await s.wait(`!!window.App && !!App.getToken()`, '登录令牌');
    await s.wait(`!location.pathname.endsWith('login.html')`, '登录后跳转');

    // 造数据：recA 提交为 recorded（可删）、recB 保持 draft（本轮新增：也应有删除按钮）
    await check('准备本人巡检数据（recorded + draft）', async () => {
      const made = await s.eval(`(async()=>{const proj=await App.apiFetch('/projects',{method:'POST',body:{name:'验收草稿删除项目',code:'ACPT-'+Date.now().toString(36).toUpperCase(),buildUnit:'验收单位',address:'验收地址',type:'房建工程',status:'active',startDate:'2026-01-01',endDate:'2027-01-01',description:'草稿删除验收'}});
        const pid=proj.id;
        const checklist=JSON.stringify({version:1,items:[{id:'i1',category:'一般',content:'检查临边防护',method:'目测',standard:'专项方案',required:true,result:'compliant',problems:[]}]});
        const mk=()=>({projectId:pid,inspectionDate:new Date().toISOString().slice(0,10),location:'验收A区',content:'草稿删除验收记录',checklist,photos:'[]',attachments:'[]'});
        const a=await App.apiFetch('/daily-inspections',{method:'POST',headers:{'Idempotency-Key':'ak-'+Date.now()},body:mk()});
        const sub=await App.apiFetch('/daily-inspections/'+a.id+'/submit',{method:'POST',headers:{'X-Record-Version':a.lockVersion}});
        const b=await App.apiFetch('/daily-inspections',{method:'POST',headers:{'Idempotency-Key':'bk-'+Date.now()},body:mk()});
        return {a:a.id,b:b.id,projectId:pid,status:sub.status,lv:sub.lockVersion};})()`);
      assert.equal(made.status, 'recorded'); assert.ok(made.lv >= 1);
      ids.a = String(made.a); ids.b = String(made.b);
      return made;
    });

    // 1) 巡检列表：recorded 行与 draft 行都有删除按钮；草稿行保留继续编辑
    await s.navigate('daily-inspection.html');
    await s.wait(`document.querySelector('#fwRows') && document.querySelector('#fwRows').children.length>0`, '巡检列表渲染');
    await s.wait(`document.querySelector('#fwRows [data-del="${ids.b}"]')`, '草稿行删除按钮出现');
    await check('本人已保存行与草稿行都有删除按钮', async () => {
      const r = await s.eval(`(() => {
        const btnA = document.querySelector('#fwRows [data-del="${ids.a}"]');
        const btnB = document.querySelector('#fwRows [data-del="${ids.b}"]');
        const rowB = btnB ? btnB.closest('tr') : null;
        return {
          delA: !!btnA, delB: !!btnB,
          delText: btnB ? btnB.textContent.trim() : '',
          draftRowText: rowB ? rowB.textContent : '',
          draftEdit: !!document.querySelector('#fwRows [data-id="${ids.b}"]')
        };
      })()`);
      assert.equal(r.delA, true, '已保存行缺少删除按钮');
      assert.equal(r.delB, true, '草稿行缺少删除按钮');
      assert.equal(r.delText, '删除');
      assert.match(r.draftRowText, /草稿/, '草稿行状态徽标应为草稿：' + r.draftRowText.slice(0, 60));
      assert.equal(r.draftEdit, true, '草稿行应保留继续编辑入口');
      return r;
    });
    await s.shot('01-草稿与已保存都有删除-1440');

    // 2) 点草稿删除 → 确认文案区分草稿 → 先取消，行保留
    await s.click(`#fwRows [data-del="${ids.b}"]`);
    await s.wait(`document.querySelector('[data-act="ok"]')`, '确认对话框');
    await check('草稿删除确认文案区分草稿', async () => {
      const t = await dialogText();
      assert.match(t, /删除本人草稿巡检记录/, t.slice(0, 80));
      assert.doesNotMatch(t, /已保存/, '草稿确认文案不应使用已保存文案：' + t.slice(0, 80));
      return { dialog: t.slice(0, 50) };
    });
    await s.shot('02-草稿删除确认弹窗-1440');
    await s.click('[data-act="cancel"]');
    await check('取消后草稿行保留', async () => {
      await sleep(300);
      const r = await s.eval(`(()=>({kept:!!document.querySelector('#fwRows [data-del="${ids.b}"]'),err:(document.getElementById('fwError')||{textContent:''}).textContent}))()`);
      assert.equal(r.kept, true, '取消后草稿行不应消失');
      assert.equal(r.err, '', '取消不应报错：' + r.err);
      return r;
    });

    // 3) 再点草稿删除 → 确认 → 行消失，已保存行保留
    await s.click(`#fwRows [data-del="${ids.b}"]`);
    await s.wait(`document.querySelector('[data-act="ok"]')`, '确认对话框再次出现');
    await s.click('[data-act="ok"]');
    await s.wait(`!document.querySelector('#fwRows [data-del="${ids.b}"]')`, '删除后草稿行消失');
    await check('确认后草稿行消失且已保存行保留', async () => {
      const r = await s.eval(`(()=>({gone:!document.querySelector('#fwRows [data-del="${ids.b}"]'),savedKept:!!document.querySelector('#fwRows [data-id="${ids.a}"]'),err:(document.getElementById('fwError')||{textContent:''}).textContent}))()`);
      assert.equal(r.gone, true); assert.equal(r.savedKept, true, '删除草稿不应误伤已保存记录');
      assert.equal(r.err, '', '删除成功不应报错：' + r.err);
      return r;
    });
    await s.shot('03-草稿删除成功-1440');

    // 4) 服务器侧：草稿已 404（软删除），已保存仍 200
    await check('服务器验证：已删草稿 404，已保存仍在', async () => {
      const st = await s.eval(`(async()=>{const h={Authorization:'Bearer '+App.getToken()};
        return {b:(await fetch('/api/daily-inspections/${ids.b}',{headers:h})).status,a:(await fetch('/api/daily-inspections/${ids.a}',{headers:h})).status};})()`);
      assert.equal(st.b, 404, '已删除草稿应 404：' + st.b);
      assert.equal(st.a, 200, '已保存记录应仍可访问：' + st.a);
      return st;
    });

    // 5) 删除已保存行：确认文案保持原文案，删除成功
    await s.click(`#fwRows [data-del="${ids.a}"]`);
    await s.wait(`document.querySelector('[data-act="ok"]')`, '已保存删除确认对话框');
    await check('已保存行删除确认文案保持原文案', async () => {
      const t = await dialogText();
      assert.match(t, /删除本人已保存的巡检记录/, t.slice(0, 80));
      return { dialog: t.slice(0, 50) };
    });
    await s.click('[data-act="ok"]');
    await s.wait(`!document.querySelector('#fwRows [data-del="${ids.a}"]')`, '删除后已保存行消失');
    await check('已保存行删除成功', async () => {
      const st = await s.eval(`(async()=>{const h={Authorization:'Bearer '+App.getToken()};
        return {status:(await fetch('/api/daily-inspections/${ids.a}',{headers:h})).status};})()`);
      assert.equal(st.status, 404, '已保存行删除后应 404：' + st.status);
      return st;
    });
    await s.shot('04-已保存删除成功-1440');

    // 6) 对照：旁站与日记页面不出现删除按钮（仅巡检放开）
    for (const [pageName, label] of [['sideline-inspection.html', '旁站检查'], ['supervision-diary.html', '监理日记']]) {
      await s.navigate(pageName);
      await s.wait(`document.querySelector('#fwRows') && document.querySelector('#fwRows').children.length>0`, label + '列表渲染');
      await check(label + '列表无删除按钮', async () => {
        const n = await s.eval(`document.querySelectorAll('#fwRows [data-del],#fwLocalRows [data-del]').length`);
        assert.equal(n, 0);
        return { count: n };
      });
    }

    // 7) 巡检 375 窄屏：操作列含删除按钮也不横向溢出
    await s.width(375, 812);
    await s.navigate('daily-inspection.html');
    await s.wait(`document.querySelector('#fwRows') && document.querySelector('#fwRows').children.length>0`, '巡检窄屏渲染');
    await sleep(300);
    await check('375 日常巡检无横向溢出', async () => {
      const r = await s.eval(`(()=>({sw:document.documentElement.scrollWidth,vw:innerWidth}))()`);
      assert.ok(r.sw <= r.vw, '横向溢出：' + r.sw + '>' + r.vw);
      return r;
    });
    await s.shot('05-日常巡检-375');

    await check('无浏览器运行异常', async () => { assert.deepEqual(s.errors, []); });
  } catch (e) {
    results.push({ name: '阻塞', pass: false, error: e.message });
    console.error(e);
    await s.shot('FAIL-current').catch(() => {});
    process.exitCode = 1;
  } finally {
    const passed = results.filter(r => r.pass).length;
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ passed, failed: results.length - passed, ids, results, errors: s.errors }, null, 2));
    console.log('TOTAL ' + passed + ' PASS ' + (results.length - passed) + ' FAIL');
    fs.writeFileSync(path.join(__dirname, 'browser-check.log'), logLines.join('\n') + '\n', 'utf8');
    s.ws.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
