// 监理日志（supervision-logs）真实 DOM 探针：用于设计验收断言
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = 19222;
const BASE = 'http://localhost:18081';
const OUT = path.join(__dirname, 'probe-supervision-log.json');
const httpJson = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await httpJson('/json/list');
  const pages = list.filter((t) => t.type === 'page' && !/^(edge|devtools|chrome):/i.test(t.url || ''));
  const target = pages[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : undefined; };
  const waitFor = async (expr, label, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await ev(expr)) return true; await sleep(200); }
    throw new Error('等待超时: ' + label);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/supervision-log.html' });
  await waitFor(`document.readyState === 'complete' && !!window.App`, '页面加载');
  await sleep(1200);

  // 保证有项目与登录态
  const pre = await ev(`(async () => {
    const page = await App.apiGetPage('/projects', { pageNum: 1, pageSize: 200 });
    return { loggedIn: !!App.getToken(), projects: (page.list || []).map(p => ({ id: p.id, name: p.name })), rows: document.querySelectorAll('#fwRows tr').length };
  })()`);
  if (!pre.loggedIn) throw new Error('浏览器未登录，请先运行一次验收脚本');
  if (!pre.projects.length) {
    await ev(`(async () => {
      await App.apiFetch('/projects', { method: 'POST', body: { name: '监理日志视觉验收项目（长工程名称响应式检查）', code: 'SLOG-VISUAL-01', buildUnit: '视觉验收测试建设单位', status: 'active' } });
      return true;
    })()`);
    await send('Page.navigate', { url: BASE + '/supervision-log.html' });
    await waitFor(`document.readyState === 'complete' && !!window.App`, '页面重载');
    await sleep(1200);
  }

  await ev(`(() => { document.getElementById('fwNew').click(); return true; })()`);
  await waitFor(`!document.getElementById('fwEditor').hidden`, '编辑器打开');
  await sleep(600);

  const dump = await ev(`(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
    const modal = document.querySelector('#fwEditor .fd-modal');
    const body = document.querySelector('#fwEditor .fd-body');
    const grid = document.getElementById('fwForm');
    const footer = document.querySelector('#fwEditor .fd-footer');
    const fields = [...document.querySelectorAll('#fwForm [id^="fwF-"]')].map((el) => {
      const lab = el.closest('.fd-field') ? el.closest('.fd-field').querySelector('.fd-label') : null;
      const hint = el.closest('.fd-field') ? el.closest('.fd-field').querySelector('.fd-hint') : null;
      const cs = getComputedStyle(el);
      return {
        id: el.id, tag: el.tagName, label: lab ? lab.textContent.trim() : '', hint: hint ? hint.textContent.trim().slice(0, 60) : '',
        placeholder: el.getAttribute('placeholder') || '', required: lab ? /\\*/.test(lab.textContent) : false,
        readOnly: !!el.readOnly, disabled: !!el.disabled, value: (el.value || '').slice(0, 40),
        box: box(el), scrollH: el.scrollHeight, clientH: el.clientHeight, phColor: getComputedStyle(el, '::placeholder').color, phOpacity: getComputedStyle(el, '::placeholder').opacity,
        gridColumn: cs.gridColumn,
      };
    });
    const footerBtns = [...footer.querySelectorAll('button')].filter((b) => !b.hidden && getComputedStyle(b).display !== 'none').map((b) => ({ id: b.id, t: b.textContent.trim().slice(0, 12), ...box(b) }));
    return {
      title: document.getElementById('fwTitle').textContent.trim(),
      state: document.getElementById('fwState').textContent.trim(),
      guide: (document.getElementById('fwGuide').textContent || '').trim().slice(0, 120),
      modal: box(modal), body: { ...box(body), scrollH: body.scrollHeight, clientH: body.clientHeight },
      gridCols: getComputedStyle(grid).gridTemplateColumns,
      footer: box(footer), footerBtnCount: footerBtns.length, footerBtns,
      fields,
      upload: { exists: !!document.getElementById('fwUpload'), accept: (document.getElementById('fwUpload') || {}).accept, sub: (document.querySelector('#fwUploadField .fd-dz-sub') || {}).textContent },
      hasDirTree: !!document.getElementById('dirTreeContainer'),
      historyPanel: !!document.getElementById('fwHistoryContent'),
      chips: [...document.querySelectorAll('#fwState .fw-chip')].map((c) => c.textContent.trim()),
      toolbarBtns: [...document.querySelectorAll('.fw-toolbar button')].map((b) => ({ id: b.id, t: b.textContent.trim().slice(0, 14) })),
      rowActions: (() => { const tr = document.querySelector('#fwRows tr'); return tr ? [...tr.querySelectorAll('button')].map((b) => b.textContent.trim()) : []; })(),
    };
  })()`);

  const widths = [[1440, 900, false], [768, 800, true], [375, 667, true], [320, 568, true]];
  const responsive = [];
  for (const [w, h, mobile] of widths) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile, screenWidth: w, screenHeight: h });
    await sleep(500);
    responsive.push(await ev(`(() => {
      const de = document.documentElement;
      const vw = de.clientWidth;
      const modal = document.querySelector('#fwEditor .fd-modal');
      const body = document.querySelector('#fwEditor .fd-body');
      const footer = document.querySelector('#fwEditor .fd-footer');
      const outside = [];
      document.querySelectorAll('#fwEditor button').forEach((b) => { const r = b.getBoundingClientRect(); if (r.width > 0 && r.right > vw + 0.5) outside.push({ id: b.id, t: b.textContent.trim().slice(0, 10), right: Math.round(r.right) }); });
      const pageOut = [];
      document.querySelectorAll('body *').forEach((el) => { const r = el.getBoundingClientRect(); if (r.width > 0 && r.right > vw + 0.5 && getComputedStyle(el).position !== 'fixed' && !el.closest('#fwEditor')) pageOut.push({ tag: el.tagName, id: el.id, right: Math.round(r.right) }); });
      const fb = footer.getBoundingClientRect();
      return {
        vw, vh: innerHeight, docOverflowX: de.scrollWidth - vw, modalW: Math.round(modal.getBoundingClientRect().width),
        gridCols: getComputedStyle(document.getElementById('fwForm')).gridTemplateColumns,
        bodyScroll: [body.scrollTop, body.scrollHeight, body.clientHeight],
        footer: { top: Math.round(fb.top), bottom: Math.round(fb.bottom), h: Math.round(fb.height), overflow: Math.round(footer.scrollWidth - footer.clientWidth) },
        footerVisible: fb.top >= 0 && fb.bottom <= innerHeight + 0.5,
        editorBtnOutside: outside.slice(0, 10), pageOutside: pageOut.slice(0, 6),
        textareaW: [...document.querySelectorAll('#fwForm textarea')].map((t) => Math.round(t.getBoundingClientRect().width)),
      };
    })()`));
    responsive[responsive.length - 1].size = w + 'x' + h;
  }

  const out = { pre, dump, responsive };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log('probe saved: ' + OUT);
  console.log(JSON.stringify({ title: dump.title, fieldCount: dump.fields.length, footerBtnCount: dump.footerBtnCount, hasDirTree: dump.hasDirTree, responsive: responsive.map((r) => ({ size: r.size, vw: r.vw, docOverflowX: r.docOverflowX, modalW: r.modalW, gridCols: r.gridCols, footerVisible: r.footerVisible, footerOverflow: r.footer.overflow, btnOutside: r.editorBtnOutside.length })) }, null, 2));
  ws.close();
})().catch((e) => { console.error('PROBE-ERROR: ' + e.message); process.exit(1); });
