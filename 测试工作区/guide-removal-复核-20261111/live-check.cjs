'use strict';
// 2026-11-11 填写指引下线复核（正式本地实例 8080/8081，只读）：打开新建表单核对无蓝色指引栏、
// 占位文案保留、布局紧凑，关闭不保存，不写入任何数据。CDP=19232。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const BASE = 'http://127.0.0.1:8081', CDP_ORIGIN = process.env.LIVE_CDP || 'http://127.0.0.1:19232';
const OUT = __dirname;
const results = [], sleep = ms => new Promise(r => setTimeout(r, ms));
let s;
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.httpErrors = [];
    ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data), p = this.pending.get(msg.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === 'Network.responseReceived' && msg.params.response.url.includes('/api/') && msg.params.response.status >= 400)
        this.httpErrors.push({ status: msg.params.response.status, url: msg.params.response.url });
      if (msg.method === 'Page.javascriptDialogOpening') void this.send('Page.handleJavaScriptDialog', { accept: true });
    });
  }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP超时：' + method)); }, 30000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
  async wait(expression, label) { for (let i = 0; i < 200; i++) { try { if (await this.eval(expression)) return; } catch (_) {} await sleep(100); } throw new Error('等待超时：' + label); }
  async navigate(page) { await this.send('Page.navigate', { url: BASE + '/' + page }); await this.wait(`location.pathname.endsWith(${JSON.stringify(page.split('?')[0])}) && document.readyState==='complete'`, page); }
  async click(selector) { const box = await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.hidden||el.disabled)throw Error('控件不可点: '+${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`); await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box }); }
  async shot(name) { await sleep(200); const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); }
}
async function check(name, fn) { const detail = await fn(); results.push({ name, pass: true, detail }); console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); }
const layoutProbe = `(()=>{const visible=el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';
const roots=[document.documentElement,...document.querySelectorAll('#fwEditor:not([hidden]) .fd-modal,#fwEditor:not([hidden]) .fd-body,#createModal.show .fd-modal,#createModal.show .modal-body')];
const overflow=roots.filter(visible).filter(el=>el.scrollWidth>el.clientWidth+2).map(el=>({tag:el.className||el.tagName,scroll:el.scrollWidth,client:el.clientWidth}));
const form=document.querySelector('#fwForm')||document.querySelector('#createModal .fd-grid');
const gap=form&&form.firstElementChild?Math.round(form.firstElementChild.getBoundingClientRect().top-form.getBoundingClientRect().top):null;
return {overflow,gap};})()`;
async function pickProject() { return s.eval(`(()=>{const sel=document.querySelector('#fwProject');return Array.from(sel.options).filter(o=>o.value)[0]?.value||'';})()`); }
async function fieldPage(page, label, extra) {
  await s.navigate(page + '.html');
  await s.wait(`!!document.querySelector('#fwProject') && Array.from(document.querySelector('#fwProject').options).some(o=>o.value)`, label + '项目下拉');
  const pid = await pickProject();
  await s.eval(`(()=>{const el=document.querySelector('#fwProject');el.value=${JSON.stringify(pid)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await s.click('#fwNew');
  await s.wait(`!document.querySelector('#fwEditor').hidden && document.querySelectorAll('#fwForm .fd-field').length>0`, label + '新建表单');
  await sleep(300);
  await check(label + '：无填写指引栏且占位文案保留', async () => {
    assert.equal(await s.eval(`!!document.querySelector('#fwGuide')`), false, '#fwGuide 应不存在');
    assert.equal(await s.eval(`!!document.querySelector('.fd-info')`), false, '.fd-info 应不存在');
    assert.equal(await s.eval(`/填写指引|填写提示|fd-guide-title/.test(document.querySelector('#fwForm').innerHTML)`), false, '表单内不得残留指引文案');
    const ph = await s.eval(`Array.from(document.querySelectorAll('#fwForm [placeholder]')).map(el=>el.getAttribute('placeholder')).filter(t=>t&&t.trim())`);
    assert.ok(ph.length >= 1, '至少一个非空占位文案');
    if (extra) await extra();
    const layout = await s.eval(layoutProbe);
    assert.deepEqual(layout.overflow, [], '无横向溢出');
    assert.ok(layout.gap !== null && layout.gap <= 8, '首个区块紧贴顶部，实际间隙=' + layout.gap);
    return { projectId: pid, placeholders: ph.length, topGap: layout.gap };
  });
  await s.shot(label + '-正式实例无指引栏');
  await s.click('#fwClose');
  await s.wait(`document.querySelector('#fwEditor').hidden`, label + '关闭编辑器');
}
(async () => {
  const page = await (await fetch(CDP_ORIGIN + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); }); s = new CDP(ws);
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Network.enable');
  await s.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  try {
    await s.navigate('login.html');
    await s.eval(`document.querySelector('#username').value='admin';document.querySelector('#password').value='123456'`);
    await s.click('#loginBtn'); await s.wait(`!!window.App&&!!App.getToken()&&!location.pathname.endsWith('login.html')`, '真实登录');
    await check('正式实例真实登录且只访问 8081', async () => assert.equal(await s.eval('location.origin'), BASE));
    await fieldPage('supervision-diary', '监理日记', async () => {
      assert.equal(await s.eval(`!!document.querySelector('#fwDiaryDay')`), true, '日记当天业务摘要面板保留');
    });
    await fieldPage('supervision-log', '监理日志');
    await fieldPage('daily-inspection', '日常巡检');
    await fieldPage('sideline-inspection', '旁站检查');
    await s.navigate('safety-log.html');
    await s.wait(`!!document.querySelector('#projectFilter') && Array.from(document.querySelector('#projectFilter').options).some(o=>o.value)`, '安全日志项目下拉');
    const pid = await s.eval(`Array.from(document.querySelector('#projectFilter').options).filter(o=>o.value)[0].value`);
    await s.eval(`(()=>{const el=document.querySelector('#projectFilter');el.value=${JSON.stringify(pid)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await s.click('button[onclick="openCreateModal()"]');
    await s.wait(`document.querySelector('#createModal').classList.contains('show')`, '安全日志新建弹窗');
    await sleep(300);
    await check('安全日志：无填写提示面板且占位文案保留', async () => {
      assert.equal(await s.eval(`!!document.querySelector('#createModal .fd-info')`), false, '.fd-info 应不存在');
      assert.equal(await s.eval(`/填写指引|fd-guide-title/.test(document.querySelector('#createModal').innerHTML)`), false);
      assert.ok((await s.eval(`document.querySelector('#createModal .fd-sub').textContent`)).includes('框内灰色文字为填写提示'), 'placeholder 说明保留');
      const ph = await s.eval(`Array.from(document.querySelectorAll('#createModal [placeholder]')).map(el=>el.getAttribute('placeholder')).filter(t=>t&&t.trim())`);
      assert.ok(ph.length >= 6, '安全日志占位文案齐全');
      const layout = await s.eval(layoutProbe);
      assert.deepEqual(layout.overflow, [], '无横向溢出');
      return { placeholders: ph.length };
    });
    await s.shot('安全日志-正式实例无指引栏');
    await s.eval(`closeModal('createModal')`);
    // 窄屏复核
    await s.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: false });
    await s.navigate('daily-inspection.html');
    await s.wait(`!!document.querySelector('#fwProject') && Array.from(document.querySelector('#fwProject').options).some(o=>o.value)`, '窄屏项目下拉');
    const np = await s.eval(`Array.from(document.querySelector('#fwProject').options).filter(o=>o.value)[0].value`);
    await s.eval(`(()=>{const el=document.querySelector('#fwProject');el.value=${JSON.stringify(np)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await s.click('#fwNew');
    await s.wait(`!document.querySelector('#fwEditor').hidden && document.querySelectorAll('#fwForm .fd-field').length>0`, '窄屏新建表单');
    await check('375px 窄屏巡检表单无指引栏且无横向溢出', async () => {
      assert.equal(await s.eval(`!!document.querySelector('#fwGuide,.fd-info')`), false);
      const layout = await s.eval(layoutProbe);
      assert.deepEqual(layout.overflow, [], '无横向溢出');
      return { topGap: layout.gap };
    });
    await s.shot('日常巡检-正式实例375窄屏无指引栏');
    await s.eval(`document.querySelector('#fwClose').click()`);
    await check('全程无 JavaScript 异常和接口 4xx/5xx', async () => { assert.deepEqual(s.errors, []); assert.deepEqual(s.httpErrors, []); });
    console.log('合计 ' + results.length + '/' + results.length + ' 通过（只读，未保存任何记录）');
  } catch (e) {
    results.push({ name: '阻塞', pass: false, error: e.message }); console.error(e);
    await s.shot('FAIL-current').catch(() => {}); process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(OUT, '复核结果.json'), JSON.stringify({ base: BASE, time: new Date().toISOString(), readonly: true, results, errors: s.errors, httpErrors: s.httpErrors }, null, 2));
    console.log('证据目录：' + OUT); s.ws.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });