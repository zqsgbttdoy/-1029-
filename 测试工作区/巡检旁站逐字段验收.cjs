// 日常巡检 / 旁站检查 逐字段验收：CDP 驱动真实 Edge，逐字段核对控件、标识、提示、校验、回显与导出。
// 依赖隔离环境：静态页 18081 -> 后端 18080（e2e H2 内存库），不接触业务库。
const fs = require('fs');
const path = require('path');
const http = require('http');

// 默认为既有隔离环境（18081/19222）；可用 QA_CDP_PORT / QA_BASE / QA_OUT 指向另起的独立实例
const PORT = Number(process.env.QA_CDP_PORT || 19222);
const BASE = process.env.QA_BASE || 'http://localhost:18081';
const OUT = path.join(__dirname, process.env.QA_OUT || '巡检旁站逐字段验收');
fs.mkdirSync(OUT, { recursive: true });
const DL_DIR = path.join(OUT, 'downloads');
fs.mkdirSync(DL_DIR, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${JSON.stringify(detail).slice(0, 400)}`);
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  async clickByText(sel, text) {
    const box = await this.eval(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => (e.textContent || '').trim().includes(${JSON.stringify(text)}));
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error('未找到按钮: ' + text);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  async setValue(id, value) {
    return this.eval(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === ${JSON.stringify(value)};
    })()`);
  }
  async scrollBody(where) {
    return this.eval(`(() => {
      const b = document.querySelector('#fwEditor .fd-body');
      if (!b) return null;
      b.scrollTop = ${where === 'bottom' ? 'b.scrollHeight' : where === 'middle' ? 'b.scrollHeight / 2' : '0'};
      return b.scrollTop;
    })()`);
  }
}

// 逐字段矩阵：控件类型、标签、必填标识、占位/提示、尺寸、只读
const MATRIX = `(() => {
  const form = document.getElementById('fwForm');
  const rows = [];
  form.querySelectorAll('.fd-field').forEach((f) => {
    const ctrl = f.querySelector('[data-field]');
    if (!ctrl) return;
    const field = ctrl.dataset.field;
    const labelEl = f.querySelector('.fd-label');
    const sec = f.closest('.fd-sec');
    const titleEl = sec ? sec.querySelector('.fd-sec-title') : null;
    const starNode = labelEl || titleEl;
    // 取纯文本标签（剔除必填星号节点），用于比对标签文字本身是否残留“*”
    const labelClone = starNode ? starNode.cloneNode(true) : null;
    if (labelClone) labelClone.querySelectorAll('.fd-req').forEach((e) => e.remove());
    const label = (labelClone ? labelClone.textContent : '').replace(/\\s+/g, ' ').trim();
    const star = starNode ? !!starNode.querySelector('.fd-req') : false;
    const hintEl = f.querySelector('.fd-hint');
    const described = ctrl.getAttribute('aria-describedby');
    const descEl = described ? document.getElementById(described) : null;
    const r = ctrl.getBoundingClientRect();
    rows.push({
      field, tag: ctrl.tagName.toLowerCase(), type: ctrl.type || '', label,
      star,
      starRed: star,
      placeholder: ctrl.getAttribute('placeholder') || '',
      title: ctrl.getAttribute('title') || '',
      hint: (hintEl ? hintEl.textContent : descEl ? descEl.textContent : '').replace(/\\s+/g, ' ').trim(),
      aria: (ctrl.getAttribute('aria-description') || '').replace(/\\s+/g, ' ').trim(),
      maxlength: ctrl.getAttribute('maxlength'), readonly: !!ctrl.readOnly,
      w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right),
      value: ctrl.value
    });
  });
  const author = [...form.querySelectorAll('.fd-field')].find((f) => f.querySelector('.fd-readonly') && /检查人员|旁站人员/.test((f.querySelector('.fd-label') || {}).textContent || ''));
  return {
    rows,
    author: author ? { label: author.querySelector('.fd-label').textContent.replace(/\\s+/g, ' ').trim(), value: author.querySelector('.fd-readonly').textContent.trim(), hint: (author.querySelector('.fd-hint') || {}).textContent || '' } : null,
    vw: innerWidth, docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
  };
})()`;

