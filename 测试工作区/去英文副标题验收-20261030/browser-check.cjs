// 去掉英文副标题后的视觉与结构验收：独立 e2e（18130/18131）+ 无头 Edge（19232）
// 覆盖：全量页面无英文残留、登录页/欢迎页/侧栏单行标题布局、窄屏无溢出、浏览器无异常
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const BASE = 'http://127.0.0.1:18131', CDP_PORT = 19232;
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
      if (msg.method === 'Page.javascriptDialogOpening') void this.send('Page.handleJavaScriptDialog', { accept: true });
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP超时：' + method)); }, method === 'Page.captureScreenshot' ? 60000 : 20000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
  async wait(expression, label) { for (let i = 0; i < 100; i++) { try { if (await this.eval(expression)) return; } catch (_) {} await sleep(100); } throw new Error('等待超时：' + label); }
  async navigate(page) { await this.send('Page.navigate', { url: BASE + '/' + page }); await this.wait(`location.pathname.endsWith(${JSON.stringify(page.split('?')[0])}) && document.readyState==='complete'`, page); await sleep(150); }
  async click(selector) {
    const p = await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('控件不存在: '+${JSON.stringify(selector)}); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
  }
  async shot(name) { await this.send('Page.bringToFront'); await this.eval('window.scrollTo(0,0)'); await sleep(200); const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); }
  async width(width, height = 900) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(250); assert.equal(await this.eval('innerWidth'), width); }
}
let s, token;
async function check(name, fn) { const detail = await fn(); results.push({ name, pass: true, detail }); console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); }
const EN = 'Supervision Site Management';
const noEn = `!document.body.innerText.includes(${JSON.stringify(EN)})`;
const logoMetrics = `(()=>{const box=document.querySelector('.sidebar-logo'),h2=box.querySelector('h2'),r=box.getBoundingClientRect(),t=h2.getBoundingClientRect(),cs=getComputedStyle(box),hs=getComputedStyle(h2);return {text:box.innerText.trim(),html:box.innerHTML,paras:box.querySelectorAll('p').length,topGap:Math.round(t.top-r.top),bottomGap:Math.round(r.bottom-t.bottom),boxHeight:Math.round(r.height),padding:cs.paddingTop+'/'+cs.paddingBottom,fontSize:hs.fontSize,spacing:hs.letterSpacing,aligned:getComputedStyle(box).textAlign};})()`;

