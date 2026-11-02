// 旁站起止时间/日期确认式选择面板验收：独立 e2e 实例（18130/18131）+ 独立无头 Edge（19232）
// 重点验证：旁站时间保留分钟（5 分钟一档）且写回 HH:mm:00；选择过程中不落库，只有“确定”才写值。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const BASE = 'http://127.0.0.1:18131', CDP_PORT = 19232;
const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const results = [], sleep = ms => new Promise(r => setTimeout(r, ms));
// 自行以 UTF-8 落盘运行日志，避免用 PowerShell 重定向时中文变成乱码
const logLines = [];
for (const level of ['log', 'error']) {
  const raw = console[level].bind(console);
  console[level] = (...args) => { logLines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); raw(...args); };
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
  async navigate(page) { await this.send('Page.navigate', { url: BASE + '/' + page }); await this.wait(`location.pathname.endsWith(${JSON.stringify(page.split('?')[0])}) && document.readyState==='complete'`, page); }
  async point(selector) {
    return this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}); if(!el||el.hidden||el.disabled) throw Error('控件不可点: '+${JSON.stringify(selector)}); el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  }
  async click(selector) { const p = await this.point(selector); await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p }); }
  async clickAt(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x, y }); }
  async key(key, code) { await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code }); await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code }); }
  async select(selector, value) { await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async fill(selector, value) { await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
  async shot(name) { await this.send('Page.bringToFront'); await sleep(200); const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); }
  async width(width) { await this.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(200); assert.equal(await this.eval('innerWidth'), width); }
}
let s, token, projectId, recordId, today;
async function api(url, method = 'GET', body, headers = {}) {
  const r = await fetch(BASE + '/api' + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); const j = text ? JSON.parse(text) : {};
  if (!r.ok || (j.code !== undefined && j.code !== 200)) throw Object.assign(new Error(j.message || r.status), { status: r.status });
  return j.data;
}
async function check(name, fn) { const detail = await fn(); results.push({ name, pass: true, detail }); console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); }
const startInput = '#fwF-startTime', endInput = '#fwF-endTime';
const panelOpen = `!document.querySelector('.fd-dtp').hidden`;
const draftSnap = () => s.eval(`(()=>{const o={};for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);if(k.startsWith('field-pc:')&&k.includes(':draft:')){const v=JSON.parse(sessionStorage.getItem(k));o[k]={s:v.body&&v.body.startTime,e:v.body&&v.body.endTime,d:v.body&&v.body.inspectionDate};}}return JSON.stringify(o);})()`);
const inputValue = sel => s.eval(`document.querySelector(${JSON.stringify(sel)}).value`);
const panelState = () => s.eval(`(()=>({hidden:document.querySelector('.fd-dtp').hidden,error:document.querySelector('.fd-dtp [data-error]').textContent,preview:document.querySelector('.fd-dtp [data-preview]').textContent}))()`);
async function openPicker(sel) { await s.click(sel); await s.wait(panelOpen, '选择面板打开'); }
async function newSideline() {
  await s.navigate('sideline-inspection.html');
  await s.wait(`document.querySelector('#fwProject option[value="${projectId}"]')`, '项目下拉');
  await s.select('#fwProject', projectId);
  await s.click('#fwNew');
  await s.wait(`document.querySelectorAll('#fwForm [data-field]').length>0`, '编辑器表单');
}
async function fillRequired() {
  await s.fill('#fwF-location', '2 号楼 3 层顶板梁板钢筋');
  await s.fill('#fwF-process', '梁板钢筋绑扎隐蔽验收旁站');
  await s.fill('#fwF-result', '钢筋规格间距符合设计要求，同意进入下道工序');
  await s.fill('#fwF-docsText', 'GJ-2026-031\nYS-2026-079');
  await s.fill('#fwF-manageCount', '3');
  await s.fill('#fwF-workerCount', '12');
}
(async () => {
  const page = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  if (!page) throw new Error('没有独立验收页');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  s = new CDP(ws);
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Page.bringToFront'); await s.width(1440);
  try {
    // 独立环境准备：真实登录 + 创建本次验收专用项目
    await s.navigate('login.html');
    await s.eval(`(()=>{document.querySelector('#username').value='admin';document.querySelector('#password').value='123456';})()`);
    await s.click('#loginBtn');
    await s.wait(`!!window.App && !!App.getToken() && !location.pathname.endsWith('login.html')`, '真实登录');
    token = await s.eval('App.getToken()');
    const project = await api('/projects', 'POST', { name: '旁站时间验收项目', code: 'PZ' + Date.now().toString().slice(-6), buildUnit: '验收建设单位', status: 'active' });
    projectId = project.id;
    await check('独立环境真实登录并建验收项目', async () => { assert.equal(await s.eval('location.origin'), BASE); return { projectId }; });

    await newSideline();
    today = await inputValue('#fwF-inspectionDate');
    await check('旁站时间改为只读“分钟档”选择器，日期同日改用面板', async () => {
      const r = await s.eval(`(()=>{const pick=id=>{const el=document.getElementById(id);const label=document.querySelector('label[for="'+id+'"]');return {tag:el.tagName,type:el.type,readonly:el.readOnly,picker:el.dataset.picker,placeholder:el.placeholder,label:label&&label.textContent.replace(/\\s*\\*$/,'')}};return {start:pick('fwF-startTime'),end:pick('fwF-endTime'),date:pick('fwF-inspectionDate'),api:typeof window.FdDateTimePicker};})()`);
      assert.equal(r.api, 'object');
      assert.deepEqual([r.start.tag, r.start.type, r.start.readonly, r.start.picker], ['INPUT', 'text', true, 'minute']);
      assert.deepEqual([r.end.tag, r.end.type, r.end.readonly, r.end.picker], ['INPUT', 'text', true, 'minute']);
      assert.deepEqual([r.date.tag, r.date.readonly, r.date.picker], ['INPUT', true, 'date']);
      assert.ok(r.start.label.startsWith('开始时间'), r.start.label);
      assert.ok(r.end.label.startsWith('结束时间'), r.end.label);
      assert.equal(r.start.placeholder, '请选择旁站开始时间');
      assert.equal(r.end.placeholder, '请选择旁站结束时间');
      return { start: r.start.label, end: r.end.label };
    });

    await openPicker(startInput);
    await check('面板含确定/取消、24 个整点与 12 个分钟档', async () => {
      const r = await s.eval(`(()=>({ok:document.querySelector('.fd-dtp [data-ok]').textContent,cancel:document.querySelector('.fd-dtp [data-cancel]').textContent,hours:document.querySelectorAll('.fd-dtp [data-hour]').length,minutes:[...document.querySelectorAll('.fd-dtp [data-minute]')].map(b=>b.textContent).join(','),minuteHidden:document.querySelector('.fd-dtp [data-minutes]').hidden}))()`);
      assert.equal(r.ok, '确定'); assert.equal(r.cancel, '取消'); assert.equal(r.hours, 24);
      assert.equal(r.minutes, '00,05,10,15,20,25,30,35,40,45,50,55');
      assert.equal(r.minuteHidden, false);
      // 空值时默认到整点（分钟 00），不会出现 26 分这类非档位默认值
      const preview = await s.eval(`document.querySelector('.fd-dtp [data-preview]').textContent`);
      assert.ok(preview.endsWith(':00:00'), preview);
      // 日常巡检是整点模式，分钟区必须隐藏，两种模式互不污染
      return { minutes: r.minutes, preview };
    });
    await s.shot('01-旁站时间面板');

    // 核心：选了整点+分钟但未点“确定”，输入框与本机草稿都不得变化
    const beforePick = await draftSnap();
    await s.click('.fd-dtp [data-hour="8"]');
    await s.click('.fd-dtp [data-minute="30"]');
    await check('选择 08:30 未确认：输入框与草稿均不落库', async () => {
      const r = await panelState();
      assert.equal(r.preview, today + ' 08:30:00', r.preview);
      assert.equal(await inputValue(startInput), '');
      assert.equal(await draftSnap(), beforePick);
      return { preview: r.preview };
    });
    await s.shot('02-未点确定仅面板预览');

    await s.clickAt(5, 5);
    await s.wait(`document.querySelector('.fd-dtp').hidden`, '点遮罩关闭');
    await check('点遮罩关闭不写入', async () => {
      assert.equal(await inputValue(startInput), '');
      assert.equal(await draftSnap(), beforePick);
    });

    await openPicker(startInput); await s.click('.fd-dtp [data-hour="8"]'); await s.click('.fd-dtp [data-cancel]');
    await check('取消不写入', async () => {
      assert.equal(await s.eval(`document.querySelector('.fd-dtp').hidden`), true);
      assert.equal(await inputValue(startInput), '');
      assert.equal(await draftSnap(), beforePick);
    });

    await openPicker(startInput); await s.click('.fd-dtp [data-hour="8"]'); await s.click('.fd-dtp [data-minute="30"]'); await s.key('Escape', 'Escape');
    await check('Esc 关闭不写入', async () => {
      await s.wait(`document.querySelector('.fd-dtp').hidden`, 'Esc 关闭');
      assert.equal(await inputValue(startInput), '');
      assert.equal(await draftSnap(), beforePick);
    });

    await s.eval(`(()=>{window.__chg={s:0,e:0};const i=document.getElementById('fwF-startTime'),e=document.getElementById('fwF-endTime');i.addEventListener('change',()=>window.__chg.s++);e.addEventListener('change',()=>window.__chg.e++);})()`);
    await openPicker(startInput); await s.click('.fd-dtp [data-hour="8"]'); await s.click('.fd-dtp [data-minute="30"]'); await s.click('.fd-dtp [data-ok]');
    await check('确定后写入 08:30:00 并同步本机草稿与 change', async () => {
      const value = await inputValue(startInput);
      assert.equal(value, today + ' 08:30:00');
      const draft = JSON.parse(await draftSnap());
      assert.equal(Object.values(draft)[0].s, today + ' 08:30:00');
      assert.equal(await s.eval('window.__chg.s'), 1);
      return { value };
    });
    await s.shot('03-确定后写入时分秒');

    // 结束时间：空值默认取开始时间 +1 小时，且保留分钟
    await openPicker(endInput);
    await check('结束时间为空时默认取开始时间 +1 小时（09:30:00）', async () => {
      const r = await panelState();
      assert.equal(r.preview, today + ' 09:30:00', r.preview);
      assert.equal(await inputValue(endInput), '');
      return { preview: r.preview };
    });
    await s.click('.fd-dtp [data-ok]');
    await check('默认值同样需点确定才写回', async () => {
      assert.equal(await inputValue(endInput), today + ' 09:30:00');
      assert.equal(await s.eval(`document.querySelector('.fd-dtp').hidden`), true);
    });

    // 先后关系：相等与更早都要在面板内拦住，且不关闭面板
    for (const [label, hour, minute] of [['等于开始时间', '8', '30'], ['早于开始时间', '7', '55']]) {
      await openPicker(endInput);
      await s.click(`.fd-dtp [data-hour="${hour}"]`); await s.click(`.fd-dtp [data-minute="${minute}"]`); await s.click('.fd-dtp [data-ok]');
      await check('结束' + label + '时被面板拦截且不关闭', async () => {
        const r = await panelState();
        assert.equal(r.hidden, false, JSON.stringify(r));
        assert.equal(r.error, '旁站结束时间必须晚于开始时间');
        assert.equal(await inputValue(endInput), today + ' 09:30:00');
        return { error: r.error, preview: r.preview };
      });
      if (label === '等于开始时间') await s.shot('04-结束不晚于开始被拦截');
    }
    await s.click('.fd-dtp [data-hour="11"]'); await s.click('.fd-dtp [data-minute="30"]'); await s.click('.fd-dtp [data-ok]');
    await check('改为 11:30 后通过并写入', async () => {
      assert.equal(await inputValue(endInput), today + ' 11:30:00');
      assert.equal(await s.eval(`document.querySelector('.fd-dtp').hidden`), true);
      return { value: await inputValue(endInput) };
    });
    await s.shot('05-结束确定后写入');

    // 日期字段同样带确认
    const dateBefore = await draftSnap();
    await openPicker('#fwF-inspectionDate');
    await check('日期面板无整点/分钟区但仍需确认', async () => {
      const r = await s.eval(`(()=>({hoursHidden:document.querySelector('.fd-dtp [data-hours]').hidden,minutesHidden:document.querySelector('.fd-dtp [data-minutes]').hidden,ok:document.querySelector('.fd-dtp [data-ok]').textContent,cancel:document.querySelector('.fd-dtp [data-cancel]').textContent}))()`);
      assert.deepEqual(r, { hoursHidden: true, minutesHidden: true, ok: '确定', cancel: '取消' });
      return r;
    });
    await s.click('.fd-dtp [data-day="1"]');
    await check('日期选择未确认不写入', async () => {
      assert.equal(await inputValue('#fwF-inspectionDate'), today);
      assert.equal(await draftSnap(), dateBefore);
    });
    await s.click('.fd-dtp [data-cancel]');
    await check('日期取消后保持原值', async () => assert.equal(await inputValue('#fwF-inspectionDate'), today));
    await openPicker('#fwF-inspectionDate');
    await s.click(`.fd-dtp [data-day="${Number(today.slice(8))}"]`); await s.click('.fd-dtp [data-ok]');
    await check('日期确定后写回同一天', async () => {
      assert.equal(await inputValue('#fwF-inspectionDate'), today);
      assert.equal(await s.eval(`document.querySelector('.fd-dtp').hidden`), true);
    });

    // 保存草稿：服务端收到秒位为 00 的整分时间
    await fillRequired();
    await s.click('#fwSave');
    await s.wait(`document.querySelector('#fwError').textContent.includes('服务器草稿已保存')`, '保存草稿');
    await check('保存后服务端时间为 HH:mm:00 且保留分钟', async () => {
      const list = await api('/records/sideline-inspections?pageNum=1&pageSize=10&projectId=' + projectId);
      const record = list.list.find(r => r.inspectionDate === today) || list.list[0];
      recordId = record.id;
      assert.equal(record.startTime, today + 'T08:30:00');
      assert.equal(record.endTime, today + 'T11:30:00');
      return { id: recordId, startTime: record.startTime, endTime: record.endTime };
    });
    await s.shot('06-保存后服务端时分秒');

    // 历史秒值：非 5 分钟档的 08:15:30 原样往返，直接确定不许取整
    const version = (await api('/sideline-inspections/' + recordId)).lockVersion;
    await api('/sideline-inspections/' + recordId, 'PUT', { startTime: '2026-10-29T08:15:30', endTime: '2026-10-29T11:15:30' }, { 'X-Record-Version': String(version) });
    await s.navigate('sideline-inspection.html');
    await s.wait(`document.querySelector('#fwProject option[value="${projectId}"]')`, '项目下拉');
    await s.select('#fwProject', projectId);
    await s.wait(`document.querySelector('#fwRows [data-id="${recordId}"]')`, '记录行');
    await s.click(`#fwRows [data-id="${recordId}"]`);
    await s.wait(`document.querySelector('${startInput}')`, '编辑已有记录');
    await check('历史 08:15:30 原样显示（未被取整到 5 分钟）', async () => {
      assert.equal(await inputValue(startInput), '2026-10-29 08:15:30');
      assert.equal(await inputValue(endInput), '2026-10-29 11:15:30');
    });
    await openPicker(startInput);
    await s.click('.fd-dtp [data-ok]');
    await check('未改动直接确定不重置历史秒值', async () => {
      assert.equal(await inputValue(startInput), '2026-10-29 08:15:30');
      assert.equal(await s.eval(`document.querySelector('.fd-dtp').hidden`), true);
    });
    await s.click('#fwSave');
    await s.wait(`document.querySelector('#fwError').textContent.includes('服务器草稿已保存')`, '再次保存');
    await check('保存后历史秒值未被改写', async () => {
      const record = await api('/sideline-inspections/' + recordId);
      assert.equal(record.startTime, '2026-10-29T08:15:30');
      assert.equal(record.endTime, '2026-10-29T11:15:30');
      return { startTime: record.startTime };
    });
    await s.shot('07-历史秒值原样保留');

    // 窄屏：两段选择区都要贴底、完整可见、可滚动到“确定”
    for (const width of [375, 320]) {
      await s.width(width);
      await openPicker(startInput);
      await check(width + ' 面板在视口内且无横向溢出', async () => {
        const r = await s.eval(`(()=>{const p=document.querySelector('.fd-dtp'),b=p.getBoundingClientRect();return {left:Math.round(b.left),right:Math.round(b.right),top:Math.round(b.top),bottom:Math.round(b.bottom),w:Math.round(b.width),vw:innerWidth,vh:innerHeight,scroll:p.scrollWidth,client:p.clientWidth};})()`);
        assert.ok(r.left >= 0 && r.right <= r.vw + 1, JSON.stringify(r));
        assert.ok(r.bottom <= r.vh + 1 && r.top >= 0, JSON.stringify(r));
        assert.ok(r.scroll <= r.client + 2, JSON.stringify(r));
        return r;
      });
      await check(width + ' 确定按钮可滚动到可见区域', async () => {
        const r = await s.eval(`(()=>{const p=document.querySelector('.fd-dtp');p.scrollTop=p.scrollHeight;const b=document.querySelector('.fd-dtp [data-ok]').getBoundingClientRect(),pb=p.getBoundingClientRect();return {okBottom:Math.round(b.bottom),okTop:Math.round(b.top),panelBottom:Math.round(pb.bottom),vh:innerHeight};})()`);
        assert.ok(r.okTop >= 0 && r.okBottom <= r.vh + 1, JSON.stringify(r));
        assert.ok(r.okBottom <= r.panelBottom + 1, JSON.stringify(r));
        return r;
      });
      await s.shot('0' + (width === 375 ? 8 : 9) + '-' + width + '贴底面板');
      await s.click('.fd-dtp [data-cancel]');
    }
    await s.width(1440);

    // 日常巡检回归：仍为整点面板，不能被本次改造放宽精度
    await s.navigate('daily-inspection.html');
    await s.wait(`document.querySelector('#fwProject option[value="${projectId}"]')`, '巡检项目下拉');
    await s.select('#fwProject', projectId);
    await s.click('#fwNew');
    await s.wait(`document.querySelector('#fwF-startTime')`, '巡检表单');
    await check('日常巡检仍为整点面板（分钟区隐藏）', async () => {
      const r = await s.eval(`(()=>{const el=document.getElementById('fwF-startTime');return {picker:el.dataset.picker,readonly:el.readOnly,placeholder:el.placeholder};})()`);
      assert.equal(r.picker, 'hour'); assert.equal(r.readonly, true);
      assert.ok(r.placeholder.includes('精确到小时'), r.placeholder);
      return r;
    });
    await openPicker('#fwF-startTime');
    await check('日常巡检面板无分钟档', async () => {
      const r = await s.eval(`(()=>({minutesHidden:document.querySelector('.fd-dtp [data-minutes]').hidden,minutes:document.querySelectorAll('.fd-dtp [data-minute]').length}))()`);
      assert.deepEqual(r, { minutesHidden: true, minutes: 0 });
      return r;
    });
    await s.click('.fd-dtp [data-cancel]');
    await s.shot('10-日常巡检仍为整点面板');

    await check('无浏览器运行异常', async () => { assert.deepEqual(s.errors, []); });
  } catch (e) {
    results.push({ name: '阻塞', pass: false, error: e.message });
    console.error(e);
    await s.shot('FAIL-current').catch(() => {});
    fs.writeFileSync(path.join(OUT, 'failure-dom.txt'), await s.eval('document.body.innerText').catch(() => ''));
    process.exitCode = 1;
  } finally {
    const passed = results.filter(r => r.pass).length;
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ projectId, recordId, passed, failed: results.length - passed, results, errors: s.errors }, null, 2));
    console.log('TOTAL ' + passed + ' PASS ' + (results.length - passed) + ' FAIL');
    console.log('证据目录：' + OUT);
    fs.writeFileSync(path.join(__dirname, 'browser-check.log'), logLines.join('\n') + '\n', 'utf8');
    s.ws.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
