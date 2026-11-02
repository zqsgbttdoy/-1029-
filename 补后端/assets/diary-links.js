/* 日记专用正文链接与资源候选区，所有动态内容均经文字节点或白名单链接渲染。 */
(function () {
  'use strict';
  const L = window.DiaryLinks, esc = App.escape;
  const base = () => new URL('.', location.href).href.replace(/\/$/, '');
  const access = item => App.apiFetch('/files/reference-access?' + App.buildQuery({ sourceType: item.sourceType, sourceId: item.sourceId, file: item.file }));
  function html(text) {
    return L.parse(text).map(n => n.type === 'text' ? esc(n.text) : '<a class="fd-file-link" href="' + esc(L.stable(n)) + '" target="_blank" rel="noopener">' + esc(n.name) + '</a>').join('');
  }
  function mark(link, error) {
    const message = error.code === 403 || error.code === 404 ? '资料已删除／不可用' : '联网后点击重新核验';
    link.classList.add('fd-file-unavailable'); link.title = message + '：' + error.message;
    link.setAttribute('data-unavailable', message);
  }
  async function open(item, element, error) {
    const uid = String((App.getUser() || {}).userId), token = App.getToken();
    const target = window.open('about:blank', '_blank');
    if (target) target.opener = null;
    try {
      const data = await access(item);
      if (String((App.getUser() || {}).userId) !== uid || App.getToken() !== token) { if (target) target.close(); return; }
      if (element) { element.classList.remove('fd-file-unavailable'); element.removeAttribute('data-unavailable'); element.removeAttribute('title'); }
      if (target) target.location = data.url;
      else throw new Error('请允许打开文件窗口后重试');
    } catch (e) { if (target) target.close(); if (element) mark(element, e); error(e); }
  }
  function render(element, text, error) {
    element.innerHTML = html(text);
    const uid = String((App.getUser() || {}).userId);
    element.querySelectorAll('a.fd-file-link').forEach(a => {
      const item = L.target(a.getAttribute('href'));
      a.onclick = e => { e.preventDefault(); void open(item, a, error); };
      access(item).catch(e => { if (element.contains(a) && String((App.getUser() || {}).userId) === uid) mark(a, e); });
    });
  }
  function clipboardNodes(text, markup) {
    if (markup) {
      const doc = new DOMParser().parseFromString(markup, 'text/html');
      function walk(node) {
        if (node.nodeType === 3) return node.nodeValue;
        if (node.nodeType !== 1) return '';
        if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.tagName)) return node.textContent || '';
        if (node.tagName === 'A') {
          try { const item = L.target(node.getAttribute('href'), base()); item.name = node.textContent || item.name; return L.format(item); } catch (e) { return node.textContent || ''; }
        }
        if (node.tagName === 'BR') return '\n';
        return Array.from(node.childNodes).map(walk).join('') + (/^(DIV|P|LI)$/.test(node.tagName) ? '\n' : '');
      }
      text = Array.from(doc.body.childNodes).map(walk).join('');
    }
    return L.pasted(text, base());
  }
  function mount(textarea, options) {
    const box = document.createElement('div'), entries = new Map();
    let version = 0, sequence = 0, disposed = false, composing = false, converting = false;
    let snapshot, compositionSnapshot;
    const undo = [], redo = [];
    box.className = 'fd-link-editor fd-textarea'; box.setAttribute('role', 'textbox'); box.setAttribute('aria-multiline', 'true');
    box.setAttribute('aria-label', textarea.getAttribute('aria-label') || options.label || '日记正文');
    box.setAttribute('data-placeholder', textarea.placeholder || '填写正文，可在光标位置粘贴文件链接');
    box.contentEditable = options.readOnly ? 'false' : 'true';
    textarea.hidden = true; textarea.insertAdjacentElement('afterend', box);
    const valid = () => !disposed && options.valid() && !options.readOnly;
    function nodesHtml(nodes) {
      return nodes.map(n => {
        if (n.type === 'text') return esc(n.text);
        const id = 'file-' + (++sequence); entries.set(id, Object.assign({}, n));
        return '<a data-fd-ref="' + id + '" class="fd-file-link" contenteditable="false" href="' + esc(L.stable(n)) + '" target="_blank" rel="noopener">' + esc(n.name) + '</a>';
      }).join('');
    }
    function read(node) {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.nodeType !== 1 && node.nodeType !== 11) return '';
      const item = node.getAttribute && entries.get(node.getAttribute('data-fd-ref'));
      if (item) return L.format(item);
      if (node.nodeName === 'BR') return '\n';
      let value = '';
      Array.from(node.childNodes).forEach(child => {
        if (/^(DIV|P)$/.test(child.nodeName) && value && !value.endsWith('\n')) value += '\n';
        value += read(child);
      });
      return value;
    }
    function capture() {
      const result = { html: box.innerHTML, value: read(box) }, selection = window.getSelection();
      function point(node, offset) {
        const path = [];
        while (node && node !== box) { const parent = node.parentNode; if (!parent) return null; path.unshift(Array.prototype.indexOf.call(parent.childNodes, node)); node = parent; }
        return node === box ? { path, offset } : null;
      }
      if (selection.rangeCount) {
        const range = selection.getRangeAt(0);
        result.start = point(range.startContainer, range.startOffset); result.end = point(range.endContainer, range.endOffset);
      }
      return result;
    }
    function remember(stack, value) { stack.push(value); if (stack.length > 50) stack.shift(); }
    function changed() {
      if (disposed) return;
      const next = capture();
      if (snapshot && next.value !== snapshot.value && !composing && !converting) { remember(undo, snapshot); redo.length = 0; }
      snapshot = next;
      version++; textarea.value = next.value;
      options.change();
      if (textarea.value.length > 60000) options.error(new Error('本栏超过 60000 字符，请缩短后保存；输入内容已保留'));
    }
    function restore(from, to) {
      if (!valid() || composing || !from.length) return;
      remember(to, capture()); const previous = from.pop();
      version++; box.innerHTML = previous.html; box.focus();
      const selection = window.getSelection(), range = document.createRange();
      function point(value) { return value.path.reduce((node, index) => node.childNodes[index], box); }
      try { range.setStart(point(previous.start), previous.start.offset); range.setEnd(point(previous.end), previous.end.offset); }
      catch (_) { range.selectNodeContents(box); range.collapse(false); }
      selection.removeAllRanges(); selection.addRange(range);
      snapshot = capture(); textarea.value = snapshot.value; options.change();
    }
    box.innerHTML = nodesHtml(L.parse(textarea.value)); snapshot = capture();
    box.addEventListener('input', changed);
    box.addEventListener('beforeinput', e => {
      if (!valid()) { e.preventDefault(); return; }
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); if (e.inputType === 'historyUndo') restore(undo, redo); else restore(redo, undo); return; }
      if (!composing) snapshot = capture();
    });
    box.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || composing) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      e.preventDefault(); if (key === 'y' || e.shiftKey) restore(redo, undo); else restore(undo, redo);
    });
    box.addEventListener('compositionstart', () => { compositionSnapshot = capture(); composing = true; version++; });
    box.addEventListener('compositionend', () => { composing = false; if (compositionSnapshot && compositionSnapshot.value !== read(box)) { remember(undo, compositionSnapshot); redo.length = 0; } snapshot = capture(); compositionSnapshot = null; changed(); });
    box.addEventListener('drop', e => { e.preventDefault(); options.error(new Error('请用复制粘贴插入正文链接，文件上传请使用下方上传区')); });
    box.addEventListener('click', e => {
      const a = e.target.closest('a[data-fd-ref]');
      if (!a) return;
      e.preventDefault(); const item = entries.get(a.dataset.fdRef); if (item) void open(item, a, options.error);
    });
    function copy(e, cut) {
      const selection = window.getSelection();
      if (!selection.rangeCount || !box.contains(selection.anchorNode) || !box.contains(selection.focusNode)) return;
      if (cut && !valid()) { e.preventDefault(); return; }
      const selected = read(selection.getRangeAt(0).cloneContents());
      if (!selected) return;
      e.preventDefault(); e.clipboardData.setData('text/plain', selected);
      e.clipboardData.setData('text/html', html(selected));
      if (cut) { document.execCommand('delete'); changed(); }
    }
    box.addEventListener('copy', e => copy(e, false)); box.addEventListener('cut', e => copy(e, true));
    box.addEventListener('paste', async e => {
      e.preventDefault(); if (!valid() || composing) return;
      const raw = e.clipboardData.getData('text/plain'), markup = e.clipboardData.getData('text/html');
      let nodes;
      try { nodes = clipboardNodes(raw, markup); } catch (error) { options.error(error); nodes = [{ type: 'text', text: raw }]; }
      const marker = 'paste-' + (++sequence), fallback = raw || L.readable(L.serialize(nodes));
      snapshot = capture();
      document.execCommand('insertHTML', false, '<span data-fd-paste="' + marker + '">' + esc(fallback) + '</span>'); changed();
      const captured = version;
      if (!nodes.some(n => n.type === 'file')) return;
      try {
        const authorized = await Promise.all(nodes.map(async n => {
          if (n.type === 'text') return n;
          const data = await access(n);
          if (String(data.projectId) !== String(options.projectId)) throw new Error('不可关联其他项目文件');
          return Object.assign({}, n, { name: data.name });
        }));
        if (!valid() || captured !== version) return;
        const placeholder = box.querySelector('[data-fd-paste="' + marker + '"]'); if (!placeholder) return;
        const range = document.createRange(); range.selectNode(placeholder);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        converting = true;
        try { document.execCommand('insertHTML', false, nodesHtml(authorized)); changed(); }
        finally { converting = false; }
      } catch (error) { if (valid() && captured === version) options.error(new Error('链接未转换，已保留粘贴内容：' + error.message)); }
    });
    box.querySelectorAll('[data-fd-ref]').forEach(a => access(entries.get(a.dataset.fdRef)).catch(error => {
      if (!disposed && box.contains(a) && options.current()) mark(a, error);
    }));
    return {
      collect() { if (!disposed) textarea.value = read(box); },
      guard() { if (composing) throw new Error('请先完成当前中文输入，再保存'); if (read(box).length > 60000) throw new Error('单个正文栏目不能超过 60000 字符'); },
      cancel() { version++; },
      destroy() { disposed = true; version++; box.remove(); textarea.hidden = false; },
      box
    };
  }
  function resources(container, options) {
    let disposed = false;
    const groups = L.sources.map(([type, name]) => ({ type, name, page: 1, total: 0, sequence: 0, files: [] }));
    container.innerHTML = '<details class="fd-resources" open><summary>关联资源 · 复制后粘贴到正文任意位置</summary><p class="fd-hint">仅展示候选文件；复制或打开不建立引用，保存到服务器后才计数。无附件的来源不生成替代文件。</p><div class="fd-resource-groups"></div></details>';
    const host = container.querySelector('.fd-resource-groups');
    groups.forEach(group => {
      const el = document.createElement('section'); el.className = 'fd-resource-group';
      el.innerHTML = '<h4>' + esc(group.name) + '</h4><div class="fd-resource-filters"><label>开始日期<input type="date" data-filter="dateFrom" value="' + esc(options.date) + '"></label><label>结束日期<input type="date" data-filter="dateTo" value="' + esc(options.date) + '"></label><label>编号／标题<input data-filter="keyword" maxlength="200"></label><button type="button" data-search>查询</button></div><label class="fd-hint">筛选本页附件名<input data-name-filter placeholder="文件名"></label><div data-results role="status"></div><div class="fd-resource-pages"><button type="button" data-prev>上一页</button><span data-page></span><button type="button" data-next>下一页</button></div>';
      host.appendChild(el); group.element = el;
      el.querySelector('[data-search]').onclick = () => { group.page = 1; void load(group); };
      el.querySelector('[data-prev]').onclick = () => { if (group.page > 1) { group.page--; void load(group); } };
      el.querySelector('[data-next]').onclick = () => { if (group.page * 20 < group.total) { group.page++; void load(group); } };
      el.querySelector('[data-name-filter]').oninput = () => { if (group.loaded) draw(group); };
      el.querySelectorAll('[data-filter]').forEach(input => { input.oninput = () => {
        group.sequence++; group.loaded = false;
        el.querySelector('[data-results]').textContent = '筛选条件已改变，请点击查询';
        el.querySelector('[data-page]').textContent = '';
        el.querySelector('[data-prev]').disabled = true; el.querySelector('[data-next]').disabled = true;
      }; });
      void load(group);
    });
    const valid = () => !disposed && options.valid();
    async function load(group) {
      group.loaded = false;
      const seq = ++group.sequence, el = group.element, params = { projectId: options.projectId, sourceType: group.type, pageNum: group.page, pageSize: 20 };
      el.querySelectorAll('[data-filter]').forEach(input => { if (input.value) params[input.dataset.filter] = input.value; });
      if (!params.dateFrom && !params.dateTo) params.date = options.date;
      el.querySelector('[data-results]').textContent = '正在读取…';
      el.querySelector('[data-prev]').disabled = true; el.querySelector('[data-next]').disabled = true;
      try {
        const data = await App.apiFetch('/field/diary-resources?' + App.buildQuery(params));
        if (!valid() || seq !== group.sequence) return;
        group.loaded = true; group.files = data.list; group.total = data.total; draw(group);
      } catch (e) {
        if (!valid() || seq !== group.sequence) return;
        const result = el.querySelector('[data-results]'); result.textContent = '读取失败：' + e.message + ' ';
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.onclick = () => void load(group); result.appendChild(retry);
        el.querySelector('[data-page]').textContent = '总数暂不可用';
      }
    }
    function draw(group) {
      if (!valid()) return;
      const el = group.element, result = el.querySelector('[data-results]'), filter = el.querySelector('[data-name-filter]').value.trim();
      result.replaceChildren();
      if (!group.files.length) result.textContent = '当前条件下无来源记录';
      group.files.forEach(record => {
        const row = document.createElement('div'); row.className = 'fd-resource-record';
        const title = document.createElement('div'); title.textContent = [record.code, record.title, record.date].filter(Boolean).join(' · '); row.appendChild(title);
        const files = record.files.filter(f => !filter || f.name.includes(filter));
        if (!record.files.length || !files.length) { const hint = document.createElement('p'); hint.className = 'fd-hint'; hint.textContent = record.files.length ? '无匹配附件名' : '无可关联文件'; row.appendChild(hint); }
        files.forEach(file => {
          const line = document.createElement('div'); line.className = 'fd-resource-file';
          const a = document.createElement('a'); a.className = 'fd-file-link'; a.textContent = file.name; a.href = L.stable(file); a.target = '_blank'; a.rel = 'noopener';
          a.onclick = e => { e.preventDefault(); if (valid()) void open(file, a, options.error); };
          const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制链接';
          copy.onclick = async () => {
            if (!valid()) return;
            const url = base() + '/' + L.stable(file);
            try { if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error(); await navigator.clipboard.writeText(url); if (valid()) copy.textContent = '已复制'; }
            catch (e) {
              if (!valid()) return;
              let manual = line.querySelector('textarea');
              if (!manual) { manual = document.createElement('textarea'); manual.readOnly = true; manual.className = 'fd-manual-copy'; manual.setAttribute('aria-label', '请手动选择并复制链接'); line.appendChild(manual); }
              manual.value = url; manual.focus(); manual.select();
            }
          };
          line.append(a, copy); row.appendChild(line);
        });
        result.appendChild(row);
      });
      el.querySelector('[data-page]').textContent = '共 ' + group.total + ' 条 · 第 ' + group.page + ' / ' + Math.max(1, Math.ceil(group.total / 20)) + ' 页';
      el.querySelector('[data-prev]').disabled = group.page <= 1; el.querySelector('[data-next]').disabled = group.page * 20 >= group.total;
    }
    return { destroy() { disposed = true; groups.forEach(g => g.sequence++); }, cancel() {
      groups.forEach(g => {
        g.sequence++;
        if (!g.loaded) {
          g.element.querySelector('[data-results]').textContent = '本次读取已取消，可点击查询重新加载';
          g.element.querySelector('[data-page]').textContent = '';
        }
      });
    } };
  }
  window.DiaryLinkView = { html, render, mount, resources, open, access, clipboardNodes };
})();
