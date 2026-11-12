/* 巡视专用检查项视图，独立于通用字段采集和审核状态机。 */
(function () {
  'use strict';
  const C = window.InspectionChecklist;
  window.InspectionChecklistView = function (host, context) {
    const esc = App.escape;
    let data, error = '', panel = null, alive = true;
    const selected = new Set();
    try { data = C.parse(context.raw()); } catch (e) { error = e.message; }
    const editable = () => alive && !context.readOnly && !context.busy() && !error;
    const changed = () => { context.change(JSON.stringify(data)); summary(); };
    const summary = () => { const el = host.querySelector('[data-ic-summary]'); if (el) el.textContent = C.summary(JSON.stringify(data)); };
    const showError = e => { context.error(e); const el = host.querySelector(panel ? '[data-ic-panel] [data-ic-error]' : '[data-ic-error]'); if (el) { el.textContent = e.message; el.focus(); } };
    const run = fn => async event => { try { await fn(event); } catch (e) { showError(e); } };
    const btn = (action, text, extra) => '<button type="button" data-ic-action="' + action + '" ' + (extra || '') + '>' + esc(text) + '</button>';
    const field = (key, label, value, read, problem) => '<label class="ic-field">' + esc(label)
      + '<textarea class="fd-textarea" maxlength="10000" data-' + (problem ? 'problem' : 'ic') + '-field="' + key + '"' + (read ? ' readonly' : '') + '>' + esc(value || '') + '</textarea></label>';
    // 检查项照片是记录凭证：与问题附件分开存放，共用每份巡视 50 个附件的上限
    const fileTotal = () => data.items.reduce((n, i) => n + (i.photos || []).length
      + i.problems.reduce((s, p) => s + p.attachments.length, 0), 0);
    const photoCell = (item, read) => '<div class="ic-photo-list">' + (item.photos || []).map(f => '<div class="ic-photo-item">'
      + '<img alt="" data-ic-photo-src="' + esc(f.url) + '"><span>' + esc(f.name || '现场照片') + '</span>'
      + btn('photo-file', '查看', 'data-url="' + esc(f.url) + '"')
      + (read ? '' : btn('remove-photo', '移除', 'data-url="' + esc(f.url) + '"')) + '</div>').join('')
      + ((item.photos || []).length ? '' : '<span class="ic-empty-mini">未上传</span>') + '</div>'
      + (read ? '' : '<label class="ic-upload">添加照片<input type="file" multiple accept="image/*" data-ic-photo="' + esc(item.id) + '"></label>');
    function render() {
      const read = context.readOnly;
      if (error) { host.innerHTML = '<h3>检查项</h3><p role="alert">' + esc(error) + '</p><pre>' + esc(context.raw()) + '</pre>'; return; }
      host.innerHTML = '<div class="ic-toolbar"><h3>检查项</h3>' + (read ? '' : btn('add', '添加检查项') + btn('delete-selected', '删除勾选项')) + '</div>'
        + '<p class="ic-stats" data-ic-summary role="status"></p><p class="fd-hint">检查项手动添加。提交前请为每项选择检查结果；点击“问题”即可直接填写问题说明，无需再次添加。</p>'
        + '<p class="fd-error" data-ic-error role="alert" tabindex="-1"></p>'
        + (data.items.length ? '<table class="ic-table"><thead><tr><th>选择</th><th>检查内容</th><th>检查结果</th><th>现场照片</th><th>问题与操作</th></tr></thead><tbody>'
          + data.items.map((item, index) => '<tr data-ic-id="' + esc(item.id) + '"><td data-label="序号">' + (read ? '' : '<input type="checkbox" data-ic-select="' + item.id + '" aria-label="勾选第 ' + (index + 1) + ' 项"' + (selected.has(item.id) ? ' checked' : '') + '> ') + (index + 1) + '</td>'
            + '<td>' + field('content', '检查内容（提交必填）', item.content, read) + '</td>'
            + '<td><fieldset class="ic-results"><legend>检查结果</legend>' + Object.keys(C.results).map(result => '<label><input type="radio" name="result-' + item.id + '" data-ic-field="result" value="' + result + '"' + (item.result === result ? ' checked' : '') + (read ? ' disabled' : '') + '> ' + C.results[result] + '</label>').join('') + '</fieldset></td>'
            + '<td class="ic-photos">' + photoCell(item, read) + '</td>'
            + '<td class="ic-actions">' + btn('problems', '问题（' + item.problems.length + '）') + (read ? '' : btn('delete', '删除此项')) + '</td></tr>').join('') + '</tbody></table>'
          : '<div class="ic-empty">未录入检查项' + (read ? '' : '，点击“添加检查项”开始逐项记录。') + '</div>')
        + '<div data-ic-panel></div><pre class="ic-print">' + esc(C.format(JSON.stringify(data))) + '</pre>';
      summary();
      host.onclick = run(click);
      host.oninput = run(input);
      host.onchange = run(event => {
        if (event.target.dataset.icSelect) { if (event.target.checked) selected.add(event.target.dataset.icSelect); else selected.delete(event.target.dataset.icSelect); }
        else if (event.target.tagName === 'SELECT' || event.target.type === 'radio') input(event);
      });
      host.querySelectorAll('[data-ic-photo]').forEach(el => { el.onchange = event => { event.stopPropagation(); run(async () => {
        if (!editable() || panel) return;
        const item = data.items.find(i => i.id === el.dataset.icPhoto);
        const files = Array.from(event.target.files || []); event.target.value = '';
        if (!item || !files.length) return;
        if ((item.photos || []).length + files.length > 10) throw new Error('每项最多 10 张检查项照片');
        if (fileTotal() + files.length > 50) throw new Error('每份巡视最多 50 个附件（含检查项照片与问题附件）');
        item.photos = item.photos || [];
        for (const file of files) {
          const remote = await context.upload(file);
          if (!alive || panel) return;
          if (!item.photos.some(f => f.url === remote.url)) item.photos.push(remote);
          changed();
        }
        render();
      })(event); }; });
      host.querySelectorAll('img[data-ic-photo-src]').forEach(img => {
        const missing = () => { img.alt = '照片不可预览'; };
        if (!App.fileUrl) { missing(); return; }
        App.fileUrl(img.dataset.icPhotoSrc).then(link => { if (alive && img.isConnected) img.src = link; }).catch(missing);
      });
    }
    function input(event) {
      const el = event.target;
      if (!editable()) return;
      if (el.dataset.problemField && panel) {
        const problem = panel.problems.find(p => p.id === el.closest('[data-problem-id]').dataset.problemId);
        problem[el.dataset.problemField] = el.value; panel.dirty = true; return;
      }
      if (!el.dataset.icField || panel) return;
      const item = data.items.find(i => i.id === el.closest('[data-ic-id]').dataset.icId);
      item[el.dataset.icField] = el.value;
      changed();
    }
    async function click(event) {
      const el = event.target.closest('[data-ic-action]');
      if (!el || !host.contains(el)) return;
      const action = el.dataset.icAction;
      if (action === 'file' || action === 'photo-file') { context.openFile(el.dataset.url); return; }
      if (action === 'cancel-problems') {
        const current = panel;
        if (current && current.dirty && !await App.confirm('放弃尚未确认的问题修改？已保存的检查项和问题保持不变。', { danger: false })) return;
        if (!alive || panel !== current) return;
        const itemId = panel && panel.itemId; panel = null; render(); focusProblemButton(itemId); return;
      }
      if (action === 'problems') {
        if (panel) throw new Error('请先确认或取消当前问题编辑');
        const item = data.items.find(i => i.id === el.closest('[data-ic-id]').dataset.icId);
        panel = { itemId: item.id, content: item.content, problems: C.clone(item.problems), dirty: false };
        // 点开即给出问题说明输入框；已有问题只聚焦，不重复新增
        const quick = editable();
        let problem = null;
        try { problem = quick && !panel.problems.length ? appendProblem() : null; }
        catch (e) { panel = null; throw e; }
        const focusId = quick ? (problem || panel.problems[0]).id : null;
        renderPanel(focusId); return;
      }
      if (!editable()) return;
      if (action === 'add') {
        guard(); if (data.items.length >= 100) throw new Error('最多 100 个检查项');
        data.items.push(C.newItem()); changed(); render();
        const inputs = host.querySelectorAll('[data-ic-field="content"]'); inputs[inputs.length - 1].focus(); return;
      }
      if (action === 'remove-photo') {
        guard(); const item = data.items.find(i => i.id === el.closest('[data-ic-id]').dataset.icId);
        if (!item) return;
        item.photos = (item.photos || []).filter(f => f.url !== el.dataset.url); changed(); render(); return;
      }
      if (action === 'delete' || action === 'delete-selected') {
        guard();
        const before = JSON.stringify(data);
        const ids = action === 'delete' ? new Set([el.closest('[data-ic-id]').dataset.icId]) : new Set(selected);
        const removed = data.items.filter(i => ids.has(i.id)); if (!removed.length) throw new Error('请先勾选检查项');
        const count = removed.reduce((n, i) => n + i.problems.length, 0);
        if (!await App.confirm('删除 ' + removed.length + ' 个检查项及关联的 ' + count + ' 个问题？仅移除引用，不删除附件文件。')) return;
        if (!editable() || panel) return;
        if (before !== JSON.stringify(data)) throw new Error('检查内容已变化，请重新确认删除');
        data.items = data.items.filter(i => !ids.has(i.id)); selected.clear(); changed(); render(); return;
      }
      if (!panel) return;
      if (action === 'add-problem') {
        const problem = appendProblem(); renderPanel(problem.id);
      } else if (action === 'delete-problem') {
        const current = panel;
        if (!await App.confirm('移除此问题及其附件引用？')) return;
        if (!editable() || panel !== current) return;
        const id = el.closest('[data-problem-id]').dataset.problemId;
        panel.problems = panel.problems.filter(p => p.id !== id); panel.dirty = true; renderPanel();
      } else if (action === 'confirm-problems') {
        const next = C.clone(data); next.items.find(i => i.id === panel.itemId).problems = panel.problems;
        C.validate(next, false); data = next; changed(); const itemId = panel.itemId; panel = null; render(); focusProblemButton(itemId);
      }
    }
    function appendProblem() {
      if (panel.problems.length >= 20) throw new Error('每项最多 20 个问题');
      const count = data.items.filter(i => i.id !== panel.itemId).reduce((n, i) => n + i.problems.length, 0) + panel.problems.length;
      if (count >= 200) throw new Error('每份巡视最多 200 个问题');
      const problem = C.newProblem(panel); panel.problems.push(problem); panel.dirty = true;
      return problem;
    }
    function renderPanel(focusProblemId) {
      const p = panel, read = context.readOnly;
      const box = host.querySelector('[data-ic-panel]');
      box.innerHTML = '<div class="ic-overlay"><div class="fd-modal ic-dialog" role="dialog" aria-modal="true" aria-label="检查项问题"><div class="fd-header"><h3 class="fd-title">检查项问题</h3>' + btn('cancel-problems', '关闭') + '</div><div class="fd-body">'
        + '<p class="ic-context">' + esc(p.content || '尚未填写检查内容') + '</p><p class="fd-hint">问题确认后仅回填本机草稿，仍需保存巡视。发现人由服务器按登录身份记录。</p>'
        + '<p class="fd-error" data-ic-error role="alert" tabindex="-1"></p>'
        + p.problems.map((problem, index) => '<div class="ic-problem" data-problem-id="' + problem.id + '"><h4>问题 ' + (index + 1) + '</h4>'
          + field('description', '问题说明', problem.description, read, true)
          + '<p>发现人：' + esc(problem.foundByName || (App.getUser().userName || '当前填写人') + '（未同步）') + '</p>'
          + problem.attachments.map(f => '<div class="ic-file"><span>' + esc(f.name || '附件') + '</span>' + btn('file', '查看', 'data-url="' + esc(f.url) + '"') + '</div>').join('')
          + (read ? '' : btn('delete-problem', '删除问题')) + '</div>').join('')
        + (!p.problems.length ? '<p class="ic-empty">尚无问题，点击“添加问题”开始记录。</p>' : '')
        + (read ? '' : btn('add-problem', '添加问题'))
        + '</div><div class="fd-footer">'
        + (read ? '' : btn('confirm-problems', '确认问题')) + btn('cancel-problems', read ? '关闭' : '取消修改') + '</div></div></div>';
      const input = focusProblemId ? box.querySelector('[data-problem-id="' + focusProblemId + '"] [data-problem-field="description"]') : null;
      const first = input || box.querySelector('button:not(:disabled)'); if (first) first.focus();
    }
    function focusProblemButton(itemId) { const button = host.querySelector('[data-ic-id="' + itemId + '"] [data-ic-action="problems"]'); if (button) button.focus(); }
    host.onkeydown = event => {
      if (!panel) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); const button = host.querySelector('[data-ic-action="cancel-problems"]'); if (button) button.click(); }
      if (event.key === 'Tab') {
        const controls = Array.from(host.querySelectorAll('[data-ic-panel] button:not(:disabled), [data-ic-panel] input:not(:disabled), [data-ic-panel] textarea:not(:disabled), [data-ic-panel] select:not(:disabled)'));
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    function guard() { if (error) throw new Error(error); if (panel) throw new Error('请先确认或取消检查项的问题编辑，再保存、提交或离开巡视'); }
    render();
    return { guard, hasUnsaved: () => !!panel && panel.dirty, destroy() { alive = false; panel = null; host.onkeydown = null; }, print() { guard(); const p = host.querySelector('.ic-print'); p.textContent = C.format(context.raw()); } };
  };
})();
