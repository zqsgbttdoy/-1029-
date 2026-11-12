// 日常巡检“添加问题”移除照片上传 真实浏览器验收：独立 e2e（18090/18091）+ 无头 Edge（19232）
// 覆盖：问题面板无任何上传入口/文件选择器、检查项照片入口保留、全局上传区选图后显示预览、无 JS 异常。
// 全程在隔离实例操作，关闭不保存，不污染正式服务。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const BASE = 'http://127.0.0.1:18091', CDP_PORT = 19232;
const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const results = [], sleep = ms => new Promise(r => setTimeout(r, ms));
// 1x1 透明 PNG，用于全局上传预览测试
const PNG = path.join(__dirname, 'probe.png');
fs.writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
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
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP超时：' + method)); }, method === 'Page.captureScreenshot' ? 60000 : 25000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
  async wait(expression, label) { for (let i = 0; i < 250; i++) { try { if (await this.eval(expression)) return; } catch (_) {} await sleep(100); } throw new Error('等待超时：' + label); }
  async navigate(page) { await this.send('Page.navigate', { url: BASE + '/' + page }); await this.wait(`location.pathname.endsWith(${JSON.stringify(page.split('?')[0])}) && document.readyState==='complete'`, page); await sleep(150); }
  async click(selector) { const p = await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('控件不存在: '+${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`); await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p }); }
  async shot(name) { await this.send('Page.bringToFront'); await sleep(200); const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); }
  async width(width, height = 900) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(200); }
}
let s;
async function check(name, fn) { const detail = await fn(); results.push({ name, pass: true, detail }); console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); }
async function closeProblemPanel() {
  await s.click('[data-ic-panel] [data-ic-action="cancel-problems"]');
  // 副本已修改时弹自定义确认框，点“确定”放弃
  for (let i = 0; i < 30; i++) { if (await s.eval(`!!document.querySelector('[data-act="ok"]')`)) { await s.click('[data-act="ok"]'); break; } await sleep(100); }
  await s.wait(`!document.querySelector('[data-ic-panel] .ic-problem')`, '问题面板关闭');
}
(async () => {
  const page = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  s = new CDP(ws);
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Network.enable'); await s.send('DOM.enable'); await s.width(1440);
  try {
    await s.navigate('login.html');
    await s.eval(`document.querySelector('#username').value='admin';document.querySelector('#password').value='123456'`);
    await s.click('#loginBtn'); await s.wait(`!!window.App&&!!App.getToken()&&!location.pathname.endsWith('login.html')`, '登录');
    await check('隔离实例真实登录且只访问 18091', async () => assert.equal(await s.eval('location.origin'), BASE));
    const pid = await s.eval(`(async()=>{const p=await App.apiFetch('/projects',{method:'POST',body:{name:'问题上传移除验收',code:'PUR-'+Date.now().toString(36).toUpperCase(),buildUnit:'验收单位',address:'验收地址',type:'房建工程',status:'active',startDate:'2026-01-01',endDate:'2027-01-01',description:'验收'}});return p.id;})()`);
    await s.navigate('daily-inspection.html');
    await s.wait(`!!document.querySelector('#fwProject') && Array.from(document.querySelector('#fwProject').options).some(o=>o.value)`, '项目下拉');
    await s.eval(`(()=>{const el=document.querySelector('#fwProject');el.value=${JSON.stringify(String(pid))};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await s.click('#fwNew');
    await s.wait(`!document.querySelector('#fwEditor').hidden && document.querySelectorAll('#fwForm .fd-field').length>0`, '新建表单');
    await sleep(300);
    await check('全局现场照片上传区保留且可用', async () => {
      assert.equal(await s.eval(`(()=>{const el=document.querySelector('#fwUploadField');return !!el && !el.hidden && el.getClientRects().length>0;})()`), true, '#fwUploadField 可见');
      assert.equal(await s.eval(`!!document.querySelector('.fd-dropzone#fwUploadLabel')`), true, '.fd-dropzone 保留');
      assert.equal(await s.eval(`(()=>{const el=document.querySelector('#fwUpload');return !!el && el.type==='file' && !el.disabled;})()`), true, '全局文件选择器可用');
      return { projectId: pid };
    });
    await s.click('[data-ic-action="add"]');
    await s.wait(`document.querySelectorAll('[data-ic-id]').length>0`, '检查项行');
    const itemId = await s.eval(`document.querySelector('[data-ic-id]').dataset.icId`);
    await check('检查项级现场照片入口保留（非问题照片）', async () => {
      assert.equal(await s.eval(`!!document.querySelector('[data-ic-photo="'+${JSON.stringify(itemId)}+'"]')`), true, '检查项照片上传入口仍在');
    });
    await s.click('[data-ic-id="' + itemId + '"] [data-ic-action="problems"]');
    await s.wait(`!!document.querySelector('[data-ic-panel] .ic-problem')`, '问题面板展开');
    await sleep(200);
    await check('问题编辑面板无任何图片/附件上传按钮或文件选择器', async () => {
      const html = await s.eval(`document.querySelector('[data-ic-panel]').innerHTML`);
      assert.equal(/data-problem-upload/.test(html), false, '不得有问题文件选择器绑定');
      assert.equal(/添加图片或附件/.test(html), false, '不得有“添加图片或附件”按钮');
      assert.equal(/重试问题附件|data-upload-message/.test(html), false, '不得有上传状态/重试入口');
      assert.equal(await s.eval(`document.querySelectorAll('[data-ic-panel] input[type=file]').length`), 0, '面板内文件选择器数量为 0');
      assert.equal(await s.eval(`document.querySelectorAll('[data-ic-panel] .ic-upload').length`), 0, '面板内上传标签数量为 0');
      assert.equal(await s.eval(`!!document.querySelector('[data-ic-panel] [data-problem-field="description"]')`), true, '问题说明输入保留');
      assert.equal(await s.eval(`!!document.querySelector('[data-ic-panel] [data-ic-action="delete-problem"]')`), true, '删除问题按钮保留');
      return {};
    });
    await s.shot('问题面板-无上传入口');
    await s.click('[data-ic-panel] [data-ic-action="add-problem"]');
    await sleep(150);
    await check('新增问题后面板仍无任何上传入口', async () => {
      assert.equal(await s.eval(`document.querySelectorAll('[data-ic-panel] input[type=file]').length`), 0);
      assert.equal(await s.eval(`document.querySelectorAll('[data-ic-panel] .ic-upload').length`), 0);
      assert.equal(await s.eval(`document.querySelectorAll('[data-ic-panel] .ic-problem').length`), 2);
    });
    await closeProblemPanel();
    await check('全局上传区选择图片后显示预览', async () => {
      const doc = await s.send('DOM.getDocument');
      const node = await s.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fwUpload' });
      await s.send('DOM.setFileInputFiles', { files: [PNG], nodeId: node.nodeId });
      await s.wait(`document.querySelectorAll('#fwMedia img').length>0`, '照片预览缩略图');
      const cnt = await s.eval(`document.querySelectorAll('#fwMedia img').length`);
      assert.ok(cnt >= 1, '至少一张预览');
      return { previews: cnt };
    });
    await s.shot('全局上传-显示预览');
    await s.click('#fwClose');
    await s.wait(`document.querySelector('#fwEditor').hidden`, '关闭编辑器（不保存）');
    await check('全程无 JavaScript 异常与接口 4xx/5xx', async () => { assert.deepEqual(s.errors, []); assert.deepEqual(s.httpErrors, []); });
    console.log('合计 ' + results.length + '/' + results.length + ' 通过（隔离实例，关闭未保存）');
  } catch (e) {
    results.push({ name: '阻塞', pass: false, error: e.message }); console.error(e);
    await s.shot('FAIL-current').catch(() => {}); process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(__dirname, '验收结果.json'), JSON.stringify({ base: BASE, time: new Date().toISOString(), results, errors: s.errors, httpErrors: s.httpErrors }, null, 2));
    console.log('证据目录：' + OUT); s.ws.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });