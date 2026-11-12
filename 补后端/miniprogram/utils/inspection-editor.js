/* 巡视专用页面行为；问题编辑副本与已确认检查明细分开保存。 */
const C = require('./inspection-checklist');
const api = require('./api');
const drafts = require('./drafts');
const confirm = content => new Promise(resolve => wx.showModal({ title: '请确认', content, success: r => resolve(r.confirm), fail: () => resolve(false) }));
module.exports = {
  refreshChecklist(draft) {
    if (this.kind !== 'daily-inspections') return;
    this.problemEdit = draft && draft.problemEdit ? C.clone(draft.problemEdit) : null;
    this.selectedItems = new Set();
    try {
      const data = C.parse(this.data.body.checklist);
      this.setData({ checkItems: data.items.map(item => Object.assign({}, item, { photos: item.photos || [], localMedia: this.data.media.filter(m => m.itemId === item.id && !m.problemId) })), checkSummary: C.summary(data), checkError: '', resultOptions: Object.keys(C.results).map(key => ({ key, label: C.results[key] })) });
      this.renderProblemPanel();
      if (this.problemEdit && this.data.editable && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '问题尚未确认，请先确认或取消修改' });
    } catch (e) { this.setData({ checkItems: [], checkError: e.message, checkSummary: e.message }); }
  },
  checklistGuard() {
    if (this.kind !== 'daily-inspections') return true;
    if (this.problemEdit) { this.fail(new Error('请先确认或取消问题编辑，再保存、提交或离开巡视')); return false; }
    if (this.data.checkError) { this.fail(new Error(this.data.checkError)); return false; }
    return true;
  },
  checklistWritable() { return this.kind === 'daily-inspections' && this.data.editable && !this.data.busy && !this.problemEdit && !this.data.checkError; },
  applyChecklist(data, media) {
    const next = media || this.data.media;
    // 已上传的检查项照片写回清单，未上传的仍以本机 media 显示并等待同步
    const merged = C.parse(C.withMedia(data, next));
    const raw = C.stringify(merged);
    const checkItems = merged.items.map(item => Object.assign({}, item, { selected: !!this.selectedItems && this.selectedItems.has(item.id),
      photos: item.photos || [], localMedia: next.filter(m => m.itemId === item.id && !m.problemId) }));
    this.setData({ body: Object.assign({}, this.data.body, { checklist: raw }), media: next, checkItems, checkSummary: C.summary(raw) });
    return this.persist();
  },
  addCheckItem() {
    if (!this.checklistWritable()) return;
    try { const data = C.parse(this.data.body.checklist); if (data.items.length >= 100) throw new Error('最多 100 个检查项'); data.items.push(C.newItem()); this.applyChecklist(data); } catch (e) { this.fail(e); }
  },
  checkInput(e) {
    if (!this.checklistWritable()) return;
    try {
      const data = C.parse(this.data.body.checklist), item = data.items.find(i => i.id === e.currentTarget.dataset.id), field = e.currentTarget.dataset.field;
      if (!item || !['content', 'result'].includes(field)) return;
      item[field] = e.detail.value;
      this.applyChecklist(data);
    } catch (e) { this.fail(e); }
  },
  selectCheckItems(e) { this.selectedItems = new Set(e.detail.value); this.setData({ checkItems: this.data.checkItems.map(i => Object.assign({}, i, { selected: this.selectedItems.has(i.id) })) }); },
  async deleteCheckItems(e) {
    if (!this.checklistWritable()) return;
    try {
      const raw = this.data.body.checklist, localId = this.localId;
      const data = C.parse(raw), ids = e.currentTarget.dataset.id ? new Set([e.currentTarget.dataset.id]) : new Set(this.selectedItems || []);
      const removed = data.items.filter(i => ids.has(i.id)); if (!removed.length) throw new Error('请先勾选检查项');
      const count = removed.reduce((n, i) => n + i.problems.length, 0);
      if (!await confirm('删除 ' + removed.length + ' 个检查项及关联的 ' + count + ' 个问题？仅移除附件引用，不删除文件。')) return;
      if (!this.checklistWritable() || this.unloaded || this.localId !== localId || api.userId() !== this.uid) return;
      if (raw !== this.data.body.checklist) throw new Error('检查内容已变化，请重新确认删除');
      data.items = data.items.filter(i => !ids.has(i.id)); this.selectedItems = new Set();
      this.applyChecklist(data, this.data.media.filter(m => !ids.has(m.itemId)));
    } catch (e) { this.fail(e); }
  },
  openProblems(e) {
    if (this.data.busy || this.problemEdit || this.data.checkError) return;
    try {
      const item = C.parse(this.data.body.checklist).items.find(i => i.id === e.currentTarget.dataset.id); if (!item) return;
      this.problemEdit = { itemId: item.id, content: item.content, problems: C.clone(item.problems), dirty: false };
      // 点开即直接展开首条问题说明输入；已有问题仅聚焦，避免重复新增
      const quick = this.data.editable;
      let problem = null;
      try { problem = quick && !this.problemEdit.problems.length ? this.appendProblem() : null; }
      catch (e) { this.problemEdit = null; throw e; }
      if (quick) this.problemEdit.focusId = (problem || this.problemEdit.problems[0]).id;
      this.cacheProblemPanel();
    } catch (e) { this.fail(e); }
  },
  renderProblemPanel() {
    const panel = this.problemEdit;
    const user = api.session() || {};
    const focusId = panel && panel.focusId || '';
    this.setData({ problemPanel: panel ? { content: panel.content, focusId, problems: panel.problems.map(p => Object.assign({}, p, {
      discoverer: p.foundByName || (user.userName || '当前填写人') + '（未同步）',
      files: p.attachments
    })) } : null });
    // focus 仅生效一次，后续输入重渲染不能反复抢焦点或弹出键盘
    if (panel) delete panel.focusId;
  },
  cacheProblemPanel() {
    this.renderProblemPanel();
    if (!this.data.editable) return;
    if (wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '问题尚未确认，请先确认或取消修改' });
    try { drafts.saveProblemEdit(this.localId, this.problemEdit); this.setData({ panelError: '' }); }
    catch (e) { this.setData({ panelError: e.message }); this.fail(e); }
  },
  problemInput(e) {
    if (!this.problemEdit || !this.data.editable || this.data.busy) return;
    const p = this.problemEdit.problems.find(p => p.id === e.currentTarget.dataset.id), field = e.currentTarget.dataset.field;
    if (!p || field !== 'description') return;
    p.description = e.detail.value;
    this.problemEdit.dirty = true; this.cacheProblemPanel();
  },
  appendProblem() {
    const p = this.problemEdit, others = C.parse(this.data.body.checklist).items.filter(i => i.id !== p.itemId).reduce((n, i) => n + i.problems.length, 0);
    if (p.problems.length >= 20 || others + p.problems.length >= 200) throw new Error('每项最多 20 个问题，每份巡视最多 200 个问题');
    const problem = C.newProblem(p); p.problems.push(problem); p.dirty = true;
    return problem;
  },
  addProblem() {
    if (!this.problemEdit || !this.data.editable || this.data.busy) return;
    try {
      const problem = this.appendProblem(); this.problemEdit.focusId = problem.id; this.cacheProblemPanel();
    } catch (e) { this.fail(e); }
  },
  async deleteProblem(e) {
    const p = this.problemEdit;
    if (!p || !this.data.editable || !await confirm('移除此问题及其附件引用？')) return;
    if (p !== this.problemEdit) return;
    const id = e.currentTarget.dataset.id;
    p.problems = p.problems.filter(q => q.id !== id); p.dirty = true; this.cacheProblemPanel();
  },
  async cancelProblems() {
    const p = this.problemEdit; if (!p) return;
    if (p.dirty && !await confirm('放弃尚未确认的问题修改？已确认检查项与问题保持不变。')) return;
    if (p !== this.problemEdit) return;
    try {
      if (this.data.editable) drafts.saveProblemEdit(this.localId, null);
      this.problemEdit = null; this.renderProblemPanel();
      if (!this.data.storageFailed && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    } catch (e) { this.setData({ panelError: e.message }); }
  },
  confirmProblems() {
    const p = this.problemEdit; if (!p || !this.data.editable || this.data.busy) return;
    try {
      const data = C.parse(this.data.body.checklist), item = data.items.find(i => i.id === p.itemId);
      if (!item) throw new Error('检查项已变化，请取消后重新打开');
      item.problems = C.clone(p.problems);
      // 问题附件新增入口已下线：仅保留本机已有媒体（含历史问题照片）随同步回写，不再从问题面板收集
      const media = this.data.media;
      const body = Object.assign({}, this.data.body, { checklist: C.withMedia(data, media) });
      const count = C.parse(body.checklist).items.reduce((n, i) => n + (i.photos || []).length + i.problems.reduce((s, q) => s + q.attachments.length, 0), 0) + media.filter(m => !m.url).length;
      if (count > 50) throw new Error('每份巡视最多 50 个附件（含检查项照片与问题附件）');
      const saved = drafts.edit(this.localId, { body, media, problemEdit: null });
      this.problemEdit = null; this.setData({ panelError: '', storageFailed: false }); this.showDraft(saved);
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    } catch (e) { this.setData({ panelError: e.message }); }
  },
  async chooseCheckPhoto(e) {
    // 检查项现场照片：作为该项记录凭证，与问题附件分开存放，共用每份 50 个附件上限
    const localId = this.localId, itemId = e.currentTarget.dataset.id;
    if (!this.checklistWritable() || this.choosingCheckPhoto) return;
    const valid = () => !this.unloaded && localId === this.localId && api.userId() === this.uid && this.data.editable && !this.problemEdit;
    this.choosingCheckPhoto = true;
    try {
      const data = C.parse(this.data.body.checklist), item = data.items.find(i => i.id === itemId);
      if (!item) return;
      const pending = this.data.media.filter(m => m.itemId === itemId && !m.problemId).length;
      if ((item.photos || []).length + pending >= 10) throw new Error('每项最多 10 张检查项照片');
      const total = data.items.reduce((n, i) => n + (i.photos || []).length + i.problems.reduce((s, p) => s + p.attachments.length, 0), 0)
        + this.data.media.filter(m => !m.url && (m.itemId || m.problemId)).length;
      if (total >= 50) throw new Error('每份巡视最多 50 个附件（含检查项照片与问题附件）');
      const source = e.currentTarget.dataset.source;
      const result = await new Promise((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: [source], sizeType: ['compressed'], success: resolve, fail: reject }));
      if (!valid()) return;
      const temp = result.tempFiles[0].tempFilePath;
      const compressed = await new Promise(resolve => wx.compressImage({ src: temp, quality: 85, success: r => resolve(r.tempFilePath), fail: () => resolve(temp) }));
      if (!valid()) return;
      const photo = await drafts.persistPhoto(compressed);
      if (!valid()) return;
      this.applyChecklist(data, this.data.media.concat(Object.assign(photo, { source, itemId })));
    } catch (e) { if (valid()) this.fail(new Error(e.message || '图片添加失败，请检查授权或存储空间后重试')); }
    finally { this.choosingCheckPhoto = false; }
  },
  removeCheckPhoto(e) {
    if (!this.checklistWritable()) return;
    try {
      const { id: itemId, url, media } = e.currentTarget.dataset;
      const data = C.parse(this.data.body.checklist), item = data.items.find(i => i.id === itemId);
      if (item && url) item.photos = (item.photos || []).filter(f => f.url !== url);
      this.applyChecklist(data, this.data.media.filter(m => m.id !== media && !(m.itemId === itemId && !m.problemId && url && m.url === url)));
    } catch (e) { this.fail(e); }
  },
  async viewProblemFile(e) {
    const { name, url, path } = e.currentTarget.dataset;
    if (path || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(name || url || '')) return this.preview(e);
    return this.openAttachment(e);
  },
  inspectionTime(e) {
    // 巡视与旁站共用这对日期/时间选择器：只看表单可编辑，检查项面板的拦截仅对巡视生效
    if (!this.data.editable || this.data.busy) return;
    if (this.kind === 'daily-inspections' && (this.problemEdit || this.data.checkError)) return;
    const { field, part } = e.currentTarget.dataset, old = String(this.data.body[field] || '').replace(' ', 'T').split('T');
    const value = part === 'clear' ? '' : part === 'date' ? e.detail.value + 'T' + (old[1] || '00:00:00') : (old[0] || this.data.body.inspectionDate) + 'T' + e.detail.value + ':00';
    this.setData({ body: Object.assign({}, this.data.body, { [field]: value }) }); this.persist();
  }
};