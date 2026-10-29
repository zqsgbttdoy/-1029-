// 共用记录组件窄屏回归：监理日志 / 监理日记 / 日常巡检 / 旁站
// 目的：验证 field-records.css 新增的窄屏工具栏约束没有让任何记录页产生横向溢出。
// 依赖隔离环境：静态页 18081 -> 后端 18080（e2e H2 内存库）。
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 19222;
const BASE = 'http://localhost:18081';
const OUT = path.join(__dirname, '记录页窄屏回归');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${JSON.stringify(detail).slice(0, 300)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function newBlankTarget() {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/json/new?about:blank', method: 'PUT' }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

class Session {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) this.handlers.forEach((h) => h(msg));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  on(fn) { this.handlers.push(fn); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('Eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
  async waitFor(expression, desc, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (await this.eval(expression)) return true; } catch (_) { /* 页面切换中 */ }
      await sleep(150);
    }
    throw new Error('等待超时: ' + desc);
  }
  async metrics(width, height, mobile) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: !!mobile, screenWidth: width, screenHeight: height });
  }
  async screenshot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  }
}

(async () => {
  const list = await httpJson('/json/list');
  const pages = list.filter((t) => t.type === 'page' && !/^(edge|devtools|chrome):/i.test(t.url || ''));
  let target = pages.find((t) => t.url === 'about:blank');
  if (!target) { try { target = await newBlankTarget(); } catch (_) { /* 回退 */ } }
  target = target || pages.find((t) => (t.url || '').includes('localhost:18081')) || pages[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const s = new Session(ws);
  const consoleErrors = [];
  s.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 200));
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push('EXCEPTION: ' + (msg.params.exceptionDetails.text || ''));
    if (msg.method === 'Page.javascriptDialogOpening') { s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { }); }
  });
  await Promise.all([s.send('Page.enable'), s.send('Runtime.enable'), s.send('DOM.enable')]);

  const measure = () => s.eval(`(() => {
    const vw = document.documentElement.clientWidth;
    const editor = document.getElementById('fwEditor');
    const open = editor && !editor.hidden;
    const modal = open ? editor.querySelector('.fd-modal') : null;
    const body = open ? editor.querySelector('.fd-body') : null;
    const footer = open ? editor.querySelector('.fd-footer') : null;
    const footerBtns = footer ? [...footer.querySelectorAll('button')].filter(b => !b.hidden).map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), h: Math.round(r.height) }; }) : [];
    const sel = document.getElementById('fwProject');
    const sr = sel ? sel.getBoundingClientRect() : null;
    return {
      vw, vh: innerHeight,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyOverflowX: body ? body.scrollWidth - body.clientWidth : 0,
      modalW: modal ? Math.round(modal.getBoundingClientRect().width) : 0,
      modalRight: modal ? Math.round(modal.getBoundingClientRect().right) : 0,
      closeRight: open ? Math.round(document.getElementById('fwClose').getBoundingClientRect().right) : 0,
      footerBtns,
      toolbarSelect: sr ? { w: Math.round(sr.width), right: Math.round(sr.right) } : null,
      title: open ? document.getElementById('fwTitle').textContent.trim() : '',
      gridCols: open ? getComputedStyle(document.getElementById('fwForm')).gridTemplateColumns : '',
    };
  })()`);

  const pagesToTest = [
    { file: 'supervision-log.html', kind: '监理日志', newText: '新建监理日志' },
    { file: 'supervision-diary.html', kind: '监理日记', newText: '新建监理日记' },
    { file: 'daily-inspection.html', kind: '日常巡检', newText: '新建日常巡检' },
    { file: 'sideline-inspection.html', kind: '旁站检查', newText: '新建旁站检查' },
  ];

  try {
    // ---------- 登录 ----------
    await s.metrics(1440, 900, false);
    await s.send('Page.navigate', { url: BASE + '/login.html' });
    await s.waitFor(`document.readyState === 'complete'`, '登录页就绪');
    await s.eval(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) { } return true; })()`);
    await s.send('Page.navigate', { url: BASE + '/login.html' });
    await s.waitFor(`document.readyState === 'complete' && !!document.getElementById('loginBtn')`, '登录页加载');
    await s.eval(`(() => {
      const set = (id, v) => { const el = document.getElementById(id); const proto = HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
      set('username', 'admin'); set('password', '123456');
      document.getElementById('loginBtn').click();
      return true;
    })()`);
    await s.waitFor(`location.pathname !== '/login.html'`, '登录跳转', 25000);

    for (const p of pagesToTest) {
      await s.metrics(1440, 900, false);
      await s.send('Page.navigate', { url: BASE + '/' + p.file });
      await s.waitFor(`document.readyState === 'complete' && !!document.getElementById('fwNew')`, p.kind + ' 页加载');
      await s.eval(`(() => { const sel = document.getElementById('fwProject'); if (sel && sel.options.length > 1) { sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change')); } return true; })()`);
      await sleep(500);

      // 列表页窄屏：工具栏控件不应撑宽页面
      await s.metrics(320, 568, true);
      await sleep(350);
      const listState = await s.eval(`(() => {
        const vw = document.documentElement.clientWidth;
        const ctrls = [...document.querySelectorAll('.fw-toolbar select, .fw-toolbar input')].map(e => { const r = e.getBoundingClientRect(); return { id: e.id, right: Math.round(r.right), w: Math.round(r.width) }; });
        return { vw, docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, ctrls };
      })()`);
      check(`${p.kind} 列表页 320 无横向溢出且工具栏控件在视口内`, listState.docOverflowX <= 0 && listState.ctrls.every((c) => c.right <= listState.vw), listState);

      // 打开编辑器
      await s.metrics(1440, 900, false);
      await sleep(250);
      const opened = await s.eval(`(() => {
        const btn = document.getElementById('fwNew');
        btn.click();
        return true;
      })()`);
      if (!opened) throw new Error(p.kind + ' 无法点击新建');
      await s.waitFor(`!document.getElementById('fwEditor').hidden`, p.kind + ' 编辑器打开', 15000);
      await sleep(400);

      const e375 = await (async () => { await s.metrics(375, 667, true); await sleep(400); return measure(); })();
      await s.screenshot(`375-${p.kind}.png`);
      check(`${p.kind} 编辑弹窗 375 不超屏、底栏按钮可点`, e375.docOverflowX <= 0 && e375.bodyOverflowX <= 0 && e375.modalW <= 375 && e375.closeRight <= 375
        && e375.footerBtns.length > 0 && e375.footerBtns.every((b) => b.right <= 375 && b.left >= 0 && b.h >= 30), e375);

      const e320 = await (async () => { await s.metrics(320, 568, true); await sleep(400); return measure(); })();
      await s.screenshot(`320-${p.kind}.png`);
      check(`${p.kind} 编辑弹窗 320 不超屏、底栏按钮可点`, e320.docOverflowX <= 0 && e320.bodyOverflowX <= 0 && e320.modalW <= 320
        && e320.footerBtns.every((b) => b.right <= 320 && b.left >= 0 && b.h >= 30), e320);

      check(`${p.kind} 窄屏切单列`, e375.gridCols.split(' ').length === 1 && e320.gridCols.split(' ').length === 1, { g375: e375.gridCols, g320: e320.gridCols });
    }

    const badConsole = consoleErrors.filter((e) => !/favicon/i.test(e));
    check('四个记录页均无控制台错误', badConsole.length === 0, badConsole.slice(0, 5));
  } catch (e) {
    check('回归脚本执行完成', false, { error: e.message });
  }

  fs.writeFileSync(path.join(OUT, '回归结果.json'), JSON.stringify({ results, consoleErrors }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`TOTAL ${results.length} PASS ${results.length - failed} FAIL ${failed}`);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
