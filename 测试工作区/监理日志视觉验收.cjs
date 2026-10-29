// 监理日志浏览器视觉/交互验收：CDP 驱动真实 Edge，截图、填表、上传、提交、导出均为真实行为。
// 依赖隔离环境：静态页 18081 -> 后端 18080（e2e H2 内存库），不接触业务库。
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 19222;
const BASE = 'http://localhost:18081';
const OUT = path.join(__dirname, '监理日志视觉验收');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 新建空白页目标：旧页面若停在未同步草稿，导航会被 beforeunload 阻断
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
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.handlers.forEach((h) => h(msg));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
  on(fn) { this.handlers.push(fn); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('Eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
  async evalHandle(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: false });
    if (r.exceptionDetails) throw new Error('Eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result;
  }
  async waitFor(expression, desc, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (await this.eval(expression)) return true; } catch (_) { /* 页面切换中 */ }
      await sleep(150);
    }
    throw new Error('等待超时: ' + desc);
  }
  async metrics(width, height, mobile) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: !!mobile, screenWidth: width, screenHeight: height,
    });
  }
  async screenshot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  async clickByText(sel, text) {
    const box = await this.eval(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => (e.textContent || '').trim().includes(${JSON.stringify(text)}));
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) throw new Error('未找到按钮: ' + text);
    await this.clickAt(box.x, box.y);
    return box;
  }
  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async setValue(id, value) {
    return this.eval(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === ${JSON.stringify(value)};
    })()`);
  }
  async setFiles(id, files) {
    const h = await this.evalHandle(`document.getElementById(${JSON.stringify(id)})`);
    await this.send('DOM.setFileInputFiles', { files, objectId: h.objectId });
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

(async () => {
  // 只接管真实页面目标：下载中心/开发者工具等内部页面不支持视口覆写
  const list = await httpJson('/json/list');
  const pages = list.filter((t) => t.type === 'page' && !/^(edge|devtools|chrome):/i.test(t.url || ''));
  // 优先接管干净的空白页：若上一轮遗留 beforeunload 对话框，旧页面目标会阻塞 Page.enable
  let target = pages.find((t) => t.url === 'about:blank');
  if (!target) { try { target = await newBlankTarget(); } catch (_) { /* 新建失败时回退 */ } }
  target = target || pages.find((t) => (t.url || '').includes('localhost:18081')) || pages[0];
  if (!target) throw new Error('没有可用的浏览器页面目标');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const s = new Session(ws);

  const consoleErrors = [];
  const downloads = [];
  s.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXCEPTION: ' + (msg.params.exceptionDetails.text || '') + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
    }
    if (msg.method === 'Page.downloadWillBegin') downloads.push(msg.params);
    // 页面在草稿未同步时会拦截 beforeunload，自动确认以免导航卡死
    if (msg.method === 'Page.javascriptDialogOpening') { s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { }); }
  });

  await Promise.all([
    s.send('Page.enable'), s.send('Runtime.enable'), s.send('Network.enable'), s.send('DOM.enable'),
  ]);
  // 上一轮遗留的 beforeunload 对话框会阻塞导航，先尝试关掉
  await s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { });
  await s.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: DL_DIR, eventsEnabled: true });

  try {
    // ---------- 登录 ----------
    await s.metrics(1440, 900, false);
    await s.send('Page.navigate', { url: BASE + '/login.html' });
    await s.waitFor(`document.readyState === 'complete'`, '登录页就绪');
    // 同一 profile 的残留 token 会让 login.html 直接跳首页，先清会话再重进
    await s.eval(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) { } return true; })()`);
    await s.send('Page.navigate', { url: BASE + '/login.html' });
    await s.waitFor(`document.readyState === 'complete' && !!document.getElementById('loginBtn')`, '登录页加载');
    await s.setValue('username', 'admin');
    await s.setValue('password', '123456');
    await s.clickByText('button', '登 录');
    await s.waitFor(`location.pathname !== '/login.html'`, '登录跳转', 20000);
        // 跳转后新文档的 app.js 可能尚未执行完，等 App 上下文就绪再调接口
        await s.waitFor(`typeof App !== 'undefined' && !!App.getUser()`, '登录后应用上下文就绪', 20000);

    // ---------- 准备项目（隔离库；沿用已有长名称项目作为窄屏压力数据） ----------
    const setup = await s.eval(`(async () => {
      let page = await App.apiGetPage('/projects', { pageNum: 1, pageSize: 200 });
      if (!page.list || !page.list.length) {
        await App.apiFetch('/projects', { method: 'POST', body: {
          name: '监理日志视觉验收项目（长工程名称响应式检查）', code: 'SLOG-VISUAL-01',
          buildUnit: '视觉验收测试建设单位', status: 'active'
        }});
        page = await App.apiGetPage('/projects', { pageNum: 1, pageSize: 200 });
      }
      const logs = await App.apiGetPage('/supervision-logs', { pageNum: 1, pageSize: 200 });
      return { projects: page.total, logs: logs.total, names: page.list.map(p => p.name), longest: Math.max(...page.list.map(p => p.name.length)) };
    })()`);
    check('隔离环境准备：项目与监理日志列表可访问', setup.projects >= 1, setup);

    // ---------- 加载页面 ----------
    await s.send('Page.navigate', { url: BASE + '/supervision-log.html' });
    await s.waitFor(`document.readyState === 'complete' && !!document.getElementById('fwNew')`, '监理日志页加载', 20000);
    await s.waitFor(`!document.querySelector('#fwRows tr[data-app-placeholder]') || document.querySelectorAll('#fwRows tr').length > 0`, '列表首屏', 20000);
    const initialRows = await s.eval(`document.querySelectorAll('#fwRows tr[data-app-placeholder]').length ? 0 : document.querySelectorAll('#fwRows tr').length`);
    const overview = await s.eval(`(() => {
      const vw = document.documentElement.clientWidth;
      return {
        vw, summary: (document.getElementById('fwSummary').textContent || '').trim(),
        toolbarControls: [...document.querySelectorAll('.fw-toolbar select, .fw-toolbar input')].map(e => { const r = e.getBoundingClientRect(); return { id: e.id, right: Math.round(r.right), w: Math.round(r.width) }; }),
        docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    check('桌面列表页无横向溢出且工具栏控件在视口内', overview.docOverflowX <= 0 && overview.toolbarControls.every((c) => c.right <= overview.vw), overview);

    // ---------- 桌面：新建监理日志 ----------
    // 模板页新建前需选定单一项目（多项目且未选会阻止新建），先选第一个获授权项目
    await s.eval(`(() => { const sel = document.getElementById('fwProject'); if (sel.options.length > 1) { sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change')); } return true; })()`);
    await sleep(400);
    await s.clickByText('button', '新建监理日志');
    await s.waitFor(`!document.getElementById('fwEditor').hidden`, '新建编辑器打开');
    await sleep(600);

    const today = await s.eval(`(() => { const d = new Date(); const p = (n) => n < 10 ? '0' + n : '' + n; return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()); })()`);
    const desktop = await s.eval(`(() => {
      const editor = document.getElementById('fwEditor');
      const modal = editor.querySelector('.fd-modal');
      const grid = document.getElementById('fwForm');
      const footer = editor.querySelector('.fd-footer');
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
      const field = (f) => document.getElementById('fwF-' + f);
      const ph = (f) => getComputedStyle(field(f), '::placeholder');
      const width = (f) => Math.round(field(f).getBoundingClientRect().width);
      const mains = ['construction', 'inspection', 'safetyIssues', 'otherMatters'];
      const compat = document.querySelector('#fwForm .fd-compat');
      return {
        vw: innerWidth, vh: innerHeight,
        docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyOverflowX: editor.querySelector('.fd-body').scrollWidth - editor.querySelector('.fd-body').clientWidth,
        modal: rect(modal),
        gridCols: getComputedStyle(grid).gridTemplateColumns,
        title: document.getElementById('fwTitle').textContent.trim(),
        project: (grid.querySelector('[data-field="projectId"]') ? '' : (grid.querySelector('.fd-field .fd-readonly') || {}).textContent || '').trim(),
        projectReadonly: !grid.querySelector('[data-field="projectId"]'),
        dateValue: field('logDate').value, dateReadonly: field('logDate').readOnly,
        author: [...grid.querySelectorAll('.fd-readonly')].map(e => (e.textContent || '').trim()),
        weather: { value: field('weather').value, ph: field('weather').placeholder, color: ph('weather').color, opacity: ph('weather').opacity },
        wind: { value: field('wind').value, ph: field('wind').placeholder, color: ph('wind').color },
        temp: { value: field('temperature').value, ph: field('temperature').placeholder, color: ph('temperature').color },
        guide: (document.getElementById('fwGuide').textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
        mains: mains.map((f) => ({
          f, w: width(f), h: Math.round(field(f).getBoundingClientRect().height),
          ph: field(f).placeholder, scrollH: field(f).scrollHeight, clientH: field(f).clientHeight,
        })),
        compat: compat ? {
          open: compat.open, summary: compat.querySelector('summary').textContent.trim(),
          fields: [...compat.querySelectorAll('[data-field]')].map(e => e.dataset.field),
        } : null,
        footer: rect(footer),
        footerButtons: [...footer.querySelectorAll('button')].filter(b => !b.hidden).map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; }),
        close: rect(document.getElementById('fwClose')),
      };
    })()`);
    await s.screenshot('01-桌面-新建顶部.png');

    check('新建标题与卡片尺寸符合模板', desktop.title === '新建监理日志' && desktop.modal.w === 1000, { title: desktop.title, modal: desktop.modal });
    check('工程名称自动带入且只读', !!desktop.project && desktop.projectReadonly, { project: desktop.project });
    check('日期自动当天且只读、填写人按账号带入', desktop.dateValue === today && desktop.dateReadonly && desktop.author.some((t) => t && t !== '—'), { date: desktop.dateValue, today, author: desktop.author });
    check('气象三项 placeholder 完整、灰色、值为空', ['weather', 'wind', 'temp'].every((k) => desktop[k].value === '' && desktop[k].ph.length > 4 && desktop[k].color === 'rgb(156, 163, 175)'), {
      weather: desktop.weather, wind: desktop.wind, temp: desktop.temp,
    });
    check('填写指引显示 9 项规范与记录要求', /监理日志填写指引 · 9 项规范/.test(desktop.guide) && desktop.guide.length > 120, desktop.guide.slice(0, 120));
    const mains = desktop.mains;
    check('四个正文栏目等宽全宽展示', mains.every((m) => Math.abs(m.w - mains[0].w) <= 1) && mains[0].w >= desktop.modal.w - 90, {
      widths: mains.map((m) => m.w), modalW: desktop.modal.w,
    });
    check('四个正文高度合理且巡视检查最高', mains[1].h >= 232 && mains[0].h >= 128 && mains[1].h > mains[0].h, mains.map((m) => ({ f: m.f, h: m.h })));
    check('四个正文 placeholder 完整且未被截断', mains[1].ph.includes('①') && mains[1].ph.includes('⑤') && mains[2].ph.includes('重大危险源') && mains[3].ph.includes('停工') && mains[0].ph.length > 10 && mains.every((m) => m.scrollH <= m.clientH + 2), {
      lengths: mains.map((m) => m.ph.length), scroll: mains.map((m) => [m.scrollH, m.clientH]),
    });
    check('旧栏目折叠区默认收起并保留 6 个字段', !!desktop.compat && desktop.compat.open === false && desktop.compat.fields.length === 6, desktop.compat);
    check('底栏七个操作按钮可见可点', desktop.footerButtons.length === 7 && desktop.footerButtons.every((b) => b.w > 0 && b.h >= 32), desktop.footerButtons);
    check('桌面两列布局且无横向溢出', desktop.gridCols.split(' ').length === 2 && desktop.docOverflowX <= 0 && desktop.bodyOverflowX <= 0, { gridCols: desktop.gridCols, doc: desktop.docOverflowX, body: desktop.bodyOverflowX });

    // 底部固定操作栏：滚动正文后仍在视口内
    await s.scrollBody('middle');
    await s.screenshot('02-桌面-新建中部.png');
    const mid = await s.eval(`(() => { const f = document.getElementById('fwEditor').querySelector('.fd-footer').getBoundingClientRect(); const b = document.querySelector('#fwEditor .fd-body'); return { footerBottom: Math.round(f.bottom), vh: innerHeight, scrollTop: b.scrollTop }; })()`);
    check('正文滚动时底部操作栏常驻视口', mid.footerBottom <= mid.vh + 1 && mid.scrollTop > 0, mid);
    await s.scrollBody('bottom');
    await s.screenshot('03-桌面-新建底部与附件.png');

    // ---------- 响应式：768 / 375 / 320 ----------
    const measure = async (w, h, mobile) => {
      await s.metrics(w, h, mobile);
      await sleep(400);
      return s.eval(`(() => {
        const vw = document.documentElement.clientWidth;
        const modal = document.querySelector('#fwEditor .fd-modal');
        const body = document.querySelector('#fwEditor .fd-body');
        const footer = document.querySelector('#fwEditor .fd-footer');
        const grid = document.getElementById('fwForm');
        const proj = document.getElementById('fwProject');
        const pr = proj.getBoundingClientRect();
        const btns = [...footer.querySelectorAll('button')].filter(b => !b.hidden).map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; });
        const close = document.getElementById('fwClose').getBoundingClientRect();
        const mains = ['construction','inspection','safetyIssues','otherMatters'].map(f => { const el = document.getElementById('fwF-' + f); const r = el.getBoundingClientRect(); return { f, w: Math.round(r.width), right: Math.round(r.right) }; });
        return {
          vw, vh: innerHeight,
          docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          bodyOverflowX: body.scrollWidth - body.clientWidth,
          modalW: Math.round(modal.getBoundingClientRect().width),
          modalRight: Math.round(modal.getBoundingClientRect().right),
          gridCols: getComputedStyle(grid).gridTemplateColumns,
          toolbarSelect: { w: Math.round(pr.width), right: Math.round(pr.right) },
          closeRight: Math.round(close.right),
          btns, mains,
          footerBottom: Math.round(footer.getBoundingClientRect().bottom),
        };
      })()`);
    };
    const m768 = await measure(768, 800, false);
    check('768 单列且无横向溢出、底栏按钮全在视口内', m768.gridCols.split(' ').length === 1 && m768.docOverflowX <= 0 && m768.bodyOverflowX <= 0 && m768.btns.every((b) => b.right <= 768 && b.bottom <= 800), m768);

    const m375 = await measure(375, 667, true);
    await s.scrollBody('top');
    await s.screenshot('04-手机375-新建顶部.png');
    check('375 无横向溢出且弹窗不超屏（工具栏下拉不再撑宽）', m375.docOverflowX <= 0 && m375.bodyOverflowX <= 0 && m375.modalW <= 375 && m375.toolbarSelect.right <= 375 && m375.closeRight <= 375, m375);
    check('375 正文全宽、底栏按钮均在视口内', m375.mains.every((m) => m.right <= 375) && m375.btns.every((b) => b.right <= 375 && b.left >= 0 && b.h >= 32), { mains: m375.mains, btns: m375.btns });

    const m320 = await measure(320, 568, true);
    await s.screenshot('05-手机320-新建顶部.png');
    check('320 无横向溢出且底栏按钮可点', m320.docOverflowX <= 0 && m320.bodyOverflowX <= 0 && m320.btns.every((b) => b.right <= 320 && b.left >= 0 && b.h >= 32) && m320.toolbarSelect.right <= 320, m320);

    // ---------- 回到桌面填写 ----------
    await s.metrics(1440, 900, false);
    await sleep(300);
    await s.scrollBody('top');
    await s.setValue('fwF-weather', '晴，午后短时多云');
    await s.setValue('fwF-wind', '东北风 3 级');
    await s.setValue('fwF-temperature', '18℃~26℃');
    await s.setValue('fwF-construction', '主楼 6 层顶板钢筋绑扎完成 80%，模板支设同步进行；地下室防水保护层施工完成。');
    await s.setValue('fwF-inspection', '①专职安全员在岗履职，交接班记录齐全；\n②特种作业人员 6 人证件均在有效期内；\n③塔吊运行正常，进出场登记完整；\n④临时用电二级箱漏电保护试跳正常；\n⑤外脚手架连墙件无缺失，验收记录齐全。');
    await s.setValue('fwF-safetyIssues', '当日无重大危险源。发现 6 层临边防护栏杆一处缺失，已当场整改并复查合格。');
    await s.setValue('fwF-otherMatters', '下午区住建局安全监督站到现场检查，未下发整改通知单。');
    const filled = await s.eval(`({ weather: document.getElementById('fwF-weather').value, construction: document.getElementById('fwF-construction').value, inspection: document.getElementById('fwF-inspection').value.length, inspectionHas5: document.getElementById('fwF-inspection').value.includes('⑤'), safety: document.getElementById('fwF-safetyIssues').value.length, other: document.getElementById('fwF-otherMatters').value.length })`);
    check('五个栏目可正常填写（正文提示不进入正文）', filled.weather === '晴，午后短时多云' && filled.construction.includes('6 层顶板') && filled.inspection > 60 && filled.inspectionHas5 && filled.safety > 30 && filled.other > 20, filled);

    // ---------- 附件真实上传（该页无目录绑定，验证既有上传通道未受影响） ----------
    const pdfPath = path.join(OUT, '验收测试-监理日志附件.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    await s.setFiles('fwUpload', [pdfPath]);
    await s.waitFor(`document.querySelectorAll('#fwMedia .fd-file-row').length === 1`, '附件上传完成', 25000);
    const uploadState = await s.eval(`(() => {
      const row = document.querySelector('#fwMedia .fd-file-row');
      return {
        rows: document.querySelectorAll('#fwMedia .fd-file-row').length,
        name: row ? row.querySelector('.fd-file-name').textContent.trim() : '',
        buttons: row ? [...row.querySelectorAll('button')].map(b => b.textContent.trim()) : [],
        state: document.getElementById('fwUploadState').textContent.trim(),
        hasDirEntry: !!document.querySelector('#dirTreeModal, .dir-label, #fwUploadDir'),
        guide: document.getElementById('fwGuide').textContent.replace(/\\s+/g, ' ').trim(),
      };
    })()`);
    check('PDF 附件真实上传并显示文件名与操作', uploadState.rows === 1 && uploadState.name.includes('.pdf') && uploadState.buttons.some((t) => t === '移除'), uploadState);
    check('上传结果同步到填写指引且不引入目录绑定入口', /附件 1 个/.test(uploadState.guide) && uploadState.hasDirEntry === false, { guide: uploadState.guide.slice(-60), hasDirEntry: uploadState.hasDirEntry });
    await s.scrollBody('bottom');
    await s.screenshot('06-桌面-附件已上传.png');

    // ---------- 保存草稿 ----------
    const rowsBefore = await s.eval(`document.querySelectorAll('#fwRows tr[data-app-placeholder]').length ? 0 : document.querySelectorAll('#fwRows tr').length`);
    await s.clickByText('#fwEditor .fd-footer button', '保存草稿');
    await s.waitFor(`/监理日志 · /.test(document.getElementById('fwTitle').textContent)`, '草稿保存并生成编号', 25000);
    const draftState = await s.eval(`(() => ({
      title: document.getElementById('fwTitle').textContent.trim(),
      chip: (document.querySelector('#fwState .fw-chip') || {}).textContent || '',
      state: document.getElementById('fwState').textContent.replace(/\\s+/g, ' ').trim(),
      editorOpen: !document.getElementById('fwEditor').hidden,
    }))()`);
    const code = (draftState.title.split('·')[1] || '').trim();
    check('保存草稿成功并生成编号、状态为草稿', /^[A-Za-z0-9-]{6,}$/.test(code) && draftState.chip === '草稿', { code, chip: draftState.chip, detail: draftState.state });
    await s.screenshot('07-桌面-保存草稿后.png');

    // 关闭编辑器后核对列表（保存后 dirty=false，关闭不需二次确认；保存收尾期按钮可能暂时禁用，按状态重试）
    for (let i = 0; i < 6; i++) {
      if (await s.eval(`document.getElementById('fwEditor').hidden`)) break;
      await s.eval(`document.getElementById('fwClose').click()`);
      await sleep(600);
      if (await s.eval(`!!document.querySelector('[data-act="ok"]')`)) {
        await s.eval(`document.querySelector('[data-act="ok"]').click()`);
        await sleep(400);
      }
    }
    await s.waitFor(`document.getElementById('fwEditor').hidden`, '关闭编辑器', 10000);
    await s.waitFor(`document.querySelectorAll('#fwRows tr[data-app-placeholder]').length ? false : document.querySelectorAll('#fwRows tr').length === ${rowsBefore + 1}`, '列表新增一条记录', 20000);
    const draftRow = await s.eval(`(() => {
      const tr = [...document.querySelectorAll('#fwRows tr')].find(r => r.textContent.includes(${JSON.stringify(code)}));
      return tr ? { text: tr.textContent.replace(/\\s+/g, ' ').trim(), cells: [...tr.querySelectorAll('td')].map(td => td.textContent.trim()) } : null;
    })()`);
    check('列表出现新草稿且状态/日期正确', !!draftRow && /草稿/.test(draftRow.text) && draftRow.text.includes(today), draftRow);
    await s.screenshot('08-桌面-列表草稿.png');

    // ---------- 编辑回显 ----------
    await s.eval(`(() => { const tr = [...document.querySelectorAll('#fwRows tr')].find(r => r.textContent.includes(${JSON.stringify(code)})); tr.querySelector('button[data-id]').click(); return true; })()`);
    await s.waitFor(`!document.getElementById('fwEditor').hidden && document.getElementById('fwTitle').textContent.includes(${JSON.stringify(code)})`, '编辑弹窗打开', 20000);
    await sleep(500);
    const editState = await s.eval(`(() => {
      const v = (f) => document.getElementById('fwF-' + f).value;
      const ro = [...document.querySelectorAll('#fwForm .fd-readonly')].map(e => (e.textContent || '').trim());
      return {
        project: ro[0] || '', date: v('logDate'), author: ro[1] || '',
        weather: v('weather'), wind: v('wind'), temp: v('temperature'),
        construction: v('construction'), inspection: v('inspection'), safety: v('safetyIssues'), other: v('otherMatters'),
        files: [...document.querySelectorAll('#fwMedia .fd-file-row .fd-file-name')].map(e => e.textContent.trim()),
        editable: !document.getElementById('fwSave').hidden,
      };
    })()`);
    check('编辑回显全部填写内容与工程/日期', editState.weather === '晴，午后短时多云' && editState.wind === '东北风 3 级' && editState.temp === '18℃~26℃'
      && editState.construction.includes('6 层顶板') && editState.inspection.includes('⑤') && editState.safety.includes('重大危险源') && editState.other.includes('住建局')
      && editState.date === today && editState.project.length > 0, editState);
    check('编辑回显保留附件且草稿可继续编辑', editState.files.length === 1 && editState.files[0].includes('.pdf') && editState.editable, { files: editState.files, editable: editState.editable });
    await s.scrollBody('top');
    await s.screenshot('09-桌面-编辑回显.png');

    // ---------- 提交（含确认弹窗） ----------
    await s.eval(`document.getElementById('fwSubmit').click()`);
    await s.waitFor(`!!document.querySelector('[data-act="ok"]')`, '提交确认弹窗出现', 10000);
    await s.eval(`document.querySelector('[data-act="ok"]').click()`);
    await s.waitFor(`(document.querySelector('#fwState .fw-chip') || {}).textContent === '待审核'`, '提交后状态为待审核', 25000);
    const submitted = await s.eval(`(() => ({ chip: document.querySelector('#fwState .fw-chip').textContent, saveHidden: document.getElementById('fwSave').hidden, submitHidden: document.getElementById('fwSubmit').hidden }))()`);
    check('提交后状态为待审核且正文锁定（保存/提交隐藏）', submitted.chip === '待审核' && submitted.saveHidden && submitted.submitHidden, submitted);
    await s.screenshot('10-桌面-已提交待审核.png');
    await s.eval(`document.getElementById('fwClose').click()`);
    await s.waitFor(`document.getElementById('fwEditor').hidden`, '提交后关闭');
    const submittedRow = await s.eval(`(() => { const tr = [...document.querySelectorAll('#fwRows tr')].find(r => r.textContent.includes(${JSON.stringify(code)})); return tr ? tr.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
    check('列表状态同步为待审核', /待审核/.test(submittedRow), submittedRow);

    // ---------- CSV 导出（真实落盘） ----------
    const beforeGuids = downloads.map((d) => d.guid);
    await s.eval(`document.getElementById('fwExport').click()`);
    let csvFile = null;
    const end = Date.now() + 20000;
    while (Date.now() < end && !csvFile) {
      const ev = downloads.find((d) => !beforeGuids.includes(d.guid));
      if (ev) {
        const f = path.join(DL_DIR, ev.guid);
        if (fs.existsSync(f) && fs.statSync(f).size > 100) csvFile = { file: f, bytes: fs.statSync(f).size, suggested: ev.suggestedFilename };
      }
      await sleep(200);
    }
    const csvText = csvFile ? fs.readFileSync(csvFile.file, 'utf8') : '';
    check('导出筛选结果 CSV 真实下载且内容正确', !!csvFile && /监理日志-\d{4}-\d{2}-\d{2}\.csv/.test(csvFile.suggested || '') && csvText.includes('编号') && csvText.includes('工程名称') && csvText.includes(code) && csvText.includes(today), {
      file: csvFile, head: csvText.slice(0, 120),
    });
    await s.screenshot('11-桌面-CSV导出.png');

    // ---------- 收尾：再次进入新建确认不残留 ----------
    await s.eval(`document.getElementById('fwNew').click()`);
    await s.waitFor(`!document.getElementById('fwEditor').hidden`, '再次新建');
    const fresh = await s.eval(`(() => {
      const v = (f) => document.getElementById('fwF-' + f).value;
      return { title: document.getElementById('fwTitle').textContent.trim(), weather: v('weather'), construction: v('construction'), files: document.querySelectorAll('#fwMedia .fd-file-row').length, date: v('logDate') };
    })()`);
    check('再次新建不残留上一份正文与附件', fresh.weather === '' && fresh.construction === '' && fresh.files === 0 && fresh.date === today, fresh);

    const badConsole = consoleErrors.filter((e) => !/favicon/i.test(e));
    check('页面无业务控制台错误', badConsole.length === 0, badConsole.slice(0, 5));
  } catch (e) {
    check('验收脚本执行完成', false, { error: e.message });
  }

  fs.writeFileSync(path.join(OUT, '验收结果.json'), JSON.stringify({ results, consoleErrors, downloads }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`TOTAL ${results.length} PASS ${results.length - failed} FAIL ${failed}`);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
