// 对当前正式 8081 做真实渲染截图：证明服务端已提供内嵌目录树版本。
// 只登录 + 打开新建弹窗 + 上传一个样例附件，不保存任何记录。
const BASE = 'http://127.0.0.1:8081';
const CDP = 'http://127.0.0.1:19251';
const OUT = 'e:/希地工作/trae 文件保存/完整版-监理 - qoder/测试工作区/目录关联验收-20261103/results';
const SAMPLE = 'e:/希地工作/trae 文件保存/完整版-监理 - qoder/测试工作区/目录关联验收-20261103/upload-sample.txt';
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch('http://127.0.0.1:8080/api' + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (!r.ok) throw new Error('API ' + path + ' -> ' + r.status);
  return r.json();
}

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

let token = null;

(async () => {
  token = (await api('/auth/login', { method: 'POST', body: { username: 'admin', password: '123456' } })).data.token;
  const projects = await api('/projects?pageNum=1&pageSize=100');
  const list = (projects.data && (projects.data.list || projects.data.items)) || projects.list || projects.items || [];
  // 找一个 active 且目录树含叶子的项目
  let target = null;
  for (const p of list.filter(x => x.status === 'active')) {
    try {
      const t = await api('/sub-item-databases/tree?projectId=' + p.id);
      const nodes = t.data || t;
      if (Array.isArray(nodes) && nodes.length > 0) { target = { id: p.id, name: p.name }; break; }
    } catch (_) {}
  }
  if (!target) throw new Error('没有找到带目录的正式项目');
  console.log('target project =', JSON.stringify(target));

  const page = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const browser = new Browser(page.webSocketDebuggerUrl);
  await browser.ready();
  await browser.send('Page.enable'); await browser.send('Runtime.enable'); await browser.send('Network.enable'); await browser.send('DOM.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  // 干净登录
  await browser.navigate('login.html');
  await browser.eval(`localStorage.clear();sessionStorage.clear();`);
  await browser.navigate('login.html');
  await browser.set('#username', 'admin');
  await browser.set('#password', '123456');
  await browser.click('#loginBtn');
  await browser.wait(`!!window.App && !!App.getToken() && !location.pathname.endsWith('login.html')`, '真实登录');

  // 联系单：新建 → 选项目 → 上传附件 → 等待内嵌树 → 截图
  await browser.navigate('work-contact.html');
  await browser.wait(`!!window.App && !!App.getToken()`, '联系单已登录');
  await browser.eval(`openCreateModal()`);
  await browser.set('#projectSelect', String(target.id), 'change');
  await browser.setFiles('#createFileInput', [SAMPLE]);
  await browser.wait(`document.querySelector('#createAttachmentList .attachment-item[data-url]') && document.querySelectorAll('#createAttachmentList .attachment-item .leaf-node').length > 0`, '联系单附件内嵌目录树');
  const contactInfo = await browser.eval(`(()=>{const it=document.querySelector('#createAttachmentList .attachment-item');return{tree:!!it.querySelector('.doc-tree.dir-tree-container'),leafs:it.querySelectorAll('.leaf-node').length,modal:!!document.getElementById('dirTreeModal')};})()`);
  console.log('联系单内嵌树 =', JSON.stringify(contactInfo));
  await browser.shot('8081-01-联系单附件内嵌目录树');

  // 通知单：新建 → 选同项目 → 等待目录树 → 截图（对照）
  await browser.navigate('supervision-notice.html');
  await browser.wait(`!!window.App && !!App.getToken()`, '通知单已登录');
  await browser.eval(`openCreateModal()`);
  await browser.set('#projectSelect', String(target.id), 'change');
  await browser.wait(`document.querySelectorAll('#docTree .doc-leaf-node').length > 0`, '通知单目录树');
  await browser.shot('8081-02-通知单目录树对照');

  console.log('DONE');
  try { ws.close(); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message || e); process.exit(1); });
