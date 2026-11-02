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
    function render() {
      const read = context.readOnly;
      if (error) { host.innerHTML = '<h3>检查项</h3><p role="alert">' + esc(error) + '</p><pre>' + esc(context.raw()) + '</pre>'; return; }
      host.innerHTML = '<div class="ic-toolbar"><h3>检查项</h3>' + (read ? '' : btn('add', '添加检查项') + btn('delete-selected', '删除勾选项')) + '</div>'
        + '<p class="ic-stats" data-ic-summary role="status"></p><p class="fd-hint">检查项手动添加。必检项须在提交前选择结果；选择“不符合”不会自动创建问题。</p>'
        + '<p class="fd-error" data-ic-error role="alert" tabindex="-1"></p>'
        + (data.items.length ? '<table class="ic-table"><thead><tr><th>选择</th><th>检查类别与内容</th><th>检查依据</th><th>必检</th><th>检查结果</th><th>问题与操作</th></tr></thead><tbody>'
          + data.items.map((item, index) => '<tr data-ic-id="' + esc(item.id) + '"><td data-label="序号">' + (read ? '' : '<input type="checkbox" data-ic-select="' + item.id + '" aria-label="勾选第 ' + (index + 1) + ' 项"' + (selected.has(item.id) ? ' checked' : '') + '> ') + (index + 1) + '</td>'
            + '<td>' + field('category', '检查类别', item.category, read) + field('content', '检查内容（提交必填）', item.content, read) + '</td>'
            + '<td><details><summary>检查方法与规范条目</summary>' + field('method', '检查方法', item.method, read) + field('standard', '规范条目', item.standard, read) + '</details></td>'
            + '<td data-label="必检"><select class="fd-select" data-ic-field="required" aria-label="是否必检"' + (read ? ' disabled' : '') + '><option value="true"' + (item.required ? ' selected' : '') + '>是</option><option value="false"' + (!item.required ? ' selected' : '') + '>否</option></select></td>'
            + '<td><fieldset class="ic-results"><legend>检查结果</legend>' + Object.keys(C.results).map(result => '<label><input type="radio" name="result-' + item.id + '" data-ic-field="result" value="' + result + '"' + (item.result === result ? ' checked' : '') + (read ? ' disabled' : '') + '> ' + C.results[result] + '</label>').join('') + '</fieldset></td>'
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
    }
    function input(event) {
      const el = event.target;
      if (!editable()) return;
      if (el.dataset.problemField && panel && !panel.uploading) {
        const problem = panel.problems.find(p => p.id === el.closest('[data-problem-id]').dataset.problemId);
        problem[el.dataset.problemField] = el.value; panel.dirty = true; return;
      }
      if (!el.dataset.icField || panel) return;
      const item = data.items.find(i => i.id === el.closest('[data-ic-id]').dataset.icId);
      item[el.dataset.icField] = el.dataset.icField === 'required' ? el.value === 'true' : el.value;
      changed();
    }
    async function click(event) {
      const el = event.target.closest('[data-ic-action]');
      if (!el || !host.contains(el)) return;
      const action = el.dataset.icAction;
      if (action === 'file') { context.openFile(el.dataset.url); return; }
      if (action === 'cancel-problems') {
        const current = panel;
        if (current && current.dirty && !await App.confirm('放弃尚未确认的问题修改？已保存的检查项和问题保持不变。', { danger: false })) return;
        if (!alive || panel !== current) return;
        const itemId = panel && panel.itemId; panel = null; render(); focusProblemButton(itemId); return;
      }
      if (action === 'problems') {
        if (panel) throw new Error('请先确认或取消当前问题编辑');
        const item = data.items.find(i => i.id === el.closest('[data-ic-id]').dataset.icId);
        panel = { itemId: item.id, content: item.content, problems: C.clone(item.problems), dirty: false, pending: [], uploading: false };
        renderPanel(); return;
      }
      if (!editable()) return;
      if (action === 'add') {
        guard(); if (data.items.length >= 100) throw new Error('最多 100 个检查项');
        data.items.push(C.newItem()); changed(); render();
        const inputs = host.querySelectorAll('[data-ic-field="content"]'); inputs[inputs.length - 1].focus(); return;
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
      if (!panel || panel.uploading) return;
      if (action === 'add-problem') {
        if (panel.problems.length >= 20) throw new Error('每项最多 20 个问题');
        const count = data.items.filter(i => i.id !== panel.itemId).reduce((n, i) => n + i.problems.length, 0) + panel.problems.length;
        if (count >= 200) throw new Error('每份巡视最多 200 个问题');
        panel.problems.push(C.newProblem(panel)); panel.dirty = true; renderPanel();
      } else if (action === 'delete-problem') {
        const current = panel;
        if (!await App.confirm('移除此问题及其附件引用？')) return;
        if (!editable() || panel !== current || panel.uploading) return;
        const id = el.closest('[data-problem-id]').dataset.problemId;
        panel.problems = panel.problems.filter(p => p.id !== id); panel.pending = panel.pending.filter(p => p.problemId !== id); panel.dirty = true; renderPanel();
      } else if (action === 'remove-file') {
        const p = panel.problems.find(p => p.id === el.closest('[data-problem-id]').dataset.problemId);
        p.attachments = p.attachments.filter(f => f.url !== el.dataset.url); panel.dirty = true; renderPanel();
      } else if (action === 'confirm-problems') {
        if (panel.pending.length) throw new Error('问题附件上传未完成，请重试或取消编辑');
        if (panel.problems.some(p => !(p.name || '').trim() || !C.types.includes(p.type))) throw new Error('请填写问题名称并选择类型');
        const next = C.clone(data); next.items.find(i => i.id === panel.itemId).problems = panel.problems;
        C.validate(next, false); data = next; changed(); const itemId = panel.itemId; panel = null; render(); focusProblemButton(itemId);
      } else if (action === 'retry') await upload(panel);
    }
    function renderPanel() {
      const p = panel, read = context.readOnly;
      const box = host.querySelector('[data-ic-panel]');
      box.innerHTML = '<div class="ic-overlay"><div class="fd-modal ic-dialog" role="dialog" aria-modal="true" aria-label="检查项问题"><div class="fd-header"><h3 class="fd-title">检查项问题</h3>' + btn('cancel-problems', '关闭') + '</div><div class="fd-body">'
        + '<p class="ic-context">' + esc(p.content || '尚未填写检查内容') + '</p><p class="fd-hint">问题确认后仅回填本机草稿，仍需保存巡视。发现人由服务器按登录身份记录。</p>'
        + '<p class="fd-error" data-ic-error role="alert" tabindex="-1"></p>'
        + p.problems.map((problem, index) => '<div class="ic-problem" data-problem-id="' + problem.id + '"><h4>问题 ' + (index + 1) + '</h4>'
          + field('name', '问题名称 *', problem.name, read, true)
          + '<label class="ic-field">问题类型 *<select class="fd-select" data-problem-field="type"' + (read ? ' disabled' : '') + '>' + C.types.map(t => '<option' + (problem.type === t ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></label>'
          + field('description', '问题说明', problem.description, read, true)
          + '<p>发现人：' + esc(problem.foundByName || (App.getUser().userName || '当前填写人') + '（未同步）') + '</p>'
          + problem.attachments.map(f => '<div class="ic-file"><span>' + esc(f.name || '附件') + '</span>' + btn('file', '查看', 'data-url="' + esc(f.url) + '"') + (read ? '' : btn('remove-file', '移除', 'data-url="' + esc(f.url) + '"')) + '</div>').join('')
          + (read ? '' : '<label class="ic-upload">添加图片或附件<input type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip" data-problem-upload="' + problem.id + '"></label>' + btn('delete-problem', '删除问题')) + '</div>').join('')
        + (!p.problems.length ? '<p class="ic-empty">尚无问题；打开此窗口不会自动新增问题。</p>' : '')
        + (read ? '' : btn('add-problem', '添加问题'))
        + '<p data-upload-message class="fd-hint" role="status">' + esc(p.uploading ? '正在上传，请稍候…' : p.pending.map(x => x.file.name + '：' + (x.error || '待上传')).join('；')) + '</p>'
        + (p.pending.length && !read ? btn('retry', '重试问题附件') : '') + '</div><div class="fd-footer">'
        + (read ? '' : btn('confirm-problems', '确认问题')) + btn('cancel-problems', read ? '关闭' : '取消修改') + '</div></div></div>';
      box.querySelectorAll('[data-problem-upload]').forEach(el => { el.onchange = run(async event => {
        if (!editable() || panel !== p || p.uploading) return;
        const files = Array.from(event.target.files || []); event.target.value = '';
        const total = data.items.filter(i => i.id !== p.itemId).reduce((n, i) => n + i.problems.reduce((v, q) => v + q.attachments.length, 0), 0)
          + p.problems.reduce((n, q) => n + q.attachments.length, 0) + p.pending.length + files.length;
        if (total > 50) throw new Error('每份巡视最多 50 个问题附件');
        p.pending.push(...files.map(file => ({ file, problemId: el.dataset.problemUpload }))); p.dirty = true; await upload(p);
      }); });
      if (p.uploading) box.querySelectorAll('input,textarea,select,button').forEach(el => { if (el.dataset.icAction !== 'cancel-problems') el.disabled = true; });
      const first = box.querySelector('button:not(:disabled)'); if (first) first.focus();
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
    async function upload(p) {
      if (!editable() || panel !== p || p.uploading) return;
      p.uploading = true; renderPanel();
      const failed = [];
      for (const entry of p.pending) {
        if (!alive || panel !== p) return;
        try {
          if (!entry.remote) entry.remote = await context.upload(entry.file);
          if (!alive || panel !== p) return;
          const problem = p.problems.find(q => q.id === entry.problemId);
          if (problem && !problem.attachments.some(f => f.url === entry.remote.url)) problem.attachments.push(entry.remote);
        } catch (e) { entry.error = e.message; failed.push(entry); }
      }
      if (!alive || panel !== p) return;
      p.pending = failed; p.uploading = false; renderPanel();
    }
    function guard() { if (error) throw new Error(error); if (panel) throw new Error('请先确认或取消检查项的问题编辑，再保存、提交或离开巡视'); }
    render();
    return { guard, hasUnsaved: () => !!panel && (panel.dirty || panel.uploading || panel.pending.length > 0), destroy() { alive = false; panel = null; host.onkeydown = null; }, print() { guard(); const p = host.querySelector('.ic-print'); p.textContent = C.format(context.raw()); } };
  };
})();
