// 在隔离 e2e 环境精确复现 verifyContactInline 的搭建步骤，抓取 JS 异常与目录树状态。
const BASE = 'http://127.0.0.1:18131';
const CDP = 'http://127.0.0.1:19250';
const SAMPLE = 'e:/希地工作/trae 文件保存/完整版-监理 - qoder/测试工作区/目录关联验收-20261103/upload-sample.txt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  constructor(wsUrl) { this.ws = new WebSocket(wsUrl); this.id = 0; this.pending = new Map(); this.events = []; }
  async ready() { await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') { this.events.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') { this.events.push('console.error: ' + JSON.stringify(m.params.args?.map(a => a.value || a.description))); } }; }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); }, 30000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
  async wait(expression, label) { for (let i = 0; i < 200; i++) { try { if (await this.eval(expression)) return; } catch (_) {} await sleep(100); } throw new Error('等待超时：' + label); }
  async navigate(page) { await this.send('Page.navigate', { url: BASE + '/' + page }); await this.wait(`location.pathname.endsWith(${JSON.stringify(page)}) && document.readyState === 'complete'`, page); }
  async set(selector, value, event = 'input') { await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('缺控件 ${selector}');el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`); }
  async click(selector) { const pt = await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('不可点击 ${selector}');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`); await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pt }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pt }); }
  async setFiles(selector, files) { const doc = await this.send('DOM.getDocument'); const { nodeId } = await this.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector }); if (!nodeId) throw new Error('找不到文件输入 ' + selector); await this.send('DOM.setFileInputFiles', { files, nodeId }); }
}

(async () => {
  const login = await fetch('http://127.0.0.1:18131/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '123456' }) }).then(r => r.json());
  const token = login.data.token;
  const projects = await fetch('http://127.0.0.1:18131/api/projects?pageNum=1&pageSize=100', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
  const list = (projects.data && projects.data.list) || projects.list || [];
  let target = null;
  for (const p of list.filter(x => x.status === 'active')) {
    const t = await fetch('http://127.0.0.1:18131/api/sub-item-databases/tree?projectId=' + p.id, { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
    const nodes = t.data || t;
    if (Array.isArray(nodes) && nodes.length) { target = p; break; }
  }
  if (!target) throw new Error('无带目录项目');
  console.log('target =', target.id, target.name);

  const page = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  const browser = new Browser(page.webSocketDebuggerUrl);
  await browser.ready();
  await browser.send('Page.enable'); await browser.send('Runtime.enable'); await browser.send('DOM.enable');
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
  await browser.set('#projectSelect', String(target.id), 'change');
  await browser.setFiles('#createFileInput', [SAMPLE]);

  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    const st = await browser.eval(`(()=>{const it=document.querySelector('#createAttachmentList .attachment-item');return{ready:dirTreeReady,pid:dirTreeProjectId,err:dirTreeLoadError,dataLen:dirTreeData?dirTreeData.length:null,selectVal:document.getElementById('projectSelect').value,hasAtt:!!it,url:it?it.getAttribute('data-url'):null,leafs:it?it.querySelectorAll('.leaf-node').length:null,ph:it?(it.querySelector('.dir-tree-container .demo-placeholder')||{}).textContent:null,globalLeafs:document.querySelectorAll('#contactDirSection .leaf-node').length};})()`);
    console.log('t+' + ((i + 1) * 2) + 's', JSON.stringify(st));
    if (st.leafs > 0) break;
  }
  console.log('JS exceptions =', JSON.stringify(browser.events));
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message || e); process.exit(1); });
