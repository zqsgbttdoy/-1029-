// 定位监理日志窄屏溢出：找出把 .fd-modal 撑到 406 的最小内容
const http = require('http');
const PORT = 19222;
const BASE = 'http://localhost:18081';
const httpJson = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const list = await httpJson('/json/list');
  const target = list.filter((t) => t.type === 'page' && !/^(edge|devtools|chrome):/i.test(t.url || ''))[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : undefined; };

  await send('Page.navigate', { url: BASE + '/supervision-log.html' });
  await sleep(2500);
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 1, mobile: true, screenWidth: 375, screenHeight: 667 });
  await sleep(500);
  await ev(`(() => { const b = document.getElementById('fwNew'); if (b) b.click(); return true; })()`);
  await sleep(800);

  const out = await ev(`(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { sel, w: Math.round(r.width), right: Math.round(r.right), scrollW: el.scrollWidth, clientW: el.clientWidth,
        minW: cs.minWidth, maxW: cs.maxWidth, flexWrap: cs.flexWrap, flex: cs.flex, whiteSpace: cs.whiteSpace, padding: cs.padding, gap: cs.gap };
    };
    const sels = ['#fwEditor', '#fwEditor .fd-modal', '#fwEditor .fd-body', '#fwForm', '#fwEditor .fd-footer', '#fwEditor .fd-footer-left', '#fwEditor .fd-footer-right', '#fwGuide', '#fwUploadField', '#fwHistoryContent', '#fwForm .fd-field'];
    const boxes = sels.map(pick);
    const maxChild = (sel) => {
      const p = document.querySelector(sel); if (!p) return [];
      return [...p.children].map((c) => { const r = c.getBoundingClientRect(); const cs = getComputedStyle(c);
        return { tag: c.tagName, id: c.id, cls: (c.className || '').toString().slice(0, 26), w: Math.round(r.width), right: Math.round(r.right), scrollW: c.scrollWidth, minW: cs.minWidth, flexWrap: cs.flexWrap }; })
        .sort((a, b) => b.right - a.right).slice(0, 6);
    };
    return { vw: document.documentElement.clientWidth, boxes, modalChildren: maxChild('#fwEditor .fd-modal'), footerLeftChildren: maxChild('#fwEditor .fd-footer-left'), footerRightChildren: maxChild('#fwEditor .fd-footer-right') };
  })()`);
  console.log(JSON.stringify(out, null, 2));
  ws.close();
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
