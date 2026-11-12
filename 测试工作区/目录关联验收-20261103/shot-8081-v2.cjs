// 验证：工作联系单打开新建弹窗（未上传附件）即显示常驻目录树；勾选后新上传附件自动继承。
const BASE = 'http://127.0.0.1:8081';
const CDP = 'http://127.0.0.1:19251';
const OUT = 'e:/希地工作/trae 文件保存/完整版-监理 - qoder/测试工作区/目录关联验收-20261103/results';
const SAMPLE = 'e:/希地工作/trae 文件保存/完整版-监理 - qoder/测试工作区/目录关联验收-20261103/upload-sample.txt';
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); }
  async ready() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }; }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); }, 30000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
  async wait(expression, label) { for (let i = 0; i < 300; i++) { try { if (await this.eval(expression)) return; } catch (_) {} await sleep(100); } throw new Error('等待超时：' + label); }
  async navigate(page) { await this.send('Page.navigate', { url: BASE + '/' + page }); await this.wait(`location.pathname.endsWith(${JSON.stringify(page)}) && document.readyState === 'complete'`, page); }
  async set(selector, value, event = 'input') { await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('缺控件 ${selector}');el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`); }
  async click(selector) { const pt = await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('不可点击 ${selector}');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`); await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pt }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pt }); }
  async setFiles(selector, files) { const doc = await this.send('DOM.getDocument'); const { nodeId } = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector }); if (!nodeId) throw new Error('找不到文件输入 ' + selector); await this.send('DOM.setFileInputFiles', { files, nodeId }); }
  async shot(name) { const img = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(OUT + '/' + name + '.png', Buffer.from(img.data, 'base64')); console.log('saved ' + name + '.png'); }
}

(async () => {
  const page = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  const browser = new Browser(page.webSocketDebuggerUrl);
  await browser.ready();
  await browser.send('Page.enable'); await browser.send('Runtime.enable'); await browser.send('Network.enable'); await browser.send('DOM.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  await browser.navigate('login.html');
  await browser.eval(`localStorage.clear();sessionStorage.clear();`);
  await browser.navigate('login.html');
  await browser.set('#username', 'admin');
  await browser.set('#password', '123456');
  await browser.click('#loginBtn');
  await browser.wait(`!!window.App && !!App.getToken() && !location.pathname.endsWith('login.html')`, '真实登录');

  await browser.navigate('work-contact.html');
  await browser.wait(`!!window.App && !!App.getToken()`, '联系单已登录');
  await browser.eval(`openCreateModal()`);
  await browser.set('#projectSelect', '3', 'change');

  // 1) 未上传任何附件，常驻目录树就必须已经显示
  await browser.wait(`document.querySelectorAll('#contactDirSection .leaf-node').length > 0`, '打开弹窗即显示常驻目录树');
  const before = await browser.eval(`(()=>{const s=document.getElementById('contactDirSection');return{section:!!s,leafs:s.querySelectorAll('.leaf-node').length,attachments:document.querySelectorAll('#createAttachmentList .attachment-item').length,placeholder:(s.querySelector('.dir-tree-container .demo-placeholder')||{}).textContent||''};})()`);
  console.log('上传附件前 =', JSON.stringify(before));
  if (!before.section || before.leafs < 1 || before.attachments !== 0) throw new Error('常驻目录树未在上传附件前显示');
  await browser.shot('8081-03-打开弹窗即显示目录树-未传附件');

  // 2) 直接勾选全部叶子（雪后多伦多当前仅 1 个末级目录）
  await browser.eval(`(()=>{const s=document.getElementById('contactDirSection');s.querySelectorAll('.dir-tree-container input[type="checkbox"][data-label]').forEach(c=>{if(!c.checked){c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));}});})()`);
  const picked = await browser.eval(`(()=>{const s=document.getElementById('contactDirSection');return{count:s.querySelector('.dir-selected-count').textContent,tags:s.querySelectorAll('.dir-selected-tags .selected-doc-tag').length,dirs:s._dirs};})()`);
  console.log('勾选后 =', JSON.stringify(picked));
  if (picked.dirs.length < 1 || !/已选 [1-9]/.test(picked.count)) throw new Error('常驻目录树勾选计数异常');
  await browser.shot('8081-04-上传前已勾选目录');

  // 3) 上传附件，新附件应自动继承默认目录
  await browser.setFiles('#createFileInput', [SAMPLE]);
  await browser.wait(`document.querySelector('#createAttachmentList .attachment-item[data-url]')`, '附件上传完成');
  const inherited = await browser.eval(`(()=>{const it=document.querySelector('#createAttachmentList .attachment-item');const s=document.getElementById('contactDirSection');return{attDirs:it._dirs,defaultDirs:s._dirs,checked:it.querySelectorAll('.dir-tree-container input[type="checkbox"][data-label]:checked').length};})()`);
  console.log('附件继承 =', JSON.stringify(inherited));
  if (JSON.stringify(inherited.attDirs) !== JSON.stringify(inherited.defaultDirs)) throw new Error('新附件未继承默认目录');
  await browser.shot('8081-05-新附件自动继承默认目录');

  console.log('DONE ALL PASS');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message || e); process.exit(1); });
