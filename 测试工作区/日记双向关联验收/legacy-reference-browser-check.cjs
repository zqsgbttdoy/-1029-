// 旧 biz_diary_reference 正文引用独立真实浏览器回归；不依赖新 diaryId 绑定计数。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fixture = require('./fixture.json');
const BASE = fixture.base, CDP_ORIGIN = process.env.E2E_CDP || 'http://127.0.0.1:19231';
const OUT = path.join(__dirname, 'legacy-reference-' + fixture.run);
fs.mkdirSync(OUT, { recursive: true });
const results = [], sleep = ms => new Promise(r => setTimeout(r, ms));
let token, diaryId, deletedDocumentId;
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; this.httpErrors = [];
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data), pending = this.pending.get(msg.id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(msg.id); msg.error ? pending.reject(new Error(JSON.stringify(msg.error))) : pending.resolve(msg.result); }
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      if (msg.method === 'Network.responseReceived' && msg.params.response.url.includes('/api/') && msg.params.response.status >= 400)
        this.httpErrors.push({ status: msg.params.response.status, url: msg.params.response.url });
      if (msg.method === 'Page.javascriptDialogOpening') void this.send('Page.handleJavaScriptDialog', { accept: true });
    });
  }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP超时：' + method)); }, 30000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
  async wait(expression, label) { for (let i = 0; i < 200; i++) { try { if (await this.eval(expression)) return; } catch (_) {} await sleep(100); } throw new Error('等待超时：' + label); }
  async navigate(page, readyExpression) { await this.send('Page.navigate', { url: BASE + '/' + page }); const standard = `location.pathname.endsWith(${JSON.stringify(page.split('?')[0])}) && document.readyState==='complete'`; await this.wait(readyExpression ? `(${readyExpression}) || (${standard})` : standard, page); }
  async click(selector) { const point = await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.hidden||el.disabled)throw Error('控件不可点: '+${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`); await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); }
  async select(selector, value) { await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async shot(name) { const image = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(image.data, 'base64')); }
}
let browser;
async function api(url, method = 'GET', body, expected = 200) {
  const response = await fetch(BASE + '/api' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (response.status !== expected) throw new Error(method + ' ' + url + ' 期望HTTP ' + expected + '，实际 ' + response.status + '：' + JSON.stringify(result));
  if (expected === 200 && result.code !== 200) throw new Error(method + ' ' + url + '：' + JSON.stringify(result));
  return result.data;
}
async function check(name, fn) { const detail = await fn(); results.push({ name, pass: true, detail }); console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); }
const editor = '#fwF-construction + .fd-link-editor';
const linkCount = () => browser.eval(`document.querySelectorAll('${editor} a[data-fd-ref]').length`);
const referenceCount = id => api('/project-documents/' + id + '/diary-references').then(data => data.total);
async function openEdit(id) {
  await browser.navigate('supervision-diary.html');
  await browser.wait(`document.querySelector('#fwProject option[value="${fixture.projectId}"]')`, '项目字典');
  await browser.select('#fwProject', fixture.projectId); await browser.select('#fwStatus', 'draft');
  await browser.wait(`document.querySelector('#fwRows [data-id="${id}"]')`, '日记列表'); await browser.click(`#fwRows [data-id="${id}"]`);
  await browser.wait(`document.querySelector('${editor}[contenteditable="true"]')`, '可编辑正文');
}
async function newDiary() {
  await browser.navigate('supervision-diary.html'); await browser.wait(`document.querySelector('#fwProject option[value="${fixture.projectId}"]')`, '项目字典');
  await browser.select('#fwProject', fixture.projectId); await browser.click('#fwNew'); await browser.wait(`document.querySelectorAll('.fd-link-editor').length===9`, '九栏正文');
}
async function paste(url, expected) {
  await browser.eval(`(()=>{const el=document.querySelector(${JSON.stringify(editor)});el.focus();const range=document.createRange();range.selectNodeContents(el);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(url)});el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`);
  await browser.wait(`document.querySelectorAll('${editor} a[data-fd-ref]').length===${expected}`, '粘贴授权转换');
}
async function save() {
  await browser.click('#fwSave'); await browser.wait(`!document.querySelector('#fwSave').disabled && document.querySelector('#fwError').textContent`, '保存回应');
  const message = await browser.eval(`document.querySelector('#fwError').textContent`); assert.ok(message.includes('服务器草稿已保存'), message);
}
async function selectLink(index) { await browser.eval(`(()=>{const el=document.querySelector(${JSON.stringify(editor)}),link=el.querySelectorAll('a[data-fd-ref]')[${index}];el.focus();const range=document.createRange();range.selectNode(link);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);})()`); }
async function key(key) { await browser.eval(`document.querySelector(${JSON.stringify(editor)}).focus()`); await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: 'Key' + key.toUpperCase(), modifiers: 2 }); await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: 'Key' + key.toUpperCase(), modifiers: 2 }); }
(async () => {
  token = (await api('/auth/login', 'POST', { username: 'admin', password: '123456' })).token;
  const diaries = await api('/supervision-diaries?projectId=' + fixture.projectId + '&status=draft&pageNum=1&pageSize=100');
  for (const row of diaries.list) { const full = await api('/supervision-diaries/' + row.id); if (String(full.construction || '').includes('sourceId=' + fixture.documentId)) { diaryId = row.id; break; } }
  assert.ok(diaryId, '应找到新双向验收中已通过浏览器保存旧正文链接的日记');
  const documents = await api('/project-documents?projectId=' + fixture.projectId + '&pageNum=1&pageSize=100');
  const spare = documents.list.find(item => item.id !== fixture.documentId); assert.ok(spare, '应有独立来源删除测试资料');
  const spareUrl = BASE + '/file-reference.html?sourceType=project-documents&sourceId=' + spare.id + '&file=' + encodeURIComponent(spare.filePath);
  const page = await (await fetch(CDP_ORIGIN + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); }); browser = new CDP(ws);
  await browser.send('Page.enable'); await browser.send('Runtime.enable'); await browser.send('Network.enable');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  try {
    await browser.navigate('login.html'); await browser.eval('localStorage.clear();sessionStorage.clear()'); await browser.navigate('login.html');
    await browser.eval(`document.querySelector('#username').value='admin';document.querySelector('#password').value='123456'`); await browser.click('#loginBtn');
    await browser.wait(`!!window.App&&!!App.getToken()&&!location.pathname.endsWith('login.html')`, '真实登录');
    await openEdit(diaryId);
    await check('旧稳定链接真实回显，正文引用计数独立且不含凭证', async () => {
      await browser.wait(`document.querySelector('${editor} a[data-fd-ref]')`, '旧链接回显');
      assert.equal(await linkCount(), 1); assert.equal(await referenceCount(fixture.documentId), 1);
      const data = await browser.eval(`(()=>{const a=document.querySelector('${editor} a[data-fd-ref]');return{href:a.getAttribute('href'),name:a.textContent,body:document.querySelector('#fwF-construction').value}})()`);
      assert.ok(data.href.includes('file-reference.html?sourceType=project-documents&sourceId=' + fixture.documentId)); assert.ok(data.name.includes(fixture.name)); assert.ok(data.body.includes('双向关联正文'));
      assert.ok(!/ticket=|token=|signature=/.test(data.href)); return { href: data.href };
    });
    await check('原生粘贴重复链接保留 surrounding 文本，保存后仍只计一篇引用', async () => {
      await paste(fixture.stableUrl, 2); assert.ok((await browser.eval(`document.querySelector('#fwF-construction').value`)).includes('双向关联正文'));
      await save(); assert.equal(await referenceCount(fixture.documentId), 1); assert.equal(await linkCount(), 2);
    });
    await check('删除仅移除选中的重复链接，Ctrl+Z 撤销与 Ctrl+Y 重做均有效', async () => {
      await selectLink(1); await browser.eval(`(()=>{document.execCommand('delete');document.querySelector(${JSON.stringify(editor)}).dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));})()`);
      await browser.wait(`document.querySelectorAll('${editor} a[data-fd-ref]').length===1`, '删除重复链接');
      await key('z'); await browser.wait(`document.querySelectorAll('${editor} a[data-fd-ref]').length===2`, '撤销恢复');
      await key('y'); await browser.wait(`document.querySelectorAll('${editor} a[data-fd-ref]').length===1`, '重做删除'); await save();
      assert.equal(await referenceCount(fixture.documentId), 1);
    });
    await check('复制选中链接只复制稳定地址，不泄露票据或登录令牌', async () => {
      await selectLink(0); const copied = await browser.eval(`(()=>{const data=new DataTransfer();document.querySelector(${JSON.stringify(editor)}).dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return{plain:data.getData('text/plain'),html:data.getData('text/html')}})()`);
      assert.ok(copied.plain.includes('file-reference.html?sourceType=project-documents&sourceId=' + fixture.documentId)); assert.ok(copied.html.includes('class="fd-file-link"'));
      assert.ok(!/ticket=|token=|signature=/.test(copied.plain + copied.html));
    });
    await check('已登录稳定链接经来源授权后打开真实原件', async () => {
      const stablePage = fixture.stableUrl.slice(BASE.length + 1);
      await browser.navigate(stablePage, `location.pathname.startsWith('/api/files/') && location.search.includes('sourceId=${fixture.documentId}')`);
      await browser.wait(`location.pathname.startsWith('/api/files/') && document.body.textContent.includes('监理日记双向关联验收原件')`, '授权打开原件');
      assert.ok((await browser.eval('location.href')).includes('/api/files/'));
    });
    await check('未登录访问跳转登录，登录后沿安全 returnTo 完成授权回跳', async () => {
      await browser.navigate('supervision-diary.html'); await browser.wait(`!!window.App&&!!App.getToken()`, '返回应用页面');
      await browser.eval(`sessionStorage.clear();localStorage.clear();location.href=${JSON.stringify(fixture.stableUrl)}`);
      await browser.wait(`location.pathname.endsWith('login.html') && document.readyState==='complete'`, '登录回跳页');
      const target = await browser.eval('App.loginTarget()'); assert.ok(target.startsWith('file-reference.html?sourceType=project-documents&sourceId=' + fixture.documentId)); assert.ok(!/ticket=|token=|signature=/.test(target));
      await browser.eval(`document.querySelector('#username').value='admin';document.querySelector('#password').value='123456'`); await browser.click('#loginBtn');
      await browser.wait(`location.pathname.startsWith('/api/files/') && document.body.textContent.includes('监理日记双向关联验收原件')`, '登录后授权原件'); await browser.shot('01-登录回跳真实原件');
    });
    await openEdit(diaryId); await paste(spareUrl, 2); await save(); assert.equal(await referenceCount(spare.id), 1);
    deletedDocumentId = spare.id; await api('/project-documents/' + spare.id, 'DELETE');
    await check('来源资料删除后旧链接标记失效，正文稳定地址仍原样保留', async () => {
      await openEdit(diaryId); await browser.wait(`document.querySelector('${editor} a[data-fd-ref].fd-file-unavailable')`, '失效标记');
      const state = await browser.eval(`(()=>{const links=Array.from(document.querySelectorAll('${editor} a[data-fd-ref]'));return{count:links.length,unavailable:links.filter(a=>a.classList.contains('fd-file-unavailable')).map(a=>({href:a.getAttribute('href'),mark:a.getAttribute('data-unavailable')})),body:document.querySelector('#fwF-construction').value}})()`);
      assert.equal(state.count, 2); assert.equal(state.unavailable.length, 1); assert.ok(state.unavailable[0].href.includes('sourceId=' + spare.id)); assert.equal(state.unavailable[0].mark, '资料已删除／不可用');
      assert.ok(state.body.includes('sourceId=' + spare.id) && state.body.includes('sourceId=' + fixture.documentId)); await browser.shot('02-来源删除链接失效');
    });
    await check('无关正文保存不复活已删来源，有效旧引用计数保持不变', async () => {
      await browser.click(editor); await browser.send('Input.insertText', { text: '来源删除后仍可保存' }); await save();
      assert.equal(await referenceCount(fixture.documentId), 1); await api('/project-documents/' + spare.id + '/diary-references', 'GET', undefined, 404);
    });
    await check('移除旧正文链接计数归零但新绑定不变，重新粘贴后旧计数恢复', async () => {
      await browser.eval(`(()=>{const el=document.querySelector(${JSON.stringify(editor)});el.querySelectorAll('a[data-fd-ref]').forEach(a=>a.remove());el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));})()`);
      await browser.wait(`document.querySelectorAll('${editor} a[data-fd-ref]').length===0`, '移除全部旧链接'); await save();
      assert.equal(await referenceCount(fixture.documentId), 0); assert.equal((await api('/supervision-diaries/' + diaryId + '/related-attachments')).count, 1);
      await paste(fixture.stableUrl, 1); await save(); assert.equal(await referenceCount(fixture.documentId), 1); assert.equal((await api('/supervision-diaries/' + diaryId + '/related-attachments')).count, 1);
    });
    await check('另一篇日记保存旧链接增加引用，浏览器删除日记后计数立即清理', async () => {
      const before = (await api('/supervision-diaries?projectId=' + fixture.projectId + '&pageNum=1&pageSize=100')).list.map(item => item.id);
      await newDiary(); await paste(fixture.stableUrl, 1); await save();
      const after = await api('/supervision-diaries?projectId=' + fixture.projectId + '&pageNum=1&pageSize=100'); const created = after.list.find(item => !before.includes(item.id)); assert.ok(created, '应创建第二篇日记');
      assert.equal(await referenceCount(fixture.documentId), 2); await browser.wait(`!document.querySelector('#fwDelete').hidden`, '草稿删除按钮'); await browser.click('#fwDelete');
      await browser.wait(`document.body.textContent.includes('删除本人草稿？') && document.querySelector('[data-act="ok"]')`, '删除确认弹窗'); await browser.click('[data-act="ok"]');
      await browser.wait(`document.querySelector('#fwEditor').hidden`, '删除关闭编辑器'); assert.equal(await referenceCount(fixture.documentId), 1);
    });
    await check('全程无 JavaScript 异常和非预期接口错误', async () => {
      const unexpected = browser.httpErrors.filter(error => !(error.status === 404 && deletedDocumentId && error.url.includes('/files/reference-access') && error.url.includes('sourceId=' + deletedDocumentId)));
      assert.deepEqual(browser.errors, []); assert.deepEqual(unexpected, []); return { expectedDeletedSource404: browser.httpErrors.length };
    });
    console.log('旧正文引用浏览器回归合计 ' + results.length + '/' + results.length + ' 通过');
  } catch (error) {
    results.push({ name: '阻塞', pass: false, error: error.message }); console.error(error); await browser.shot('FAIL-current').catch(() => {});
    fs.writeFileSync(path.join(OUT, 'failure-dom.txt'), await browser.eval('document.body.innerText').catch(() => '')); process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ fixture: fixture.run, diaryId, results, errors: browser.errors, httpErrors: browser.httpErrors }, null, 2));
    console.log('证据目录：' + OUT); browser.ws.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