(async () => {
  const list = await httpJson('/json/list');
  const pages = list.filter((t) => t.type === 'page' && !/^(edge|devtools|chrome):/i.test(t.url || ''));
  let target = pages.find((t) => t.url === 'about:blank');
  if (!target) { try { target = await newBlankTarget(); } catch (_) { /* 回退 */ } }
  target = target || pages.find((t) => (t.url || '').includes('localhost:18081')) || pages[0];
  if (!target) throw new Error('没有可用的浏览器页面目标');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const s = new Session(ws);

  const consoleErrors = [];
  const downloads = [];
  const matrices = {};
  s.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push('EXCEPTION: ' + (msg.params.exceptionDetails.text || ''));
    if (msg.method === 'Page.downloadWillBegin') downloads.push(msg.params);
    if (msg.method === 'Page.javascriptDialogOpening') { s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { }); }
  });
  await Promise.all([s.send('Page.enable'), s.send('Runtime.enable'), s.send('Network.enable'), s.send('DOM.enable')]);
  await s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { });
  await s.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: DL_DIR, eventsEnabled: true });

  // 提交一次：非巡检需接受审核确认框；巡检为备忘录，提交即保存、不弹确认、成功后关闭编辑器
  async function attemptSubmit() {
    await s.eval(`(() => { document.getElementById('fwError').textContent = ''; return true; })()`);
    const daily = await s.eval(`document.getElementById('fieldWorkspace').dataset.kind === 'daily-inspections'`);
    await s.eval(`document.getElementById('fwSubmit').click()`);
    if (!daily) {
      await s.waitFor(`!!document.querySelector('[data-act="ok"]')`, '提交确认弹窗', 10000);
      await s.eval(`document.querySelector('[data-act="ok"]').click()`);
    }
    await s.waitFor(`(() => { const e = document.getElementById('fwError').textContent.trim(); const c = (document.querySelector('#fwState .fw-chip') || {}).textContent; return !!e || c === '待审核' || (${daily} && document.getElementById('fwEditor').hidden); })()`, '提交结果返回', 25000);
    await sleep(1200); // 提交成功后提示在 load() 之后写入，避免读到空的 #fwError
    const result = await s.eval(`(() => { const chip = (document.querySelector('#fwState .fw-chip') || {}).textContent || ''; const cell = document.querySelector('#fwRows tr td:nth-child(5) .fw-chip'); return { error: document.getElementById('fwError').textContent.replace(/\\s+/g, ' ').trim(), chip, listChip: cell ? cell.textContent.trim() : '', editorOpen: !document.getElementById('fwEditor').hidden }; })()`);
    return Object.assign(result, { confirmed: !daily });
  }

  async function openNew(label) {
    for (let i = 0; i < 5; i++) {
      if (await s.eval(`!document.getElementById('fwEditor').hidden`)) break;
      await s.eval(`document.getElementById('fwNew').click()`);
      await sleep(800);
      if (await s.eval(`!!document.querySelector('[data-act="ok"]')`)) {
        await s.eval(`document.querySelector('[data-act="ok"]').click()`);
        await sleep(400);
      }
    }
    try {
      await s.waitFor(`!document.getElementById('fwEditor').hidden`, '新建编辑器打开', 12000);
    } catch (e) {
      const diag = await s.eval(`(() => ({ hidden: document.getElementById('fwEditor').hidden, dialog: !!document.querySelector('[data-act="ok"]'), bodyClass: document.body.className, error: document.getElementById('fieldError').textContent.trim(), modalOpen: document.body.classList.contains('fw-modal-open') }))()`);
      throw new Error(e.message + ' ' + JSON.stringify(diag));
    }
    await sleep(600);
    return s.eval(`document.getElementById('fwTitle').textContent.trim()`);
  }

  async function reloadPage(url) {
    await s.send('Page.navigate', { url: BASE + url });
    await s.waitFor(`document.readyState === 'complete' && !!document.getElementById('fwNew')`, '页面重新加载: ' + url, 20000);
    await sleep(600);
  }

  async function closeEditor() {
    // 保存/提交收尾阶段按钮会被暂时禁用，点击会被吞掉，因此按状态重试
    for (let i = 0; i < 6; i++) {
      if (await s.eval(`document.getElementById('fwEditor').hidden`)) return;
      await s.eval(`document.getElementById('fwClose').click()`);
      await sleep(600);
      if (await s.eval(`!!document.querySelector('[data-act="ok"]')`)) {
        await s.eval(`document.querySelector('[data-act="ok"]').click()`);
        await sleep(400);
      }
    }
    await s.waitFor(`document.getElementById('fwEditor').hidden`, '关闭编辑器', 10000);
  }

  async function saveDraft() {
    await s.clickByText('#fwEditor .fd-footer button', '保存草稿');
    await s.waitFor(`/ · [A-Za-z0-9-]{6,}/.test(document.getElementById('fwTitle').textContent)`, '草稿保存并生成编号', 25000);
    const st = await s.eval(`(() => ({ title: document.getElementById('fwTitle').textContent.trim(), chip: (document.querySelector('#fwState .fw-chip') || {}).textContent || '', state: document.getElementById('fwState').textContent.replace(/\\s+/g, ' ').trim() }))()`);
    return { ...st, code: (st.title.split('·')[1] || '').trim() };
  }

  async function openByCode(code) {
    await s.eval(`(() => { const tr = [...document.querySelectorAll('#fwRows tr')].find(r => r.textContent.includes(${JSON.stringify(code)})); tr.querySelector('button[data-id]').click(); return true; })()`);
    await s.waitFor(`!document.getElementById('fwEditor').hidden && document.getElementById('fwTitle').textContent.includes(${JSON.stringify(code)})`, '按编号打开记录', 20000);
    await sleep(600);
  }

  async function downloadCsv() {
    const before = downloads.map((d) => d.guid);
    await s.eval(`document.getElementById('fwExport').click()`);
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const ev = downloads.find((d) => !before.includes(d.guid));
      if (ev) {
        const f = path.join(DL_DIR, ev.guid);
        if (fs.existsSync(f) && fs.statSync(f).size > 50) return { text: fs.readFileSync(f, 'utf8'), suggested: ev.suggestedFilename, bytes: fs.statSync(f).size };
      }
      await sleep(200);
    }
    return { text: '', suggested: '', bytes: 0 };
  }

  try {
    // ---------- 登录 ----------
    await s.metrics(1440, 900, false);
    await s.send('Page.navigate', { url: BASE + '/login.html' });
    await s.waitFor(`document.readyState === 'complete'`, '登录页就绪');
    await s.eval(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) { } return true; })()`);
    await s.send('Page.navigate', { url: BASE + '/login.html' });
    await s.waitFor(`document.readyState === 'complete' && !!document.getElementById('loginBtn')`, '登录页加载');
    await s.setValue('username', 'admin');
    await s.setValue('password', '123456');
    await s.clickByText('button', '登 录');
    await s.waitFor(`location.pathname !== '/login.html'`, '登录跳转', 25000);
    await s.waitFor(`typeof App !== 'undefined' && !!App.getUser()`, '登录后应用上下文就绪', 20000);
    const today = await s.eval(`(() => { const d = new Date(); const p = (n) => n < 10 ? '0' + n : '' + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })()`);
    const me = await s.eval(`(App.getUser() || {}).userName || ''`);

    /* ===================== 日常巡检 ===================== */
    await s.send('Page.navigate', { url: BASE + '/daily-inspection.html' });
    await s.waitFor(`document.readyState === 'complete' && !!document.getElementById('fwNew')`, '日常巡检页加载');
    await sleep(500);
    const dailyTitle = await openNew('日常巡检');
    check('日常巡检：新建标题正确', dailyTitle === '新建日常巡检', dailyTitle);

    const dm = await s.eval(MATRIX);
    matrices.daily = dm.rows;
    const dOrder = dm.rows.map((r) => r.field);
    check('日常巡检：字段清单与顺序完整（日期/项目/编号/时间人数/检查部位/巡视内容/发现问题）',
      dOrder.join(',') === 'inspectionDate,projectId,code,startTime,endTime,workerCount,manageCount,location,content,issues', dOrder);
    check('日常巡检：检查人员按登录账号只读显示、不可手工修改',
      !!dm.author && dm.author.label === '检查人员' && dm.author.value === me && !!dm.author.hint, dm.author);

    const d = Object.fromEntries(dm.rows.map((r) => [r.field, r]));
    // 2026-10-30 起巡检日期与起止时间改用带“确定/取消”的选择面板：输入框只读，选择在面板内确认后才写回
    const dDatePicker = await s.eval(`(() => { const el = document.getElementById('fwF-inspectionDate'); return { type: el.type, readonly: el.readOnly, picker: el.getAttribute('data-picker'), value: el.value, api: typeof window.FdDateTimePicker }; })()`);
    check('日常巡检：日期默认当天，只读展开选择面板（带确定/取消）且可改历史日期',
      dDatePicker.type === 'text' && dDatePicker.readonly === true && dDatePicker.picker === 'date'
      && dDatePicker.value === today && dDatePicker.api === 'object', dDatePicker);
    // 可见项目多于一个时需在表单中选择（新建不再强制先选工具栏项目），只有一个时仍自动带出
    const dProject = await s.eval(`(() => {
      const el = document.getElementById('fwF-projectId');
      const picked = el.value || ((el.options[1] || {}).value || '');
      if (!el.value && picked) { el.value = picked; el.dispatchEvent(new Event('change', { bubbles: true })); }
      return { picked: el.value, options: el.options.length };
    })()`);
    check('日常巡检：项目下拉可在表单中选择并生效',
      d.projectId.tag === 'select' && dProject.options > 1 && !!dProject.picked, dProject);
    check('日常巡检：编号为单行输入、留空自动生成有占位提示',
      d.code.tag === 'input' && d.code.type === 'text' && /留空由系统生成/.test(d.code.placeholder + d.code.hint), { placeholder: d.code.placeholder, hint: d.code.hint });
    check('日常巡检：三个正文栏目为整行文本域并带栏目标题',
      ['location', 'content', 'issues'].every((k) => d[k].tag === 'textarea' && d[k].w > 800) && d.location.label === '检查部位' && d.content.label === '巡视内容' && d.issues.label === '发现问题补充说明',
      ['location', 'content', 'issues'].map((k) => ({ k, tag: d[k].tag, w: d[k].w, h: d[k].h, label: d[k].label })));

    // 逐字段：必填标识 / 填写提示（当前实现的缺口在这里暴露）
    const dRequired = { location: '检查部位', content: '巡视内容' };
    const dMissingStar = Object.keys(dRequired).filter((k) => !d[k].starRed);
    check('日常巡检：提交必填项均有红色必填标识（检查部位、巡视内容）', dMissingStar.length === 0,
      { missing: dMissingStar.map((k) => dRequired[k]) });
    const dNoGuide = ['location', 'content', 'issues'].filter((k) => !d[k].placeholder && !d[k].hint && !d[k].title && !d[k].aria);
    check('日常巡检：每个正文栏目都有占位示例或填写提示', dNoGuide.length === 0, { missing: dNoGuide });
    const dHints = ['location', 'content', 'issues'].map((k) => ({ field: k, placeholder: d[k].placeholder, hint: d[k].hint }));
    console.log('DAILY_FIELD_HINTS ' + JSON.stringify(dHints));

    // 填写回写
    const dValues = {
      location: '3 号楼 5 层东侧模板支撑区（轴线 A~C / 1~3）',
      content: '上午 9:00 巡视 5 层模板支撑体系，立杆间距、扫地杆、剪刀撑设置符合专项方案；抽查 12 处扣件扭矩，全部合格。下午复查混凝土浇筑前隐蔽验收资料，齐全。',
      issues: '5 层东侧 3 根立杆底部垫板缺失，已通知施工班组补齐并复查合格。',
    };
    for (const [k, v] of Object.entries(dValues)) await s.setValue('fwF-' + k, v);
    const dTyped = await s.eval(`(() => {
      const v = (f) => document.getElementById('fwF-' + f).value;
      const raw = Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k)).map((t) => { try { return JSON.parse(t); } catch (e) { return null; } }).filter(Boolean).find((x) => x.body && x.body.projectId);
      return { location: v('location'), content: v('content'), issues: v('issues'), saved: raw ? [raw.body.location, raw.body.content, raw.body.issues] : null };
    })()`);
    check('日常巡检：三个栏目逐字段输入成功并写入本机草稿',
      dTyped.location === dValues.location && dTyped.content === dValues.content && dTyped.issues === dValues.issues
      && !!dTyped.saved && dTyped.saved[0] === dValues.location && dTyped.saved[1] === dValues.content && dTyped.saved[2] === dValues.issues,
      { typed: [dTyped.location.length, dTyped.content.length, dTyped.issues.length], saved: !!dTyped.saved });
    await s.screenshot('巡检-01-桌面-新建与填写.png');

    // 校验：空正文
    await s.eval(`(() => { ['location','content','issues'].forEach((f) => { const el = document.getElementById('fwF-' + f); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }); return true; })()`);
    const dEmpty = await attemptSubmit();
    check('日常巡检：全空提交被拒绝（提示填写实际工作内容）', /请填写实际工作内容/.test(dEmpty.error) && dEmpty.chip !== '待审核', dEmpty);

    await s.setValue('fwF-content', dValues.content);
    const dNoLoc = await attemptSubmit();
    check('日常巡检：仅填巡视内容时提交被拒绝（提示检查部位）', /请填写检查部位/.test(dNoLoc.error) && dNoLoc.chip !== '待审核', dNoLoc);
    await s.screenshot('巡检-02-桌面-缺少检查部位被拒绝.png');

    await s.setValue('fwF-location', dValues.location);
    await s.setValue('fwF-issues', dValues.issues);
    const dSaved = await saveDraft();
    check('日常巡检：保存草稿成功并生成编号、状态草稿', /^[A-Za-z0-9-]{6,}$/.test(dSaved.code) && dSaved.chip === '草稿', dSaved);
    await s.screenshot('巡检-03-桌面-保存草稿.png');

    await closeEditor();
    const dRow = await s.eval(`(() => { const tr = [...document.querySelectorAll('#fwRows tr')].find(r => r.textContent.includes(${JSON.stringify(dSaved.code)})); return tr ? tr.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
    check('日常巡检：列表出现该草稿并显示项目/日期/状态', !!dRow && /草稿/.test(dRow) && dRow.includes(today), dRow);

    await openByCode(dSaved.code);
    const dEcho = await s.eval(`(() => { const v = (f) => document.getElementById('fwF-' + f).value; return { date: v('inspectionDate'), location: v('location'), content: v('content'), issues: v('issues') }; })()`);
    check('日常巡检：编辑回显逐字段一致', dEcho.date === today && dEcho.location === dValues.location && dEcho.content === dValues.content && dEcho.issues === dValues.issues, { date: dEcho.date, lens: [dEcho.location.length, dEcho.content.length, dEcho.issues.length] });
    await s.screenshot('巡检-04-桌面-编辑回显.png');

    // 提交即保存：不弹审核确认、不锁定正文，列表状态为“已保存”
    const dSubmit = await attemptSubmit();
    check('日常巡检：补齐必填后提交即保存（无审核确认、列表显示已保存）',
      dSubmit.listChip === '已保存' && !dSubmit.editorOpen && /巡检已保存/.test(dSubmit.error), dSubmit);
    await s.screenshot('巡检-05-桌面-已保存.png');
    await openByCode(dSaved.code);
    const dReopen = await s.eval(`(() => ({ chip: (document.querySelector('#fwState .fw-chip') || {}).textContent || '', editable: !document.getElementById('fwF-content').readOnly, submitLabel: document.getElementById('fwSubmit').textContent.trim(), saveHidden: document.getElementById('fwSave').hidden, approveHidden: document.getElementById('fwApprove').hidden, reviseHidden: document.getElementById('fwRevise').hidden }))()`);
    check('日常巡检：已保存记录未锁定，可再次编辑且不提供审核/修订入口',
      dReopen.chip === '已保存' && dReopen.editable && dReopen.submitLabel === '保存修改' && dReopen.saveHidden && dReopen.approveHidden && dReopen.reviseHidden, dReopen);
    // 已保存巡检本人可原地“保存修改”，仍写同一条记录且不进入审核
    await s.eval(`(() => { const el = document.getElementById('fwF-issues'); el.value = '复查：立杆垫板已补齐并复核合格。'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await s.eval(`document.getElementById('fwSubmit').click()`);
    await s.waitFor(`document.getElementById('fwEditor').hidden`, '保存修改后返回列表', 25000);
    await sleep(1000);
    const dModified = await s.eval(`(() => { const tr = [...document.querySelectorAll('#fwRows tr[data-status]')].find(r => r.textContent.includes(${JSON.stringify(dSaved.code)})); return { chip: tr ? (tr.querySelector('.fw-chip') || {}).textContent.trim() : '', error: document.getElementById('fwError').textContent.replace(/\\s+/g, ' ').trim() }; })()`);
    check('日常巡检：再次打开保存修改仍为已保存且不进入审核', dModified.chip === '已保存' && /巡检修改已保存/.test(dModified.error), dModified);
    await s.screenshot('巡检-05b-桌面-保存修改.png');

    const dCsv = await downloadCsv();
    const dHeader = (dCsv.text.split('\r\n')[0] || '');
    check('日常巡检：CSV 表头覆盖全部字段（检查部位/巡视内容/发现问题）',
      /编号/.test(dHeader) && /日期/.test(dHeader) && /检查部位/.test(dHeader) && /巡视内容/.test(dHeader) && /发现问题/.test(dHeader), dHeader);
    // 前面“保存修改”已把发现问题改写为复查文案，CSV 应与改写后的当前值一致
    check('日常巡检：CSV 行内容与本记录一致', dCsv.text.includes(dSaved.code) && dCsv.text.includes('复查：立杆垫板已补齐'), { suggested: dCsv.suggested, bytes: dCsv.bytes });

    // 关闭不保存：新建后直接关闭，列表与本机暂存都不留下这条
    await reloadPage('/daily-inspection.html');
    const beforeClose = await s.eval(`document.querySelectorAll('#fwRows tr[data-status]').length`);
    await openNew('日常巡检');
    await s.eval(`(() => { const p = document.getElementById('fwF-projectId'); const v = p.value || ((p.options[1] || {}).value || ''); if (!p.value && v) { p.value = v; p.dispatchEvent(new Event('change', { bubbles: true })); } return p.value; })()`);
    await s.setValue('fwF-location', '关闭不保存验证部位');
    await s.setValue('fwF-content', '关闭不保存验证内容');
    await s.eval(`document.getElementById('fwClose').click()`);
    await s.waitFor(`document.getElementById('fwEditor').hidden`, '关闭编辑器（不保存）', 10000);
    const afterClose = await s.eval(`(() => ({ rows: document.querySelectorAll('#fwRows tr[data-status]').length, local: document.querySelectorAll('#fwLocalRows tr').length, drafts: Object.keys(sessionStorage).filter(k => /:draft:/.test(k) && /daily-inspections/.test(k)).length }))()`);
    check('日常巡检：关闭不保存时列表不新增记录且本机暂存已丢弃',
      afterClose.rows === beforeClose && afterClose.local === 0 && afterClose.drafts === 0, { beforeClose, afterClose });

    // 窄屏逐字段
    await s.metrics(768, 900, false);
    await reloadPage('/daily-inspection.html');
    await openNew('日常巡检');
    const d768 = await s.eval(MATRIX);
    await s.screenshot('巡检-06-768-新建.png');
    await closeEditor();
    await s.metrics(375, 812, true);
    await reloadPage('/daily-inspection.html');
    await openNew('日常巡检');
    const d375 = await s.eval(MATRIX);
    const d375Bad = d375.rows.filter((r) => r.right > 375 || r.w > 375);
    check('日常巡检：375 宽下逐字段单列、无横向溢出', d375.docOverflowX <= 0 && d375Bad.length === 0,
      { vw: d375.vw, overflow: d375.docOverflowX, bad: d375Bad.map((r) => ({ f: r.field, w: r.w, right: r.right })) });
    await s.screenshot('巡检-07-375-新建.png');
    await closeEditor();
    await s.metrics(320, 720, true);
    await openNew('日常巡检');
    const d320 = await s.eval(MATRIX);
    matrices.daily320 = d320.rows;
    const d320Bad = d320.rows.filter((r) => r.right > 320 || r.w > 320);
    check('日常巡检：768 宽下逐字段单列且不超屏', d768.rows.every((r) => r.right <= 768) && new Set(d768.rows.filter((r) => r.tag === 'textarea').map((r) => r.left)).size === 1,
      d768.rows.map((r) => ({ f: r.field, w: r.w, right: r.right })));
    check('日常巡检：320 宽下逐字段单列、无横向溢出', d320.docOverflowX <= 0 && d320Bad.length === 0,
      { vw: d320.vw, overflow: d320.docOverflowX, bad: d320Bad.map((r) => ({ f: r.field, w: r.w, right: r.right })) });
    await s.screenshot('巡检-08-320-新建.png');
    await closeEditor();
    await s.metrics(1440, 900, false);

    /* ===================== 旁站检查 ===================== */
    await s.send('Page.navigate', { url: BASE + '/sideline-inspection.html' });
    await s.waitFor(`document.readyState === 'complete' && !!document.getElementById('fwNew')`, '旁站检查页加载');
    await sleep(500);
    const sidTitle = await openNew('旁站检查');
    check('旁站检查：新建标题正确', sidTitle === '新建旁站检查', sidTitle);

    const sm = await s.eval(MATRIX);
    matrices.sideline = sm.rows;
    const sOrder = sm.rows.map((r) => r.field);
    const sExpected = 'inspectionDate,projectId,code,location,process,startTime,endTime,manageCount,workerCount,result,docsText,issuesText,content';
    check('旁站检查：字段清单与顺序完整（10 个业务字段 + 日期/项目/编号）', sOrder.join(',') === sExpected, sOrder);
    check('旁站检查：旁站人员按登录账号只读显示', !!sm.author && sm.author.label === '旁站人员' && sm.author.value === me, sm.author);

    const t = Object.fromEntries(sm.rows.map((r) => [r.field, r]));
    // 旁站同样支持在表单中选择项目；多项目实例下不依赖自动带出
    const sProject = await s.eval(`(() => {
      const el = document.getElementById('fwF-projectId');
      const picked = el.value || ((el.options[1] || {}).value || '');
      if (!el.value && picked) { el.value = picked; el.dispatchEvent(new Event('change', { bubbles: true })); }
      return { picked: el.value, options: el.options.length };
    })()`);
    check('旁站检查：日期默认当天、项目可在表单中选择、编号有自动生成提示',
      t.inspectionDate.type === 'date' && t.inspectionDate.value === today && sProject.options > 1 && !!sProject.picked
      && /留空由系统生成/.test(t.code.placeholder + t.code.hint), { date: t.inspectionDate.value, project: sProject, code: t.code.placeholder });

    const sRequired = ['location', 'process', 'startTime', 'endTime', 'manageCount', 'workerCount', 'result', 'docsText'];
    const sNoStar = sRequired.filter((k) => !t[k].star);
    check('旁站检查：八个必填字段均带必填标识', sNoStar.length === 0, { missing: sNoStar });
    const sNoRed = sRequired.filter((k) => !t[k].starRed || /\*/.test(t[k].label));
    check('旁站检查：必填标识与其它字段统一为红色星号（而非写在标题文字里）', sNoRed.length === 0,
      sNoRed.map((k) => ({ field: k, label: t[k].label, starRed: t[k].starRed })));
    const sNoGuide = sm.rows.filter((r) => ['location', 'process', 'startTime', 'endTime', 'manageCount', 'workerCount', 'result', 'docsText', 'issuesText', 'content'].includes(r.field))
      .filter((r) => !r.placeholder && !r.hint && !r.title && !r.aria).map((r) => r.field);
    check('旁站检查：每个业务字段都有占位示例或填写提示', sNoGuide.length === 0, { missing: sNoGuide });
    console.log('SIDELINE_FIELD_HINTS ' + JSON.stringify(sm.rows.map((r) => ({ field: r.field, label: r.label, tag: r.tag, h: r.h, placeholder: r.placeholder, hint: r.hint }))));
    const sShortBad = ['startTime', 'endTime', 'manageCount', 'workerCount'].filter((k) => t[k].tag !== 'input');
    check('旁站检查：时间与人数使用单行输入框（非 128px 多行文本域）', sShortBad.length === 0,
      sShortBad.map((k) => ({ field: k, tag: t[k].tag, h: t[k].h })));
    await s.screenshot('旁站-01-桌面-新建.png');
    await s.scrollBody('middle');
    await s.screenshot('旁站-01b-桌面-时间与人数.png');
    await s.scrollBody('top');

    await s.setValue('fwF-location', '2 号楼 3 层顶板梁板钢筋隐蔽工程');
    let r1 = await attemptSubmit();
    check('旁站检查：缺少开始/结束时间时提交被拒绝', /旁站结束时间必须晚于开始时间/.test(r1.error) && r1.chip !== '待审核', r1);

    await s.setValue('fwF-startTime', '2026-10-29 09:00:00');
    await s.setValue('fwF-endTime', '2026-10-29 09:00:00');
    let r2 = await attemptSubmit();
    check('旁站检查：结束时间等于开始时间时提交被拒绝', /旁站结束时间必须晚于开始时间/.test(r2.error) && r2.chip !== '待审核', r2);

    await s.setValue('fwF-endTime', '2026-10-29 08:00:00');
    let r3 = await attemptSubmit();
    check('旁站检查：结束时间早于开始时间时提交被拒绝', /旁站结束时间必须晚于开始时间/.test(r3.error) && r3.chip !== '待审核', r3);

    await s.setValue('fwF-startTime', '2026/10/29 08:00');
    await s.setValue('fwF-endTime', '2026/10/29 11:30');
    let r4 = await attemptSubmit();
    check('旁站检查：时间格式不规范时给出可理解的格式提示', /日期和时间|格式/.test(r4.error) && r4.chip !== '待审核', r4);

    await s.setValue('fwF-startTime', '2026-10-29 08:00:00');
    await s.setValue('fwF-endTime', '2026-10-29 11:30:00');
    let r5 = await attemptSubmit();
    check('旁站检查：缺旁站工序/结果/人员数量/关联资料时被拒绝', /旁站工序、结果、关联资料和非负整数人员数量/.test(r5.error) && r5.chip !== '待审核', r5);

    const sValues = {
      process: '梁板钢筋绑扎隐蔽验收旁站',
      manageCount: '3',
      workerCount: '12',
      result: '钢筋规格、间距、锚固长度及保护层厚度符合设计图纸与规范要求，同意进入下道工序',
      docsText: '钢筋进场复验报告 GJ-2026-031\n隐蔽工程验收记录 YS-2026-079',
      issuesText: '无',
      content: '旁站期间无异常情况，见证取样混凝土试块 2 组。',
    };
    for (const [k, v] of Object.entries(sValues)) await s.setValue('fwF-' + k, v);

    await s.setValue('fwF-manageCount', '5人');
    let r6 = await attemptSubmit();
    check('旁站检查：管理人员数填非数字时被拒绝', /非负整数人员数量/.test(r6.error) && r6.chip !== '待审核', r6);

    await s.setValue('fwF-manageCount', '-1');
    let r7 = await attemptSubmit();
    check('旁站检查：人员数为负数时被拒绝', /非负整数人员数量/.test(r7.error) && r7.chip !== '待审核', r7);

    await s.setValue('fwF-manageCount', '3');
    await s.setValue('fwF-docsText', '');
    let r8 = await attemptSubmit();
    check('旁站检查：关联工程资料为空时被拒绝', /关联资料/.test(r8.error) && r8.chip !== '待审核', r8);
    await s.screenshot('旁站-02-桌面-逐项校验.png');

    await s.setValue('fwF-docsText', sValues.docsText);
    const sSaved = await saveDraft();
    check('旁站检查：补全后保存草稿成功并生成编号', /^[A-Za-z0-9-]{6,}$/.test(sSaved.code) && sSaved.chip === '草稿', sSaved);
    await s.screenshot('旁站-03-桌面-保存草稿.png');

    await closeEditor();
    await openByCode(sSaved.code);
    const sEcho = await s.eval(`(() => { const v = (f) => document.getElementById('fwF-' + f).value; return { location: v('location'), process: v('process'), start: v('startTime'), end: v('endTime'), manage: v('manageCount'), worker: v('workerCount'), result: v('result'), docs: v('docsText'), issues: v('issuesText'), content: v('content') }; })()`);
    const sEchoOk = sEcho.location === '2 号楼 3 层顶板梁板钢筋隐蔽工程' && sEcho.process === sValues.process
      && sEcho.start === '2026-10-29 08:00:00' && sEcho.end === '2026-10-29 11:30:00'
      && sEcho.manage === '3' && sEcho.worker === '12' && sEcho.result === sValues.result
      && sEcho.docs === sValues.docsText && sEcho.issues === '无' && sEcho.content === sValues.content;
    check('旁站检查：草稿回显十个业务字段逐字段一致（含换行资料清单）', sEchoOk, sEcho);
    await s.screenshot('旁站-04-桌面-编辑回显.png');

    const sSubmit = await attemptSubmit();
    const sLock = await s.eval(`(() => ({ chip: (document.querySelector('#fwState .fw-chip') || {}).textContent || '', saveHidden: document.getElementById('fwSave').hidden, readonly: document.getElementById('fwF-result').readOnly }))()`);
    check('旁站检查：补全后提交成功、状态待审核并锁定正文', sLock.chip === '已提交（待审核）' && sLock.saveHidden && sLock.readonly, { ...sLock, notice: sSubmit.error });
    await s.screenshot('旁站-05-桌面-已提交待审核.png');
    await closeEditor();

    const sCsv = await downloadCsv();
    const sHeader = (sCsv.text.split('\r\n')[0] || '');
    const sLine = sCsv.text.split('\r\n').find((l) => l.includes(sSaved.code)) || '';
    const headersNeeded = ['旁站部位', '旁站工序', '开始时间', '结束时间', '施工管理人员数', '施工人员数', '旁站结果', '关联工程资料', '发现问题及处理情况', '其他旁站记录'];
    const missingHeaders = headersNeeded.filter((h) => !sHeader.includes(h));
    const sCsvHasJson = /"{""process""/.test(sLine) || sLine.includes('{"process"');
    check('旁站检查：CSV 表头覆盖十个业务字段且不暴露内部 JSON', missingHeaders.length === 0 && !sCsvHasJson, { missingHeaders, json: sCsvHasJson });
    check('旁站检查：CSV 行含工序/结果/资料清单', sLine.includes('梁板钢筋绑扎隐蔽验收旁站') && sLine.includes('钢筋进场复验报告') && sLine.includes('隐蔽工程验收记录'), sLine.slice(0, 300));
    const sCsvTime = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(sLine);
    check('旁站检查：CSV 时间列保持 YYYY-MM-DD HH:mm:ss 格式', !!sCsvTime && sCsvTime[0].indexOf('T') < 0, sCsvTime ? sCsvTime[0] : sLine.slice(0, 200));

    await s.metrics(768, 900, false);
    await reloadPage('/sideline-inspection.html');
    await openNew('旁站检查');
    const s768 = await s.eval(MATRIX);
    await s.screenshot('旁站-06-768-新建.png');
    await closeEditor();
    await s.metrics(320, 720, true);
    await openNew('旁站检查');
    const s320 = await s.eval(MATRIX);
    matrices.sideline320 = s320.rows;
    const s320Bad = s320.rows.filter((r) => r.right > 320 || r.w > 320);
    check('旁站检查：768 宽下逐字段单列且不超屏', s768.rows.every((r) => r.right <= 768) && new Set(s768.rows.filter((r) => r.tag === 'textarea').map((r) => r.left)).size === 1,
      s768.rows.map((r) => ({ f: r.field, w: r.w, right: r.right })));
    check('旁站检查：320 宽下逐字段单列、无横向溢出', s320.docOverflowX <= 0 && s320Bad.length === 0,
      { vw: s320.vw, overflow: s320.docOverflowX, bad: s320Bad.map((r) => ({ f: r.field, w: r.w, right: r.right })) });
    await s.screenshot('旁站-07-320-新建.png');
    await closeEditor();
    await s.metrics(1440, 900, false);

    const badConsole = consoleErrors.filter((e) => !/favicon/i.test(e));
    check('两个页面无业务控制台错误', badConsole.length === 0, badConsole.slice(0, 5));
  } catch (e) {
    check('验收脚本执行完成', false, { error: e.message });
  }

  fs.writeFileSync(path.join(OUT, '验收结果.json'), JSON.stringify({ results, consoleErrors, downloads, matrices }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`TOTAL ${results.length} PASS ${results.length - failed} FAIL ${failed}`);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
