// 监理日记浏览器视觉/交互验收：CDP 驱动真实 Edge，截图、填表、上传、提交、导出均为真实行为。
// 依赖隔离环境：静态页 18081 -> 后端 18080（e2e H2 内存库），不接触业务库。
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 19222;
const BASE = 'http://localhost:18081';
const OUT = path.join(__dirname, '监理日记视觉验收');
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
  async evalHandle(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: false });
    if (r.exceptionDetails) throw new Error('Eval error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result;
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
    await this.clickAt(box.x, box.y);
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
  s.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push('EXCEPTION: ' + (msg.params.exceptionDetails.text || ''));
    if (msg.method === 'Page.downloadWillBegin') downloads.push(msg.params);
    if (msg.method === 'Page.javascriptDialogOpening') { s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { }); }
  });
  await Promise.all([s.send('Page.enable'), s.send('Runtime.enable'), s.send('Network.enable'), s.send('DOM.enable')]);
  await s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { });
  await s.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: DL_DIR, eventsEnabled: true });

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

    // ---------- 项目准备 ----------
    const setup = await s.eval(`(async () => {
      let page = await App.apiGetPage('/projects', { pageNum: 1, pageSize: 200 });
      if (!page.list || !page.list.length) {
        await App.apiFetch('/projects', { method: 'POST', body: { name: '监理日记视觉验收项目（长工程名称响应式检查）', code: 'DIARY-VISUAL-01', buildUnit: '视觉验收测试建设单位', status: 'active' } });
        page = await App.apiGetPage('/projects', { pageNum: 1, pageSize: 200 });
      }
      const diaries = await App.apiGetPage('/supervision-diaries', { pageNum: 1, pageSize: 200 });
      return { projects: page.total, diaries: diaries.total };
    })()`);
    check('隔离环境准备：项目与监理日记接口可访问', setup.projects >= 1, setup);

    // ---------- 页面加载 ----------
    await s.send('Page.navigate', { url: BASE + '/supervision-diary.html' });
    await s.waitFor(`document.readyState === 'complete' && !!document.getElementById('fwNew')`, '监理日记页加载', 20000);
    const overview = await s.eval(`(() => ({ vw: document.documentElement.clientWidth, docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth, newText: document.getElementById('fwNew').textContent.trim() }))()`);
    check('列表页加载且无横向溢出', overview.docOverflowX <= 0 && overview.newText === '新建监理日记', overview);

    // ---------- 桌面新建 ----------
    await s.eval(`(() => { const sel = document.getElementById('fwProject'); if (sel.options.length > 1) { sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change')); } return true; })()`);
    await sleep(400);
    await s.clickByText('button', '新建监理日记');
    await s.waitFor(`!document.getElementById('fwEditor').hidden`, '新建编辑器打开');
    await sleep(600);

    const today = await s.eval(`(() => { const d = new Date(); const p = (n) => n < 10 ? '0' + n : '' + n; return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()); })()`);
    const desktop = await s.eval(`(() => {
      const editor = document.getElementById('fwEditor');
      const modal = editor.querySelector('.fd-modal');
      const grid = document.getElementById('fwForm');
      const field = (f) => document.getElementById('fwF-' + f);
      const rect = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
      const mains = ['construction','management','inspection','otherWork','otherMatters','morningMeeting','newIssues','materialInspection','drawingReview'];
      const weatherLabel = [...grid.querySelectorAll('.fd-label')].find(l => l.textContent.indexOf('天气') === 0);
      return {
        vw: innerWidth, vh: innerHeight,
        docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyOverflowX: editor.querySelector('.fd-body').scrollWidth - editor.querySelector('.fd-body').clientWidth,
        modal: rect(modal), gridCols: getComputedStyle(grid).gridTemplateColumns,
        title: document.getElementById('fwTitle').textContent.trim(),
        project: (grid.querySelector('.fd-field .fd-readonly') || {}).textContent.trim() || '',
        projectReadonly: !grid.querySelector('[data-field="projectId"]'),
        dateValue: field('diaryDate').value, dateReadonly: field('diaryDate').readOnly,
        readonlys: [...grid.querySelectorAll('.fd-readonly')].map(e => (e.textContent || '').trim()),
        weatherRequired: !!weatherLabel && weatherLabel.querySelector('.fd-req') !== null,
        weatherPh: getComputedStyle(field('weather'), '::placeholder').color,
        guide: (document.getElementById('fwGuide').textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
        sections: [...grid.querySelectorAll('.fd-section-heading')].map(e => e.textContent.trim()),
        mains: mains.map((f) => { const el = field(f); const r = el.getBoundingClientRect(); return { f, w: Math.round(r.width), h: Math.round(r.height), ph: el.placeholder, scrollH: el.scrollHeight, clientH: el.clientHeight }; }),
        footerButtons: [...editor.querySelectorAll('.fd-footer button')].filter(b => !b.hidden).map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) }; }),
        footer: rect(editor.querySelector('.fd-footer')),
      };
    })()`);
    await s.screenshot('01-桌面-新建顶部.png');

    check('新建标题与工程名称/日期只读带入', desktop.title === '新建监理日记' && desktop.projectReadonly && desktop.project.length > 0 && desktop.dateValue === today && desktop.dateReadonly, {
      title: desktop.title, project: desktop.project, date: desktop.dateValue, today,
    });
    check('记录人/审核人按账号显示', desktop.readonlys.some((t) => t === 'admin') && desktop.readonlys.length >= 2, desktop.readonlys);
    check('天气标记为必填且 placeholder 灰色提示', desktop.weatherRequired && desktop.weatherPh === 'rgb(156, 163, 175)', { required: desktop.weatherRequired, color: desktop.weatherPh });
    check('填写指引显示 14 项规范', /监理日记填写指引 · 14 项规范/.test(desktop.guide), desktop.guide.slice(0, 90));
    check('分为“基础信息 / 当日工作记录”两段', desktop.sections.length === 2 && desktop.sections[0] === '基础信息' && desktop.sections[1] === '当日工作记录', desktop.sections);
    const mains = desktop.mains;
    check('九个正文栏目等宽全宽展示', mains.length === 9 && mains.every((m) => Math.abs(m.w - mains[0].w) <= 1) && mains[0].w >= desktop.modal.w - 90, { widths: mains.map((m) => m.w), modalW: desktop.modal.w });
    check('正文 placeholder 完整且未被截断', mains[0].ph.includes('具体部位') && mains[1].ph.includes('管理人员') && mains[2].ph.includes('巡视') && mains.every((m) => m.scrollH <= m.clientH + 2), {
      lengths: mains.map((m) => m.ph.length), scroll: mains.map((m) => [m.scrollH, m.clientH]),
    });
    check('底栏五个操作按钮可见可点', desktop.footerButtons.length === 5 && desktop.footerButtons.every((b) => b.w > 0 && b.h >= 32), desktop.footerButtons);
    check('桌面两列布局且无横向溢出', desktop.gridCols.split(' ').length === 2 && desktop.docOverflowX <= 0 && desktop.bodyOverflowX <= 0, { gridCols: desktop.gridCols, doc: desktop.docOverflowX, body: desktop.bodyOverflowX });

    await s.scrollBody('middle');
    await s.screenshot('02-桌面-新建中部.png');
    const mid = await s.eval(`(() => { const f = document.querySelector('#fwEditor .fd-footer').getBoundingClientRect(); const b = document.querySelector('#fwEditor .fd-body'); return { footerBottom: Math.round(f.bottom), vh: innerHeight, scrollTop: b.scrollTop }; })()`);
    check('正文滚动时底部操作栏常驻视口', mid.footerBottom <= mid.vh + 1 && mid.scrollTop > 0, mid);
    await s.scrollBody('bottom');
    await s.screenshot('03-桌面-新建底部与上传区.png');

    // ---------- 响应式 ----------
    const measure = async (w, h, mobile) => {
      await s.metrics(w, h, mobile);
      await sleep(400);
      return s.eval(`(() => {
        const vw = document.documentElement.clientWidth;
        const modal = document.querySelector('#fwEditor .fd-modal');
        const body = document.querySelector('#fwEditor .fd-body');
        const footer = document.querySelector('#fwEditor .fd-footer');
        const grid = document.getElementById('fwForm');
        const proj = document.getElementById('fwProject').getBoundingClientRect();
        return {
          vw, vh: innerHeight,
          docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          bodyOverflowX: body.scrollWidth - body.clientWidth,
          modalW: Math.round(modal.getBoundingClientRect().width),
          closeRight: Math.round(document.getElementById('fwClose').getBoundingClientRect().right),
          toolbarSelectRight: Math.round(proj.right),
          gridCols: getComputedStyle(grid).gridTemplateColumns,
          btns: [...footer.querySelectorAll('button')].filter(b => !b.hidden).map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim(), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), h: Math.round(r.height) }; }),
        };
      })()`);
    };
    const m768 = await measure(768, 800, false);
    check('768 单列且无横向溢出、底栏按钮全在视口内', m768.gridCols.split(' ').length === 1 && m768.docOverflowX <= 0 && m768.bodyOverflowX <= 0 && m768.btns.every((b) => b.right <= 768 && b.bottom <= 800), m768);

    const m375 = await measure(375, 667, true);
    await s.scrollBody('top');
    await s.screenshot('04-手机375-新建顶部.png');
    check('375 无横向溢出且弹窗不超屏', m375.docOverflowX <= 0 && m375.modalW <= 375 && m375.toolbarSelectRight <= 375 && m375.closeRight <= 375, m375);
    check('375 底栏按钮均在视口内可点', m375.btns.length === 5 && m375.btns.every((b) => b.right <= 375 && b.left >= 0 && b.h >= 32), m375.btns);

    const m320 = await measure(320, 568, true);
    await s.screenshot('05-手机320-新建顶部.png');
    check('320 无横向溢出且底栏按钮可点', m320.docOverflowX <= 0 && m320.bodyOverflowX <= 0 && m320.modalW <= 320 && m320.btns.every((b) => b.right <= 320 && b.left >= 0 && b.h >= 32), m320);

    // ---------- 填写 ----------
    await s.metrics(1440, 900, false);
    await sleep(300);
    await s.scrollBody('top');
    await s.setValue('fwF-weather', '多云转晴');
    await s.setValue('fwF-wind', '东南风 2 级');
    await s.setValue('fwF-temperature', '20℃~27℃');
    await s.setValue('fwF-construction', '主楼 7 层剪力墙钢筋绑扎完成 60%，模板支设同步进行。');
    await s.setValue('fwF-management', '施工单位项目经理、技术负责人、安全员均在岗，按专项方案组织施工。');
    await s.setValue('fwF-inspection', '上午巡视 7 层墙柱钢筋绑扎；下午旁站 6 层顶板混凝土浇筑，见证取样 2 组。');
    await s.setValue('fwF-otherWork', '参加建设单位组织的周例会，汇报本周监理工作进展。');
    await s.setValue('fwF-otherMatters', '下午片区短时停水，施工方自行蓄水保障，未影响关键工序。');
    await s.setValue('fwF-morningMeeting', '晨会安排：重点检查临边防护与混凝土浇筑振捣质量。');
    await s.setValue('fwF-newIssues', '7 层部分墙柱钢筋保护层垫块间距偏大，已要求整改。');
    await s.setValue('fwF-materialInspection', '钢筋原材进场 60 吨，见证取样送检 1 组，资料齐全。');
    await s.setValue('fwF-drawingReview', '核对 7 层结构图与建筑图预留洞口位置，未发现矛盾。');
    const filled = await s.eval(`(() => {
      const ids = ['weather','wind','temperature','construction','management','inspection','otherWork','otherMatters','morningMeeting','newIssues','materialInspection','drawingReview'];
      const vals = ids.map(f => document.getElementById('fwF-' + f).value);
      return { count: vals.filter(v => v && v.trim()).length, construction: vals[3], inspection: vals[5] };
    })()`);
    check('十二个栏目均可填写', filled.count === 12 && filled.construction.includes('7 层') && filled.inspection.includes('旁站'), filled);

    // ---------- 未上传照片时提交应被阻止 ----------
    await s.eval(`document.getElementById('fwSubmit').click()`);
    await s.waitFor(`!!document.querySelector('[data-act="ok"]')`, '提交确认弹窗出现', 10000);
    await s.eval(`document.querySelector('[data-act="ok"]').click()`);
    await s.waitFor(`/现场照片/.test(document.getElementById('fwError').textContent)`, '缺少照片的提交被拒绝', 20000);
    const blocked = await s.eval(`(() => ({ error: document.getElementById('fwError').textContent.trim(), editorOpen: !document.getElementById('fwEditor').hidden, state: document.getElementById('fwState').textContent.replace(/\\s+/g, ' ').trim() }))()`);
    // 输入后 #fwState 会被本机保存提示接管（仅本机保存，尚未同步到服务器），因此以“未进入待审核”为判据
    check('未上传现场照片时提交被拒绝且保留编辑', /至少上传一张现场照片/.test(blocked.error) && blocked.editorOpen && !/待审核/.test(blocked.state), blocked);
    await s.screenshot('06-桌面-缺少照片被拒绝.png');

    // ---------- 上传现场照片 + 附件 ----------
    const photoPath = path.join(OUT, '01-桌面-新建顶部.png');
    await s.setFiles('fwUpload', [photoPath]);
    await s.waitFor(`document.querySelectorAll('#fwMedia .fd-photo-item').length === 1 && !!document.querySelector('#fwMedia .fd-photo-item img')`, '现场照片上传完成', 25000);
    const photoState = await s.eval(`(() => {
      const item = document.querySelector('#fwMedia .fd-photo-item');
      return { count: document.querySelectorAll('#fwMedia .fd-photo-item').length, hasImg: !!item.querySelector('img'), desc: !!item.querySelector('input'), state: document.getElementById('fwUploadState').textContent.trim(), guide: document.getElementById('fwGuide').textContent.replace(/\\s+/g, ' ').trim() };
    })()`);
    check('现场照片真实上传并生成缩略图/部位说明', photoState.count === 1 && photoState.hasImg && photoState.desc, photoState);

    const pdfPath = path.join(OUT, '验收测试-监理日记附件.pdf');
    fs.writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    await s.setFiles('fwUpload', [pdfPath]);
    await s.waitFor(`document.querySelectorAll('#fwMedia .fd-file-row').length === 1`, '附件上传完成', 25000);
    const attState = await s.eval(`(() => ({ name: (document.querySelector('#fwMedia .fd-file-row .fd-file-name') || {}).textContent, rows: document.querySelectorAll('#fwMedia .fd-file-row').length, photos: document.querySelectorAll('#fwMedia .fd-photo-item').length, guide: document.getElementById('fwGuide').textContent.replace(/\\s+/g, ' ').trim() }))()`);
    check('附件上传成功且不覆盖现场照片', attState.rows === 1 && attState.photos === 1 && /照片 1 张/.test(attState.guide) && /附件 1 个/.test(attState.guide), { name: attState.name, photos: attState.photos, guide: attState.guide.slice(-40) });
    await s.scrollBody('bottom');
    await s.screenshot('07-桌面-照片与附件.png');

    // ---------- 保存草稿 ----------
    const rowsBefore = await s.eval(`document.querySelectorAll('#fwRows tr[data-app-placeholder]').length ? 0 : document.querySelectorAll('#fwRows tr').length`);
    await s.clickByText('#fwEditor .fd-footer button', '保存草稿');
    await s.waitFor(`/监理日记 · /.test(document.getElementById('fwTitle').textContent)`, '草稿保存并生成编号', 25000);
    const draftState = await s.eval(`(() => ({ title: document.getElementById('fwTitle').textContent.trim(), chip: (document.querySelector('#fwState .fw-chip') || {}).textContent || '' }))()`);
    const code = (draftState.title.split('·')[1] || '').trim();
    check('保存草稿成功并生成编号、状态为草稿', /^[A-Za-z0-9-]{6,}$/.test(code) && draftState.chip === '草稿', { code, chip: draftState.chip });
    await s.screenshot('08-桌面-保存草稿后.png');

    await s.eval(`document.getElementById('fwClose').click()`);
    await s.waitFor(`document.getElementById('fwEditor').hidden`, '关闭编辑器');
    await s.waitFor(`document.querySelectorAll('#fwRows tr[data-app-placeholder]').length ? false : document.querySelectorAll('#fwRows tr').length === ${rowsBefore + 1}`, '列表新增一条记录', 20000);
    const draftRow = await s.eval(`(() => { const tr = [...document.querySelectorAll('#fwRows tr')].find(r => r.textContent.includes(${JSON.stringify(code)})); return tr ? tr.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
    check('列表出现新草稿且状态/日期正确', !!draftRow && /草稿/.test(draftRow) && draftRow.includes(today), draftRow);
    await s.screenshot('09-桌面-列表草稿.png');

    // ---------- 编辑回显 ----------
    await s.eval(`(() => { const tr = [...document.querySelectorAll('#fwRows tr')].find(r => r.textContent.includes(${JSON.stringify(code)})); tr.querySelector('button[data-id]').click(); return true; })()`);
    await s.waitFor(`!document.getElementById('fwEditor').hidden && document.getElementById('fwTitle').textContent.includes(${JSON.stringify(code)})`, '编辑弹窗打开', 20000);
    await sleep(600);
    const editState = await s.eval(`(() => {
      const v = (f) => document.getElementById('fwF-' + f).value;
      return {
        date: v('diaryDate'), weather: v('weather'), wind: v('wind'), temp: v('temperature'),
        construction: v('construction'), management: v('management'), inspection: v('inspection'), otherWork: v('otherWork'),
        otherMatters: v('otherMatters'), morningMeeting: v('morningMeeting'), newIssues: v('newIssues'),
        material: v('materialInspection'), drawing: v('drawingReview'),
        photos: document.querySelectorAll('#fwMedia .fd-photo-item').length,
        files: [...document.querySelectorAll('#fwMedia .fd-file-row .fd-file-name')].map(e => e.textContent.trim()),
        editable: !document.getElementById('fwSave').hidden,
      };
    })()`);
    check('编辑回显全部十二个栏目', editState.weather === '多云转晴' && editState.wind === '东南风 2 级' && editState.temp === '20℃~27℃'
      && editState.construction.includes('7 层') && editState.management.includes('均在岗') && editState.inspection.includes('旁站')
      && editState.otherWork.includes('周例会') && editState.otherMatters.includes('停水') && editState.morningMeeting.includes('晨会')
      && editState.newIssues.includes('保护层') && editState.material.includes('见证取样') && editState.drawing.includes('预留洞口'), editState);
    check('编辑回显保留照片与附件且可继续编辑', editState.photos === 1 && editState.files.length === 1 && editState.date === today && editState.editable, { photos: editState.photos, files: editState.files, editable: editState.editable });
    await s.scrollBody('top');
    await s.screenshot('10-桌面-编辑回显.png');

    // ---------- 提交 ----------
    await s.eval(`document.getElementById('fwSubmit').click()`);
    await s.waitFor(`!!document.querySelector('[data-act="ok"]')`, '提交确认弹窗出现', 10000);
    await s.eval(`document.querySelector('[data-act="ok"]').click()`);
    await s.waitFor(`(document.querySelector('#fwState .fw-chip') || {}).textContent === '待审核'`, '提交后状态为待审核', 25000);
    const submitted = await s.eval(`(() => ({ chip: document.querySelector('#fwState .fw-chip').textContent, saveHidden: document.getElementById('fwSave').hidden }))()`);
    check('补齐照片与正文后提交成功并锁定', submitted.chip === '待审核' && submitted.saveHidden, submitted);
    await s.screenshot('11-桌面-已提交待审核.png');
    await s.eval(`document.getElementById('fwClose').click()`);
    await s.waitFor(`document.getElementById('fwEditor').hidden`, '提交后关闭');
    const submittedRow = await s.eval(`(() => { const tr = [...document.querySelectorAll('#fwRows tr')].find(r => r.textContent.includes(${JSON.stringify(code)})); return tr ? tr.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
    check('列表状态同步为待审核', /待审核/.test(submittedRow), submittedRow);

    // ---------- CSV 导出 ----------
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
    check('导出筛选结果 CSV 真实下载且内容正确', !!csvFile && /监理日记-\d{4}-\d{2}-\d{2}\.csv/.test(csvFile.suggested || '') && csvText.includes('施工部位及形象进度') && csvText.includes(code) && csvText.includes(today), {
      file: csvFile, head: csvText.slice(0, 100),
    });
    await s.screenshot('12-桌面-CSV导出.png');

    // ---------- 再次新建不残留 ----------
    await s.eval(`document.getElementById('fwNew').click()`);
    await s.waitFor(`!document.getElementById('fwEditor').hidden`, '再次新建');
    const fresh = await s.eval(`(() => ({ title: document.getElementById('fwTitle').textContent.trim(), weather: document.getElementById('fwF-weather').value, construction: document.getElementById('fwF-construction').value, photos: document.querySelectorAll('#fwMedia .fd-photo-item').length, date: document.getElementById('fwF-diaryDate').value }))()`);
    check('再次新建不残留上一份正文/照片且日期当天', fresh.weather === '' && fresh.construction === '' && fresh.photos === 0 && fresh.date === today, fresh);

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