(async () => {
  const page = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  if (!page) throw new Error('没有独立验收页');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  s = new CDP(ws);
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Page.bringToFront'); await s.width(1440);

  try {
    // 1) 全量页面（HTTP 源）不再包含英文副标题，也不再保留 sidebar-logo 下的 <p>
    await check('26 个页面源码均无英文副标题残留', async () => {
      const files = fs.readdirSync(path.join(__dirname, '..', '..', '补后端')).filter(f => f.endsWith('.html')).sort();
      const bad = [];
      for (const f of files) {
        const res = await fetch(BASE + '/' + f);
        const text = await res.text();
        if (text.includes(EN)) bad.push(f + ':en');
        if (/sidebar-logo[^\n]*<p>/.test(text)) bad.push(f + ':p');
      }
      assert.deepEqual(bad, [], bad.join(','));
      return { pages: files.length };
    });

    // 2) 欢迎页（未登录公开页）
    await s.navigate('welcome.html');
    await check('欢迎页顶栏只保留中文品牌名且垂直居中', async () => {
      const r = await s.eval(`(()=>{const b=document.querySelector('.topbar .brand'),n=b.querySelector('b'),r=b.getBoundingClientRect(),t=n.getBoundingClientRect();return {text:b.innerText.trim(),spans:b.querySelectorAll('span').length,fs:getComputedStyle(n).fontSize,offset:Math.round((t.top+t.bottom)/2-(r.top+r.bottom)/2)};})()`);
      assert.ok(r.text.includes('监理现场管理系统'), r.text);
      assert.ok(!r.text.includes(EN), r.text);
      assert.equal(r.spans, 0);
      assert.equal(r.fs, '17px');
      assert.ok(Math.abs(r.offset) <= 1, '品牌名未垂直居中：' + r.offset);
      assert.equal(await s.eval(noEn), true);
      return r;
    });
    await s.shot('01-欢迎页顶栏');

    // 3) 登录页
    await s.navigate('login.html');
    await check('登录卡片去掉英文后图标与标题留白均衡', async () => {
      const r = await s.eval(`(()=>{const box=document.querySelector('.login-logo'),h=box.querySelector('h1'),i=box.querySelector('.icon'),r=box.getBoundingClientRect(),t=h.getBoundingClientRect(),ir=i.getBoundingClientRect(),cs=getComputedStyle(h);return {paras:box.querySelectorAll('p').length,text:box.innerText.trim().replace(/\\s+/g,' '),gap:Math.round(t.top-ir.bottom),fs:cs.fontSize,mt:cs.marginTop,ls:cs.letterSpacing,mb:getComputedStyle(box).marginBottom};})()`);
      assert.equal(r.paras, 0);
      assert.equal(r.text, '🏗️ 监理现场管理系统');
      assert.equal(r.fs, '21px');
      assert.equal(r.mt, '10px');
      assert.equal(r.ls, '1px');
      assert.equal(r.mb, '28px');
      assert.ok(r.gap >= 8 && r.gap <= 14, '图标与标题间距异常：' + r.gap);
      assert.equal(await s.eval(noEn), true);
      return r;
    });
    await s.shot('02-登录页');

    // 4) 登录后仪表盘侧栏
    await s.eval(`(()=>{document.querySelector('#username').value='admin';document.querySelector('#password').value='123456';})()`);
    await s.click('#loginBtn');
    // 登录后由页面自身完成跳转，这里只等它落地，避免与自动跳转抢夺导航
    await s.wait(`!!window.App && !!App.getToken()`, '登录令牌');
    await s.wait(`!location.pathname.endsWith('login.html')`, '登录后跳转');
    await s.wait(`document.readyState==='complete' && !!document.querySelector('.sidebar-logo')`, '仪表盘侧栏渲染');
    token = await s.eval('App.getToken()');
    await sleep(300);
    await check('仪表盘侧栏单行标题居中且字号/字距已放大', async () => {
      const r = await s.eval(logoMetrics);
      assert.equal(r.text, '监理现场管理系统');
      assert.equal(r.paras, 0);
      assert.equal(r.padding, '22px/22px');
      assert.equal(r.fontSize, '17px');
      assert.equal(r.spacing, '2px');
      assert.ok(Math.abs(r.topGap - r.bottomGap) <= 1, '上下留白不等：' + r.topGap + '/' + r.bottomGap);
      assert.equal(await s.eval(noEn), true);
      return r;
    });
    await s.shot('03-仪表盘侧栏');

    // 5) 业务页同一套侧栏
    await s.navigate('sideline-inspection.html');
    await check('业务页侧栏同步去英文且布局一致', async () => {
      const r = await s.eval(logoMetrics);
      assert.equal(r.text, '监理现场管理系统');
      assert.equal(r.paras, 0);
      assert.ok(Math.abs(r.topGap - r.bottomGap) <= 1, r.topGap + '/' + r.bottomGap);
      assert.equal(await s.eval(noEn), true);
      return r;
    });
    await s.shot('04-旁站页侧栏');

    // 6) 窄屏
    await s.width(375, 812);
    await s.navigate('index.html');
    await check('375 仪表盘无横向溢出且侧栏标题区未被压塌', async () => {
      const r = await s.eval(`(()=>{const b=document.querySelector('.sidebar-logo').getBoundingClientRect();return {sw:document.documentElement.scrollWidth,vw:innerWidth,logoH:Math.round(b.height),logoW:Math.round(b.width)};})()`);
      assert.ok(r.sw <= r.vw, '横向溢出：' + r.sw + '>' + r.vw);
      assert.ok(r.logoH >= 20 && r.logoH <= 80, '侧栏标题区高度异常：' + r.logoH);
      assert.equal(await s.eval(noEn), true);
      return r;
    });
    await s.shot('05-仪表盘-375');
    await s.width(320, 720);
    await s.navigate('sideline-inspection.html');
    await check('320 旁站页无横向溢出且无英文残留', async () => {
      const r = await s.eval(`(()=>({sw:document.documentElement.scrollWidth,vw:innerWidth}))()`);
      assert.ok(r.sw <= r.vw, '横向溢出：' + r.sw + '>' + r.vw);
      assert.equal(await s.eval(noEn), true);
      return r;
    });
    await s.shot('06-旁站页-320');
    // 已登录时直接打开登录页会被自动跳走，先清会话再验证窄屏登录卡片
    await s.eval(`(()=>{try{sessionStorage.clear()}catch(e){}})()`);
    await s.navigate('login.html');
    await check('320 登录页无英文且卡片不溢出', async () => {
      const r = await s.eval(`(()=>{const c=document.querySelector('.login-card').getBoundingClientRect();return {sw:document.documentElement.scrollWidth,vw:innerWidth,cardW:Math.round(c.width),cardL:Math.round(c.left)};})()`);
      assert.ok(r.sw <= r.vw, '横向溢出：' + r.sw + '>' + r.vw);
      assert.ok(r.cardL >= 0, '卡片左侧越界');
      assert.equal(await s.eval(noEn), true);
      return r;
    });
    await s.shot('07-登录页-320');

    await check('无浏览器运行异常', async () => { assert.deepEqual(s.errors, []); });
  } catch (e) {
    results.push({ name: '阻塞', pass: false, error: e.message });
    console.error(e);
    await s.shot('FAIL-current').catch(() => {});
    process.exitCode = 1;
  } finally {
    const passed = results.filter(r => r.pass).length;
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ passed, failed: results.length - passed, results, errors: s.errors }, null, 2));
    console.log('TOTAL ' + passed + ' PASS ' + (results.length - passed) + ' FAIL');
    fs.writeFileSync(path.join(__dirname, 'browser-check.log'), logLines.join('\n') + '\n', 'utf8');
    s.ws.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
