// 日常巡检列表去除业务版本列的真实浏览器核对：独立 e2e（18130/18131）+ 无头 Edge（19242）
// 覆盖：巡检表头/行/本机草稿无版本列，旁站与日记仍保留，窄屏无溢出，无 JS 异常
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
// 列表结构度量：表头文本、th 数、版本列单元格数、空列表占位 colspan
const tableMetrics = `(()=>{const ths=[...document.querySelectorAll('#fieldWorkspace thead th')].map(t=>t.textContent.trim());return {ths,thCount:ths.length,versionCells:document.querySelectorAll('#fwRows td[data-label="业务版本"],#fwLocalRows td[data-label="业务版本"]').length,rowGroups:document.querySelectorAll('#fwRows tr').length,placeholderColspan:(document.querySelector('#fwRows td[colspan]')||{colSpan:null}).colSpan};})()`;
let s;
async function check(name, fn) { const detail = await fn(); results.push({ name, pass: true, detail }); console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); }

(async () => {
  const page = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  if (!page) throw new Error('没有独立核对页');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  s = new CDP(ws);
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Page.bringToFront'); await s.width(1440);

  try {
    // 登录
    await s.navigate('login.html');
    await s.eval(`(()=>{document.querySelector('#username').value='admin';document.querySelector('#password').value='123456';})()`);
    await s.click('#loginBtn');
    await s.wait(`!!window.App && !!App.getToken()`, '登录令牌');
    await s.wait(`!location.pathname.endsWith('login.html')`, '登录后跳转');

    // 1) 日常巡检：表头与数据行均无业务版本
    await s.navigate('daily-inspection.html');
    await s.wait(`!!document.querySelector('#fwRows') && !document.querySelector('#fieldWorkspace table[data-app-loading]')`, '巡检列表骨架');
    await s.wait(`document.querySelector('#fwRows').children.length>0 || document.querySelector('#fwPage')`, '巡检列表渲染');
    await sleep(400);
    await check('日常巡检表头与行不含业务版本列', async () => {
      const r = await s.eval(tableMetrics);
      assert.ok(!r.ths.includes('业务版本'), '表头仍有业务版本：' + r.ths.join(','));
      assert.equal(r.thCount, 6, '表头列数应为 6：' + r.ths.join(','));
      assert.equal(r.versionCells, 0, '数据行仍渲染版本单元格');
      if (r.placeholderColspan !== null) assert.equal(r.placeholderColspan, 6, '空列表占位 colspan 未同步');
      return r;
    });
    await s.shot('01-日常巡检列表-1440');

    // 2) 旁站检查：保留业务版本列（对照）
    await s.navigate('sideline-inspection.html');
    await s.wait(`document.querySelector('#fwRows') && document.querySelector('#fwRows').children.length>0`, '旁站列表渲染');
    await sleep(300);
    await check('旁站检查保留业务版本列且为 7 列', async () => {
      const r = await s.eval(tableMetrics);
      assert.ok(r.ths.includes('业务版本'), '旁站表头不应被误删：' + r.ths.join(','));
      assert.equal(r.thCount, 7);
      return r;
    });
    await s.shot('02-旁站检查列表-1440');

    // 3) 监理日记：保留业务版本列（版本链页面对照）
    await s.navigate('supervision-diary.html');
    await s.wait(`document.querySelector('#fwRows') && document.querySelector('#fwRows').children.length>0`, '日记列表渲染');
    await sleep(300);
    await check('监理日记保留业务版本列且为 7 列', async () => {
      const ths = await s.eval(`[...document.querySelectorAll('#fieldWorkspace thead th')].map(t=>t.textContent.trim())`);
      assert.ok(ths.includes('业务版本'), ths.join(','));
      assert.equal(ths.length, 7);
      return { ths };
    });

    // 4) 巡检窄屏 375 无横向溢出
    await s.width(375, 812);
    await s.navigate('daily-inspection.html');
    await s.wait(`document.querySelector('#fwRows') && document.querySelector('#fwRows').children.length>0`, '巡检窄屏渲染');
    await sleep(300);
    await check('375 日常巡检无横向溢出且列头保持 6 列', async () => {
      const r = await s.eval(`(()=>({sw:document.documentElement.scrollWidth,vw:innerWidth,th:document.querySelectorAll('#fieldWorkspace thead th').length}))()`);
      assert.ok(r.sw <= r.vw, '横向溢出：' + r.sw + '>' + r.vw);
      assert.equal(r.th, 6);
      return r;
    });
    await s.shot('03-日常巡检-375');

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
