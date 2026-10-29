// 320px 溢出根因探针（关闭弹窗后的页面基准）
const http = require('http');
const PORT = 19222;
const httpJson = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
(async () => {
  const list = await httpJson('/json/list');
  const target = list.find((t) => t.url.includes('safety-log.html'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

  await ev(`(() => { closeModal('createModal'); return true; })()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true, screenWidth: 320, screenHeight: 640 });
  await new Promise((r) => setTimeout(r, 600));
  const closed = await ev(`(() => {
    const de = document.documentElement;
    const vw = de.clientWidth;
    const list = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width > 0 && r.right > vw + 0.5 && cs.visibility !== 'hidden' && cs.position !== 'fixed') {
        list.push({ tag: el.tagName, id: el.id, cls: (el.className || '').toString().slice(0, 40), right: Math.round(r.right), w: Math.round(r.width), ov: cs.overflowX, white: cs.whiteSpace });
      }
    });
    return { innerWidth, vw, scrollW: de.scrollWidth, bodyW: document.body.getBoundingClientRect().width, offenders: list.slice(0, 18) };
  })()`);
  console.log(JSON.stringify(closed, null, 2));
  ws.close();
})();
