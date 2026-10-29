// 安全日志浏览器视觉/交互验收：通过 CDP 驱动真实 Edge 渲染，截图与操作均为真实浏览器行为。
// 依赖已启动的隔离环境：静态页 18081 -> 后端 18080（e2e H2 内存库），不接触业务库。
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 19222;
const BASE = 'http://localhost:18081';
const OUT = path.join(__dirname, '安全日志视觉验收');
fs.mkdirSync(OUT, { recursive: true });

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
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
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
  async scrollModalBody(where) {
    return this.eval(`(() => {
      const b = document.querySelector('#createModal .modal-body');
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
  // 优先用干净的空白页，避免上一轮遗留的 beforeunload 对话框阻塞 Page.enable
  let target = pages.find((t) => t.url === 'about:blank');
  if (!target) { try { target = await newBlankTarget(); } catch (_) { /* 新建失败时回退 */ } }
  target = target || pages.find((t) => (t.url || '').includes('localhost:18081')) || pages[0];
  if (!target) throw new Error('没有可用的浏览器页面目标');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const s = new Session(ws);

  const consoleErrors = [];
  const exportResponses = [];
  const downloads = [];
  s.on(async (msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('EXCEPTION: ' + (msg.params.exceptionDetails.text || '') + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
    }
    if (msg.method === 'Network.responseReceived' && /\/api\/safety-logs(\/\d+)?\/export/.test(msg.params.response.url)) {
      exportResponses.push({ requestId: msg.params.requestId, url: msg.params.response.url, status: msg.params.response.status, headers: msg.params.response.headers, mimeType: msg.params.response.mimeType });
    }
    if (msg.method === 'Page.downloadWillBegin') downloads.push(msg.params);
    // 草稿未同步时页面会弹 beforeunload，自动确认避免导航卡死
    if (msg.method === 'Page.javascriptDialogOpening') { s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { }); }
  });

  await Promise.all([
    s.send('Page.enable'), s.send('Runtime.enable'), s.send('Network.enable'), s.send('DOM.enable'),
  ]);
  await s.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: path.join(OUT, 'downloads'), eventsEnabled: true });

  try {
    // ---------- 登录 ----------
    await s.metrics(1440, 900, false);
    await s.send('Page.navigate', { url: BASE + '/login.html' });
    await s.waitFor(`document.readyState === 'complete'`, '登录页就绪');
    // 同一浏览器 profile 里的旧 token 会让 login.html 直接跳首页，先清空会话再重新进登录页
    await s.eval(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) { } return true; })()`);
    await s.send('Page.navigate', { url: BASE + '/login.html' });
    await s.waitFor(`document.readyState === 'complete' && !!document.getElementById('loginBtn')`, '登录页加载');
    await s.setValue('username', 'admin');
    await s.setValue('password', '123456');
    await s.clickByText('button', '登 录');
    await s.waitFor(`location.pathname !== '/login.html'`, '登录跳转', 20000);

    // ---------- 准备测试项目（隔离内存库，仅一条，验证单项目自动带入） ----------
    await s.send('Page.navigate', { url: BASE + '/safety-log.html' });
    await s.waitFor(`document.readyState === 'complete' && !!window.App`, '安全日志页加载');
    const setup = await s.eval(`(async () => {
      const page = await App.apiGetPage('/projects', { pageNum: 1, pageSize: 200 });
      if (!page.list || page.list.length === 0) {
        await App.apiFetch('/projects', { method: 'POST', body: {
          name: '安全日志视觉验收项目（长工程名称响应式检查）', code: 'SAFETY-VISUAL-01',
          buildUnit: '视觉验收测试建设单位', status: 'active'
        }});
        await loadProjects();
      }
      // 隔离内存库内清理上一轮遗留记录，保证“首条记录为本次新建”的断言可重复
      const oldLogs = await App.apiGetPage('/safety-logs', { pageNum: 1, pageSize: 200 });
      for (const r of (oldLogs.list || [])) {
        try { await App.apiFetch('/safety-logs/' + r.id, { method: 'DELETE' }); } catch (e) { }
      }
      await loadData();
      const proj = (await App.apiGetPage('/projects', { pageNum: 1, pageSize: 200 })).list[0];
      let tree = await App.apiFetch('/sub-item-databases/tree?projectId=' + encodeURIComponent(proj.id));
      if (!tree || !tree.length) {
        const post = (body) => App.apiFetch('/sub-item-databases', { method: 'POST', body: body });
        const root = await post({ projectId: proj.id, name: '视觉验收工程资料', sortOrder: 1 });
        const unit = await post({ projectId: proj.id, parentId: root.id, name: '单位工程：主楼', sortOrder: 1 });
        const part = await post({ projectId: proj.id, parentId: unit.id, name: '分部工程：地基基础', sortOrder: 1 });
        await post({ projectId: proj.id, parentId: part.id, name: '分项工程：土方工程', sortOrder: 1 });
        await post({ projectId: proj.id, parentId: part.id, name: '分项工程：桩基工程', sortOrder: 2 });
        tree = await App.apiFetch('/sub-item-databases/tree?projectId=' + encodeURIComponent(proj.id));
      }
      const countLeaves = (nodes) => (nodes || []).reduce((n, x) => n + ((x.children && x.children.length) ? countLeaves(x.children) : 1), 0);
      return { projects: Object.keys(projectsMap).length, rows: tableData.length, dirRoots: (tree || []).length, dirLeaves: countLeaves(tree) };
    })()`);
    check('隔离环境准备：项目与列表可加载', setup.projects >= 1 && setup.rows >= 0, setup);
    check('隔离环境准备：项目资料目录可作为附件存储位置', setup.dirRoots >= 1 && setup.dirLeaves >= 1, { dirRoots: setup.dirRoots, dirLeaves: setup.dirLeaves });

    // ---------- 桌面：新建弹窗 ----------
    await s.clickByText('button', '新建安全日志');
    await s.waitFor(`document.getElementById('createModal').classList.contains('show')`, '新建弹窗打开');

    const desktop = await s.eval(`(() => {
      const modal = document.querySelector('#createModal .modal');
      const body = document.querySelector('#createModal .modal-body');
      const grid = document.getElementById('safetyProjectName').closest('.fd-grid');
      const ta = (id) => document.getElementById(id);
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
      const ph = (id) => getComputedStyle(ta(id), '::placeholder');
      return {
        viewport: { w: innerWidth, h: innerHeight },
        docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        modalOverflowX: modal.scrollWidth - modal.clientWidth,
        bodyOverflowX: body.scrollWidth - body.clientWidth,
        gridCols: getComputedStyle(grid).gridTemplateColumns,
        project: document.getElementById('safetyProjectName').textContent.trim(),
        projectIsReadonly: !document.querySelector('#safetyProjectName input, #safetyProjectName textarea, #safetyProjectName select'),
        dateValue: document.getElementById('safetyLogDate').value,
        dateReadonly: document.getElementById('safetyLogDate').readOnly,
        author: document.getElementById('safetyAuthor').textContent.trim(),
        reviewer: document.getElementById('safetyReviewer').textContent.trim(),
        weather: { value: ta('safetyWeather').value, ph: ta('safetyWeather').placeholder, color: ph('safetyWeather').color, opacity: ph('safetyWeather').opacity },
        wind: { value: ta('safetyWind').value, ph: ta('safetyWind').placeholder, color: ph('safetyWind').color },
        temp: { value: ta('safetyTemp').value, ph: ta('safetyTemp').placeholder, color: ph('safetyTemp').color },
        textareas: ['safetyContent', 'safetyInspection', 'safetySafety', 'safetyMajorIssue'].map((id) => ({
          id, w: Math.round(ta(id).getBoundingClientRect().width), h: Math.round(ta(id).getBoundingClientRect().height),
          value: ta(id).value, ph: ta(id).placeholder,
          scrollH: ta(id).scrollHeight, clientH: ta(id).clientHeight,
        })),
        formWidth: Math.round(document.querySelector('#createModal .form-main').getBoundingClientRect().width),
        footer: rect(document.querySelector('#createModal .fd-footer')),
        modalBody: rect(body), modal: rect(modal),
        footerButtons: [...document.querySelectorAll('#createModal .fd-footer button')].map((b) => ({ t: b.textContent.trim(), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) })),
      };
    })()`);
    await s.screenshot('01-桌面-新建弹窗顶部.png');

    const today = await s.eval(`(() => { const d = new Date(); const p = (n) => n < 10 ? '0' + n : '' + n; return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()); })()`);
    check('工程名称由系统自动带入且只读', !!desktop.project && desktop.projectIsReadonly, { project: desktop.project });
    check('日期自动生成为当天且只读', desktop.dateValue === today && desktop.dateReadonly, { dateValue: desktop.dateValue, today });
    check('填写人按当前账号带入', desktop.author.length > 0 && desktop.author !== '—', { author: desktop.author });
    check('气象三项 placeholder 完整、灰色、值为空', ['weather', 'wind', 'temp'].every((k) => desktop[k].value === '' && desktop[k].color === 'rgb(156, 163, 175)'), {
      weather: desktop.weather, wind: desktop.wind, temp: desktop.temp,
    });
    const txt = desktop.textareas;
    check('四项正文占位提示完整（含巡视五条）', txt[1].ph.includes('①') && txt[1].ph.includes('⑤') && txt[2].ph.includes('重大危险源') && txt[3].ph.includes('停工'), {
      inspectionLines: txt[1].ph.split('\n').length, safety: txt[2].ph.slice(0, 40), major: txt[3].ph.slice(0, 30),
    });
    check('四项正文等宽全宽展示', txt.every((t) => Math.abs(t.w - txt[0].w) <= 1) && txt[0].w > desktop.formWidth * 0.98, {
      widths: txt.map((t) => t.w), form: desktop.formWidth,
    });
    check('正文高度合理且提示未被截断（巡视最高）', txt[0].h >= 128 && txt[1].h > txt[0].h && txt[1].scrollH <= txt[1].clientH + 2, {
      heights: txt.map((t) => t.h), inspectionScroll: [txt[1].scrollH, txt[1].clientH],
    });
    check('桌面基础信息两列', desktop.gridCols.split(' ').length === 2, { gridCols: desktop.gridCols });
    check('桌面无横向溢出', desktop.docOverflowX <= 0 && desktop.bodyOverflowX <= 0, { doc: desktop.docOverflowX, body: desktop.bodyOverflowX });
    check('底部三个操作按钮可见可点', desktop.footerButtons.length === 3 && desktop.footerButtons.every((b) => b.h >= 36 && b.w > 0), desktop.footerButtons);

    // 滚动到正文与底部，检查底栏常驻
    await s.scrollModalBody('middle');
    await s.screenshot('02-桌面-新建弹窗正文.png');
    const mid = await s.eval(`(() => {
      const f = document.querySelector('#createModal .fd-footer').getBoundingClientRect();
      const b = document.querySelector('#createModal .modal-body');
      return { footerTop: Math.round(f.top), footerBottom: Math.round(f.bottom), vh: innerHeight, bodyScroll: b.scrollTop, bodyScrollH: b.scrollHeight };
    })()`);
    check('正文滚动时底部操作栏常驻视口', mid.footerBottom <= mid.vh + 1 && mid.footerTop > 0 && mid.bodyScroll > 0, mid);
    await s.scrollModalBody('bottom');
    await s.screenshot('03-桌面-新建弹窗附件与底栏.png');

    // ---------- 窄屏 768 / 手机 375 / 320 ----------
    const measureAt = async (w, h, mobile) => {
      await s.metrics(w, h, mobile);
      await sleep(350);
      return s.eval(`(() => {
        const modal = document.querySelector('#createModal .modal');
        const body = document.querySelector('#createModal .modal-body');
        const grid = document.getElementById('safetyProjectName').closest('.fd-grid');
        const footer = document.querySelector('#createModal .fd-footer');
        const btns = [...footer.querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) }; });
        const tas = ['safetyContent','safetyInspection','safetySafety','safetyMajorIssue'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { id, w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; });
        return {
          vw: innerWidth, vh: innerHeight,
          docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          bodyOverflowX: body.scrollWidth - body.clientWidth,
          modalOverflowX: modal.scrollWidth - modal.clientWidth,
          gridCols: getComputedStyle(grid).gridTemplateColumns,
          modalW: Math.round(modal.getBoundingClientRect().width),
          bodyRect: { top: Math.round(body.getBoundingClientRect().top), bottom: Math.round(body.getBoundingClientRect().bottom) },
          btns, tas,
          footerSticky: getComputedStyle(footer).position,
        };
      })()`);
    };
    const m768 = await measureAt(768, 800, false);
    check('768 宽基础信息单列且无横向溢出', m768.gridCols.split(' ').length === 1 && m768.docOverflowX <= 0 && m768.bodyOverflowX <= 0, m768);

    const m375 = await measureAt(375, 667, true);
    await s.scrollModalBody('top');
    await s.screenshot('04-手机375-新建弹窗顶部.png');
    check('375 宽单列、正文不溢出、无横向滚动', m375.gridCols.split(' ').length === 1 && m375.docOverflowX <= 0 && m375.bodyOverflowX <= 0 && m375.tas.every((t) => t.right <= 375), m375);
    check('375 宽底部按钮均在视口内且高度可点', m375.btns.length === 3 && m375.btns.every((b) => b.right <= 375 && b.left >= 0 && b.h >= 36), m375.btns);
    await s.scrollModalBody('bottom');
    await s.screenshot('05-手机375-弹窗底部与附件.png');
    const m375b = await measureAt(375, 667, true);
    check('375 宽滚动到底底栏仍可见', m375b.btns.every((b) => b.bottom <= 667 && b.bottom > 0), m375b.btns);

    const m320 = await measureAt(320, 568, true);
    const m320b = await s.eval(`(() => {
      const vw = document.documentElement.clientWidth;
      const outside = [];
      document.querySelectorAll('.toolbar .btn, .toolbar button').forEach((b) => { const r = b.getBoundingClientRect(); if (r.right > vw + 0.5) outside.push({ t: b.textContent.trim(), right: Math.round(r.right) }); });
      return { vw, toolbarOverflowButtons: outside };
    })()`);
    check('320 宽无横向溢出', m320.docOverflowX <= 0 && m320.bodyOverflowX <= 0 && m320.btns.every((b) => b.right <= 320), { ...m320, pageLevel: m320b });

    // ---------- 恢复桌面并填写 ----------
    await s.metrics(1440, 900, false);
    await sleep(300);
    await s.scrollModalBody('top');
    await s.setValue('safetyWeather', '晴，午后短时多云');
    await s.setValue('safetyWind', '东北风 3 级');
    await s.setValue('safetyTemp', '18℃~26℃');
    await s.setValue('safetyContent', '主体结构 5 层顶板钢筋绑扎完成 80%，模板支设同步进行；地下室外墙防水收口完成。');
    await s.setValue('safetyInspection', '①专职安全员在岗履职，交接班记录齐全；\n②特种作业人员 6 人证件均在有效期内；\n③塔吊运行正常，进出场登记及环保记录完整；\n④临时用电二级箱漏电保护试跳正常；\n⑤外脚手架验收记录齐全，现场检查连墙件无缺失。');
    await s.setValue('safetySafety', '当日无重大危险源。发现 5 层临边防护栏杆一处缺失，已当场整改并复查合格；整体安全生产状态可控。');
    await s.setValue('safetyMajorIssue', '下午区住建局安全监督站到现场检查，未下发整改通知单。');

    // ---------- 照片上传（真实文件） ----------
    const photoPath = path.join(OUT, '01-桌面-新建弹窗顶部.png');
    const beforePhoto = await s.eval(`document.querySelectorAll('#createPhotoGrid .photo-item').length`);
    await s.setFiles('createPhotoInput', [photoPath]);
    await s.waitFor(`!!document.querySelector('#createPhotoGrid .photo-item[data-url]:not([data-url=""])')`, '照片上传完成', 20000);
    const photoState = await s.eval(`(() => {
      const it = document.querySelector('#createPhotoGrid .photo-item');
      return { count: document.querySelectorAll('#createPhotoGrid .photo-item').length, url: it && it.getAttribute('data-url'), hasImg: !!(it && it.querySelector('img')), removeBtn: !!(it && it.querySelector('.remove-photo')) };
    })()`);
    check('照片选择后真实上传并生成缩略图与删除按钮', photoState.count === beforePhoto + 1 && /\/api\/uploads\//.test(photoState.url || '') && photoState.hasImg && photoState.removeBtn, photoState);
    await s.screenshot('06-桌面-照片上传结果.png');

    // ---------- 附件上传 + 目录绑定 ----------
    const pdfPath = path.join(OUT, '验收测试-监理工程师通知单.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    await s.setFiles('createFileInput', [pdfPath]);
    await s.waitFor(`document.getElementById('dirTreeModal').classList.contains('show')`, '附件上传后弹出目录选择', 20000);
    await s.waitFor(`document.getElementById('dirTreeContainer').querySelectorAll('.leaf-node').length > 0`, '项目目录树加载完成', 20000);
    const dirState = await s.eval(`(() => {
      const c = document.getElementById('dirTreeContainer');
      return {
        placeholder: (c.textContent || '').trim().slice(0, 80),
        nodes: c.querySelectorAll('.dir-tree-node').length,
        leaves: c.querySelectorAll('.leaf-node').length,
        checkboxes: c.querySelectorAll('input[type="checkbox"]').length,
        disabledParents: c.querySelectorAll('.parent-node input[type="checkbox"][disabled]').length,
      };
    })()`);
    await s.screenshot('07-桌面-目录选择弹窗.png');
    check('目录选择弹窗可打开（入口存在）', true, dirState);
    check('目录树存在可选末级目录', dirState.leaves > 0 && dirState.checkboxes > dirState.leaves, dirState);
    check('非末级目录不可选（父节点置灰）', dirState.disabledParents > 0, { disabledParents: dirState.disabledParents });
    const dirConfirm = await s.eval(`(async () => {
      const btn = [...document.querySelectorAll('#dirTreeModal .modal-footer button')].find(b => b.textContent.includes('确认选择'));
      btn.click();
      await new Promise(r => setTimeout(r, 400));
      const t = document.querySelector('.app-toast');
      return { toast: t ? t.textContent.trim() : '', modalStillOpen: document.getElementById('dirTreeModal').classList.contains('show') };
    })()`);
    check('未选目录时阻止绑定并提示', /请至少选择一个存储目录/.test(dirConfirm.toast) && dirConfirm.modalStillOpen, dirConfirm);
    const dirPick = await s.eval(`(() => {
      const leaf = document.querySelector('#dirTreeContainer .leaf-node');
      leaf.click();
      const cb = leaf.querySelector('input[type="checkbox"]');
      return { path: leaf.getAttribute('data-path'), checked: !!(cb && cb.checked), count: document.getElementById('dirSelectedCount').textContent.trim() };
    })()`);
    check('末级目录可勾选并同步到已选列表', dirPick.checked && dirPick.count === '1 项', dirPick);
    await s.screenshot('07b-桌面-目录已勾选.png');
    const dirBind = await s.eval(`(async () => {
      const btn = [...document.querySelectorAll('#dirTreeModal .modal-footer button')].find(b => b.textContent.includes('确认选择'));
      btn.click();
      await new Promise(r => setTimeout(r, 500));
      const it = document.querySelector('#createAttachmentList .attachment-item');
      return {
        modalOpen: document.getElementById('dirTreeModal').classList.contains('show'),
        dirLabel: it && it.querySelector('.dir-label') ? it.querySelector('.dir-label').textContent.trim() : '',
        tags: it ? [...it.querySelectorAll('.att-dir-tag')].map(t => t.getAttribute('data-path')) : [],
      };
    })()`);
    check('附件存储目录已成功绑定', !dirBind.modalOpen && dirBind.dirLabel !== '未选择' && dirBind.tags.length === 1, dirBind);
    await s.waitFor(`!!document.querySelector('#createAttachmentList .attachment-item[data-url]:not([data-url=""])')`, '附件上传完成', 20000);
    const attState = await s.eval(`(() => {
      const it = document.querySelector('#createAttachmentList .attachment-item');
      return { count: document.querySelectorAll('#createAttachmentList .attachment-item').length, url: it && it.getAttribute('data-url'), name: it && it.getAttribute('data-fname'), badge: it && it.querySelector('.pending-badge') ? it.querySelector('.pending-badge').textContent.trim() : '', dirLabel: it && it.querySelector('.dir-label') ? it.querySelector('.dir-label').textContent.trim() : '' };
    })()`);
    // 绑定目录后“待选目录”徽标按设计移除，因此徽标为空但目录已选属于正常结果
    check('PDF 附件真实上传并显示文件名/状态', attState.count === 1 && /\/api\/uploads\//.test(attState.url || '') && (attState.badge === '已上传' || attState.dirLabel !== '未选择'), attState);
    check('附件存储目录已成功绑定并显示目录标签', attState.dirLabel !== '未选择' && attState.dirLabel.length > 0, { dirLabel: attState.dirLabel });
    await s.scrollModalBody('bottom');
    await s.screenshot('08-桌面-附件上传结果.png');

    // ---------- 保存草稿 ----------
    const rowsBefore = await s.eval(`document.querySelectorAll('tbody tr[data-status]').length`);
    await s.clickByText('#createModal .fd-footer button', '保存草稿');
    await s.waitFor(`!document.getElementById('createModal').classList.contains('show')`, '保存草稿后关闭弹窗', 20000);
    await s.waitFor(`document.querySelectorAll('tbody tr[data-status]').length === ${rowsBefore + 1}`, '列表出现新草稿', 20000);
    const draftRow = await s.eval(`(() => {
      const tr = document.querySelector('tbody tr[data-status]');
      return { status: tr.getAttribute('data-status'), text: tr.textContent.replace(/\\s+/g, ' ').trim() };
    })()`);
    check('保存草稿落库并显示草稿状态', draftRow.status === 'draft' && /草稿/.test(draftRow.text), draftRow);
    await s.screenshot('09-桌面-列表草稿.png');

    // ---------- 编辑回显 ----------
    await s.clickByText('tbody .action-cell button', '编辑');
    await s.waitFor(`document.getElementById('createModal').classList.contains('show')`, '编辑弹窗打开');
    const editState = await s.eval(`(() => {
      const v = (id) => document.getElementById(id).value;
      return {
        project: document.getElementById('safetyProjectName').textContent.trim(),
        date: v('safetyLogDate'),
        author: document.getElementById('safetyAuthor').textContent.trim(),
        weather: v('safetyWeather'), wind: v('safetyWind'), temp: v('safetyTemp'),
        content: v('safetyContent'), inspection: v('safetyInspection'), safety: v('safetySafety'), major: v('safetyMajorIssue'),
        photos: document.querySelectorAll('#createPhotoGrid .photo-item[data-url]').length,
        atts: [...document.querySelectorAll('#createAttachmentList .attachment-item')].map(i => ({ name: i.getAttribute('data-fname'), url: i.getAttribute('data-url') })),
        dirTags: [...document.querySelectorAll('#createAttachmentList .att-dir-tag')].map(t => t.getAttribute('data-path')),
      };
    })()`);
    check('编辑草稿回显全部原字段', editState.weather === '晴，午后短时多云' && editState.wind === '东北风 3 级' && editState.temp === '18℃~26℃'
      && editState.content.includes('5 层顶板') && editState.inspection.includes('⑤') && editState.safety.includes('重大危险源') && editState.major.includes('住建局'), editState);
    check('编辑保留原工程、日期、填写人、照片与附件', editState.project.includes('安全日志视觉验收项目') && editState.date === today && editState.author.length > 0 && editState.photos === 1 && editState.atts.length === 1, {
      project: editState.project, date: editState.date, author: editState.author, photos: editState.photos, atts: editState.atts,
    });
    check('编辑回显保留附件存储目录', editState.dirTags.length === 1, { dirTags: editState.dirTags });
    await s.scrollModalBody('top');
    await s.screenshot('10-桌面-编辑回显.png');
    await s.scrollModalBody('bottom');
    await s.screenshot('11-桌面-编辑附件回显.png');

    // ---------- 提交 ----------
    await s.clickByText('#createModal .fd-footer button', '提交');
    await s.waitFor(`!document.getElementById('createModal').classList.contains('show')`, '提交后关闭弹窗', 20000);
    await s.waitFor(`(document.querySelector('tbody tr[data-status]') || {}).dataset?.status === 'pending'`, '列表变为待审核', 20000);
    const submitted = await s.eval(`(() => { const tr = document.querySelector('tbody tr[data-status]'); return { status: tr.getAttribute('data-status'), text: tr.textContent.replace(/\\s+/g, ' ').trim(), actions: [...tr.querySelectorAll('.action-cell button')].map(b => b.textContent.trim()) }; })()`);
    check('提交按钮可用且状态变为待审核', submitted.status === 'pending' && /待审核/.test(submitted.text), submitted);
    await s.screenshot('12-桌面-已提交待审核.png');

    // ---------- Word 导出（单条 + 批量） ----------
    // 页面用 fetch+blob+a.download 触发下载，CDP 的 getResponseBody 会因 blob 消费返回空；
    // 因此以真实落盘的下载文件（ZIP/docx 魔数 PK）作为内容非空证据。
    const DL_DIR = path.join(OUT, 'downloads');
    fs.mkdirSync(DL_DIR, { recursive: true });
    const waitNewDownload = async (beforeGuids, timeout = 20000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const ev = downloads.find((d) => !beforeGuids.includes(d.guid));
        if (ev) {
          const f = path.join(DL_DIR, ev.guid);
          if (fs.existsSync(f)) {
            const b = fs.readFileSync(f);
            return { file: f, bytes: b.length, magic: b.slice(0, 2).toString('latin1'), suggested: ev.suggestedFilename };
          }
        }
        await sleep(200);
      }
      return null;
    };

    exportResponses.length = 0;
    const beforeSingle = downloads.map((d) => d.guid);
    await s.clickByText('tbody .action-cell button', '导出');
    const singleDl = await waitNewDownload(beforeSingle);
    const single = exportResponses[0];
    check('单条 Word 导出返回 docx 且内容非空', !!single && single.status === 200 && /officedocument\.wordprocessingml/.test(single.headers['Content-Type'] || single.headers['content-type'] || single.mimeType) && !!singleDl && singleDl.bytes > 1000 && singleDl.magic === 'PK', {
      status: single && single.status, headers: single && { ct: single.headers['Content-Type'] || single.headers['content-type'], cd: single.headers['Content-Disposition'] || single.headers['content-disposition'] }, file: singleDl,
    });

    exportResponses.length = 0;
    const beforeBatch = downloads.map((d) => d.guid);
    await s.clickByText('.toolbar button, .page-header button, button', '导出Word');
    const batchDl = await waitNewDownload(beforeBatch);
    const batch = exportResponses[0];
    check('列表批量 Word 导出返回 docx 且内容非空', !!batch && batch.status === 200 && !!batchDl && batchDl.bytes > 1000 && batchDl.magic === 'PK', {
      status: batch && batch.status, headers: batch && { ct: batch.headers['Content-Type'] || batch.headers['content-type'], cd: batch.headers['Content-Disposition'] || batch.headers['content-disposition'] }, file: batchDl,
    });
    await s.screenshot('13-桌面-Word导出提示.png');

    // ---------- 新建不残留 + 取消 ----------
    await s.clickByText('button', '新建安全日志');
    await s.waitFor(`document.getElementById('createModal').classList.contains('show')`, '再次新建');
    const cleanState = await s.eval(`(() => {
      const v = (id) => document.getElementById(id).value;
      return { weather: v('safetyWeather'), content: v('safetyContent'), inspection: v('safetyInspection'), safety: v('safetySafety'), major: v('safetyMajorIssue'),
        photos: document.querySelectorAll('#createPhotoGrid .photo-item').length, atts: document.querySelectorAll('#createAttachmentList .attachment-item').length,
        tabs: document.querySelectorAll('#createModal .version-tab').length, date: document.getElementById('safetyLogDate').value, project: document.getElementById('safetyProjectName').textContent.trim() };
    })()`);
    check('新建不残留上一份正文、附件与历史页签', !cleanState.weather && !cleanState.content && !cleanState.inspection && !cleanState.safety && !cleanState.major && cleanState.photos === 0 && cleanState.atts === 0 && cleanState.tabs === 0, cleanState);
    check('新建重新带入工程与当天日期', cleanState.project.includes('安全日志视觉验收项目') && cleanState.date === today, { project: cleanState.project, date: cleanState.date });
    await s.setValue('safetyWeather', '取消测试内容');
    await s.clickByText('#createModal .fd-footer button', '取消');
    await s.waitFor(`!document.getElementById('createModal').classList.contains('show')`, '取消关闭弹窗');
    const afterCancel = await s.eval(`({ rows: document.querySelectorAll('tbody tr[data-status]').length })`);
    check('取消按钮关闭弹窗且不新增记录', afterCancel.rows === rowsBefore + 1, afterCancel);

    // ---------- 最终保留新建弹窗（桌面） ----------
    await s.metrics(1440, 900, false);
    await s.clickByText('button', '新建安全日志');
    await s.waitFor(`document.getElementById('createModal').classList.contains('show')`, '最终新建弹窗');
    await s.screenshot('14-桌面-最终新建弹窗.png');

    const badConsole = consoleErrors.filter((e) => !/favicon/i.test(e));
    check('页面无业务控制台错误', badConsole.length === 0, badConsole.slice(0, 5));
  } catch (e) {
    check('验收脚本执行完成', false, { error: e.message });
  }

  fs.writeFileSync(path.join(OUT, '验收结果.json'), JSON.stringify({ results, consoleErrors, exportResponses: exportResponses.map((r) => ({ url: r.url, status: r.status })), downloads }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`TOTAL ${results.length} PASS ${results.length - failed} FAIL ${failed}`);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
