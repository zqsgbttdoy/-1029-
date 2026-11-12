// 独立 H2 + 独立静态代理 + 无头 Edge/CDP 的双向关联真实验收。
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const fixture = require('./fixture.json'), L = require('../../补后端/miniprogram/utils/diary-links');
const BASE = fixture.base, CDP_ORIGIN = process.env.E2E_CDP || 'http://127.0.0.1:19231', OUT = path.join(__dirname, 'screenshots-' + fixture.run);
fs.mkdirSync(OUT, { recursive: true });
const results = [], sleep = ms => new Promise(r => setTimeout(r, ms));
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
  async wait(expression, label) { for (let i = 0; i < 160; i++) { try { if (await this.eval(expression)) return; } catch (_) {} await sleep(100); } throw new Error('等待超时：' + label); }
  async navigate(page) { await this.send('Page.navigate', { url: BASE + '/' + page }); await this.wait(`location.pathname.endsWith(${JSON.stringify(page.split('?')[0])}) && document.readyState==='complete'`, page); }
  async click(selector) { const box = await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.hidden||el.disabled)throw Error('控件不可点: '+${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`); await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box }); await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box }); }
  async select(selector, value) { await this.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(String(value))};el.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async shot(name, selector) { if (selector) await this.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await sleep(150); const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); }
  async width(width) { await this.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(150); assert.equal(await this.eval('innerWidth'), width); }
}
let s, diaryId, token;
async function api(url, method = 'GET', body, headers = {}) { const r = await fetch(BASE + '/api' + url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); const j = await r.json(); if (!r.ok || j.code !== 200) throw Object.assign(new Error(j.message), { status: r.status }); return j.data; }
async function check(name, fn) { const detail = await fn(); results.push({ name, pass: true, detail }); console.log('PASS ' + name + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); }
const editor = '#fwF-construction + .fd-link-editor';
async function newDiary() { await s.navigate('supervision-diary.html'); await s.wait(`document.querySelector('#fwProject option[value="${fixture.projectId}"]')`, '项目'); await s.select('#fwProject', fixture.projectId); await s.click('#fwNew'); await s.wait(`document.querySelectorAll('.fd-link-editor').length===9`, '九栏组件'); }
async function focusText() { await s.click(editor); await s.eval(`document.querySelector('${editor}').focus()`); }
async function paste() { await s.eval(`(()=>{const el=document.querySelector(${JSON.stringify(editor)});el.focus();const d=new DataTransfer();d.setData('text/plain',${JSON.stringify(fixture.stableUrl)});el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));})()`); await s.wait(`document.querySelector('${editor} a')`, '稳定链接授权'); }
async function save() { await s.click('#fwSave'); await s.wait(`!document.querySelector('#fwSave').disabled && document.querySelector('#fwError').textContent`, '保存回应'); const message = await s.eval(`document.querySelector('#fwError').textContent`); assert.ok(message.includes('服务器草稿已保存'), message); }
async function relatedCount(expected) { const d = await api('/supervision-diaries/' + diaryId + '/related-attachments'); assert.equal(d.count, expected); }
async function legacyCount(expected) { const d = await api('/project-documents/' + fixture.documentId + '/diary-references'); assert.equal(d.total, expected); }
async function openEdit() { await s.navigate('supervision-diary.html'); await s.wait(`document.querySelector('#fwProject option[value="${fixture.projectId}"]')`, '项目'); await s.select('#fwProject', fixture.projectId); await s.select('#fwStatus', 'draft'); await s.wait(`document.querySelector('#fwRows [data-id="${diaryId}"]')`, '日记列表'); await s.click(`#fwRows [data-id="${diaryId}"]`); await s.wait(`document.querySelector('${editor}[contenteditable="true"]')`, '可编辑正文'); }
async function docs() { await s.navigate('project-data-upload.html'); await s.wait(`document.querySelector('#projectSelect option[value="${fixture.projectId}"]')`, '资料项目'); await s.select('#projectSelect', fixture.projectId); await s.wait(`document.querySelector('.tree-node[data-id="${fixture.folderId}"]')`, '目录'); await s.click(`.tree-node[data-id="${fixture.folderId}"]`); await s.wait(`document.querySelectorAll('.existing-file-item').length===20`, '资料列表'); }
async function layout() { return s.eval(`(()=>{const visible=el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';const roots=[document.documentElement,...document.querySelectorAll('#fwEditor:not([hidden]) .fd-modal,#fwEditor:not([hidden]) .fd-body,.layout')];return roots.filter(visible).filter(el=>el.scrollWidth>el.clientWidth+2).map(el=>({tag:el.className||el.tagName,scroll:el.scrollWidth,client:el.clientWidth}));})()`); }
(async () => {
  const page = await (await fetch(CDP_ORIGIN + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); }); s = new CDP(ws);
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Network.enable'); await s.width(1440);
  try {
    await s.navigate('login.html'); await s.eval(`document.querySelector('#username').value='admin';document.querySelector('#password').value='123456'`); await s.click('#loginBtn'); await s.wait(`!!window.App&&!!App.getToken()&&!location.pathname.endsWith('login.html')`, '真实登录'); token = await s.eval('App.getToken()');
    await check('真实登录且只访问独立环境', async () => assert.equal(await s.eval('location.origin'), BASE));
    await newDiary();
    await check('旧五源关联资源区已移除，三组当天业务与真实附件齐全', async () => {
      await s.wait(`document.querySelectorAll('.diary-day-group').length===3&&document.querySelector('[data-document-attach="${fixture.documentId}"]')`, '当天工作台');
      assert.equal(await s.eval(`!!document.querySelector('#fwResources')`), false);
      const text = await s.eval(`document.querySelector('#fwDiaryDay').textContent`);
      for (const value of [fixture.dailyText, fixture.noticeText, fixture.contactText, '巡检真实附件.txt', fixture.name]) assert.ok(text.includes(value), value);
      assert.ok(!text.includes('草稿巡检不应显示') && !text.includes('草稿通知不应显示'));
    });
    await check('复制不改正文，剪贴板不可用时提供手动选中文本', async () => {
      await s.eval(`window.__originalClipboard=navigator.clipboard;Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined})`);
      await s.click('[data-diary-copy="dailyInspections:0"]');
      const value = await s.eval(`document.querySelector('.diary-manual-copy').value`); assert.ok(value.includes(fixture.dailyText));
      assert.equal(await s.eval(`document.querySelector('#fwF-construction').value`), '');
      assert.ok(await s.eval(`document.querySelector('.diary-manual-copy').selectionEnd>0`));
      await s.eval(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:window.__originalClipboard})`);
    });
    await check('真实复制当天通知摘要', async () => {
      await s.send('Browser.grantPermissions', { origin: BASE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
      await s.click('[data-diary-copy="supervisionNotices:0"]'); await s.wait(`document.querySelector('[data-diary-copy="supervisionNotices:0"]').textContent==='已复制'`, '复制完成');
      assert.ok((await s.eval('navigator.clipboard.readText()')).includes('通知单关键内容'));
    });
    await check('首次关联自动保存服务器草稿并实时绑定', async () => {
      await s.click(`[data-document-attach="${fixture.documentId}"]`); await s.wait(`document.querySelector('[data-document-detach="${fixture.documentId}"]')`, '首次关联');
      const page = await api('/supervision-diaries?projectId=' + fixture.projectId); assert.equal(page.total, 1); diaryId = page.list[0].id;
      assert.equal(page.list[0].status, 'draft'); await relatedCount(1);
      assert.equal(await s.eval(`document.querySelector('#fwDiaryBadge').textContent`), '已关联 1 份附件');
      await s.shot('01-首次关联与当天摘要', '#fwDiaryDay');
    });
    await check('附件徽标展开实际资料，正文保存沿用最新锁版本', async () => {
      await s.click('#fwDiaryBadge'); await s.wait(`document.querySelector('#fwDiaryRelated [data-related-open]')`, '实际关联列表');
      assert.ok((await s.eval(`document.querySelector('#fwDiaryRelated').textContent`)).includes(fixture.name));
      await focusText(); await s.send('Input.insertText', { text: '双向关联正文' }); await paste(); await save(); await legacyCount(1); await relatedCount(1);
    });
    await check('实时取消只解除新绑定，旧正文引用保持独立', async () => {
      await s.click(`#fwDiaryDay [data-document-detach="${fixture.documentId}"]`); await s.wait(`document.querySelector('[data-document-attach="${fixture.documentId}"]')`, '取消关联');
      await relatedCount(0); await legacyCount(1); assert.equal(await s.eval(`document.querySelector('#fwDiaryBadge').textContent`), '已关联 0 份附件');
      await s.click(`[data-document-attach="${fixture.documentId}"]`); await s.wait(`document.querySelector('[data-document-detach="${fixture.documentId}"]')`, '重新关联'); await relatedCount(1);
    });
    await check('关闭后重新编辑，绑定和正文均真实回显', async () => { await s.click('#fwClose'); await openEdit(); await s.wait(`document.querySelector('#fwDiaryBadge').textContent==='已关联 1 份附件'`, '徽标回显'); assert.ok((await s.eval(`document.querySelector('#fwF-construction').value`)).includes('双向关联正文')); });
    await check('只读详情徽标可查看但无关联写操作', async () => {
      await s.navigate('supervision-diary.html?id=' + diaryId + '&readonly=true'); await s.wait(`document.querySelector('${editor}[contenteditable="false"]')`, '只读正文');
      await s.wait(`document.querySelector('#fwDiaryBadge').textContent==='已关联 1 份附件'`, '只读关联数');
      await s.eval(`document.querySelector('#fwDiaryBadge').click()`); await s.wait(`document.querySelector('#fwDiaryRelated [data-related-open]')`, '只读关联列表');
      assert.equal(await s.eval(`!!document.querySelector('[data-document-attach],[data-document-detach]')`), false);
      assert.equal(await s.eval(`document.querySelector('#fwSave').hidden&&document.querySelector('#fwSubmit').hidden`), true);
    });
    await docs();
    await check('上传页已关联筛选、日记摘要和旧正文引用并存', async () => {
      await s.select('#diaryFilter', 'linked'); await s.wait(`document.querySelectorAll('.existing-file-item').length===1`, '已关联筛选');
      assert.equal(await s.eval(`document.querySelector('#existingCount').textContent`), '1');
      const link = await s.eval(`document.querySelector('.diary-binding.linked').getAttribute('href')`); assert.equal(link, 'supervision-diary.html?id=' + diaryId + '&readonly=true');
      assert.ok((await s.eval(`document.querySelector('.diary-binding.linked').textContent`)).includes(fixture.date));
      assert.ok((await s.eval(`document.querySelector('.fd-reference-count').textContent`)).includes('被 1 篇监理日记引用'));
      await s.shot('02-上传页已关联筛选', '#existingFileList');
    });
    await check('上传页未关联筛选与分页有效，双向深链到只读日记', async () => {
      await s.navigate('supervision-diary.html?id=' + diaryId + '&readonly=true'); await s.wait(`document.querySelector('${editor}[contenteditable="false"]')`, '资料到日记深链'); await docs();
      await s.select('#diaryFilter', 'unlinked'); await s.wait(`document.querySelectorAll('.existing-file-item').length===20&&document.querySelector('#existingCount').textContent==='22'`, '未关联筛选');
      assert.equal(await s.eval(`document.querySelectorAll('.diary-binding.linked').length`), 0);
      await s.click('#documentsNext'); await s.wait(`document.querySelectorAll('.existing-file-item').length===2`, '未关联第二页');
    });
    await check('目录来源仅直接上传分组筛选，其他来源不伪造日记字段', async () => {
      await s.navigate('sub-item-database.html'); await s.wait(`document.querySelector('#projectSelect option[value="${fixture.projectId}"]')`, '目录项目'); await s.select('#projectSelect', fixture.projectId);
      await s.wait(`document.querySelector('.tree-node[data-id="${fixture.folderId}"]')`, '目录树'); await s.click(`.tree-node[data-id="${fixture.folderId}"]`);
      await s.wait(`document.querySelector('#sourceModal.show .source-diary-filter')`, '数据来源');
      assert.equal(await s.eval(`document.querySelectorAll('.source-diary-filter').length`), 1);
      const before = await s.eval(`document.querySelector('#sourceSummary').textContent`); await s.select('.source-diary-filter', 'linked');
      await s.wait(`document.querySelectorAll('.source-diary-state.linked').length===1&&Array.from(document.querySelectorAll('.source-group')).find(g=>g.querySelector('.source-diary-filter')).querySelectorAll('.source-record').length===1`, '目录已关联筛选');
            assert.equal(await s.eval(`document.querySelectorAll('.source-group').length`), 3);
      assert.equal(await s.eval(`document.querySelector('#sourceSummary').textContent`), before);
      assert.equal(await s.eval(`document.querySelector('.source-diary-link').getAttribute('href')`), 'supervision-diary.html?id=' + diaryId + '&readonly=true');
      await s.select('.source-diary-filter', 'unlinked'); await s.wait(`document.querySelectorAll('.source-diary-state.unlinked').length===22`, '目录未关联筛选');
      assert.ok(await s.eval(`Array.from(document.querySelectorAll('.source-group')).some(g=>g.textContent.includes('工作联系单')&&!g.querySelector('.source-diary-state'))`));
      await s.shot('03-目录来源未关联筛选', '#sourceModal');
    });
    for (const width of [375, 320]) { await s.width(width); assert.deepEqual(await layout(), []); await s.shot('04-' + width + '目录来源', '#sourceModal'); }
    await check('全程无 JavaScript 异常和接口 4xx/5xx', async () => { assert.deepEqual(s.errors, []); assert.deepEqual(s.httpErrors, []); });
    console.log('合计 ' + results.length + '/' + results.length + ' 通过');
  } catch (e) {
    results.push({ name: '阻塞', pass: false, error: e.message }); console.error(e); await s.shot('FAIL-current').catch(() => {});
    fs.writeFileSync(path.join(OUT, 'failure-dom.txt'), await s.eval('document.body.innerText').catch(() => '')); process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ fixture: fixture.run, diaryId, results, errors: s.errors, httpErrors: s.httpErrors }, null, 2));
    console.log('证据目录：' + OUT); s.ws.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
