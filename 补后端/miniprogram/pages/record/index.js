const api = require('../../utils/api');
const drafts = require('../../utils/drafts');
const voice = require('../../utils/voice');
const { schemas, statuses, unpack, diaryPeople, logPrefillPatch } = require('../../utils/schema');
const modal = options => new Promise(resolve => wx.showModal(Object.assign({}, options, { success: resolve, fail: () => resolve({ confirm: false }) })));
function array(value) { try { return JSON.parse(value || '[]'); } catch (e) { return []; } }
function bodyOf(kind, record) {
  record = unpack(kind, record);
  const keys = ['code', 'projectId', schemas[kind].date, 'photos', 'attachments', 'diarySources', 'weekStart', 'weekEnd'].concat(schemas[kind].fields.map(f => f[0]));
  const body = {}; keys.forEach(k => { if (record[k] != null) body[k] = record[k]; }); return body;
}
Page({
  data: { body: {}, fields: [], media: [], photos: [], attachments: [], error: '', state: '', prefillState: '', busy: false, editable: false, history: [], sources: [] },
  async onLoad(options) {
    this.uid = api.userId();
    if (!this.uid) { wx.reLaunch({ url: '/pages/login/index' }); return; }
    try {
      if (options.localId) {
        const draft = drafts.get(options.localId);
        if (!draft) throw new Error('本账号没有此草稿');
        this.localId = draft.localId; this.kind = draft.kind; this.showDraft(draft);
      } else {
        if (!schemas[options.kind]) throw new Error('记录类型不存在');
        this.kind = options.kind;
        const record = await api.request('/' + this.kind + '/' + options.id);
        this.server = record;
        const own = String(record.authorId || record.inspectorId) === this.uid;
        if (own && ['draft', 'rejected'].includes(record.status)) {
          const draft = drafts.create(this.kind, bodyOf(this.kind, record), record);
          this.localId = draft.localId; this.showDraft(draft);
        } else this.showRecord(record);
      }
      this.setData({ kind: this.kind, title: schemas[this.kind].title, guide: schemas[this.kind].guide || '', hints: schemas[this.kind].hints || {}, attachmentHint: schemas[this.kind].attachmentHint || '', prefillHint: schemas[this.kind].prefillHint || '' });
      wx.setNavigationBarTitle({ title: schemas[this.kind].title });
      this.loadContext();
      void this.prefillLog(true);
    } catch (e) { this.fail(e); }
  },
  onShow() { this.visible = true; },
  onHide() { this.visible = false; this.cancelPrefill(); voice.stop(true); },
  onUnload() { this.visible = false; this.unloaded = true; this.cancelPrefill(); voice.stop(true); },
  fail(e) { this.setData({ error: e.message || '操作失败，请重试' }); },
  fields(body) {
    const values = unpack(this.kind, body), schema = schemas[this.kind];
    return schema.fields.map(f => ({ key: f[0], label: f[1], value: values[f[0]] == null ? '' : values[f[0]],
      short: ['supervision-diaries', 'supervision-logs'].includes(this.kind) && ['weather', 'wind', 'temperature'].includes(f[0]),
      hint: (schema.hints || {})[f[0]] || '',
      placeholder: (this.kind === 'supervision-logs' ? (schema.hints || {})[f[0]] : (schema.placeholders || {})[f[0]]) || '点击填写，文字自动暂存本机' }));
  },
  showDraft(draft) {
    this.cancelPrefill(); this.fieldEdits = {};
    const meta = Object.assign({}, draft.recordMeta, { id: draft.serverId, status: draft.serverStatus });
    if (draft.serverId && !meta.authorId) meta.authorId = draft.ownerId;
    this.setData({ people: diaryPeople(meta, api.session()), body: draft.body, fields: this.fields(draft.body), media: draft.media, state: draft.state, error: draft.error || '',
      projectName: draft.projectName || '项目 ' + draft.body.projectId, dateField: schemas[this.kind].date,
      editable: ['draft', 'rejected'].includes(draft.serverStatus), serverId: draft.serverId, status: draft.serverStatus,
      conflict: draft.state === '内容冲突', rejectReason: draft.rejectReason || '', canClear: !draft.dirty && !draft.pending,
      canRevise: draft.serverStatus === 'approved' && !draft.dirty && !draft.pending,
      sources: array(draft.body.diarySources) });
    const localUrls = new Set(draft.media.map(m => m.url));
    this.loadFiles(Object.assign({}, draft.body, { photos: JSON.stringify(array(draft.body.photos).filter(p => !localUrls.has(typeof p === 'string' ? p : p.url))) }));
  },
  showRecord(record) {
    this.cancelPrefill(); this.fieldEdits = {};
    this.server = record;
    const local = this.localId && drafts.get(this.localId);
    this.setData({ people: diaryPeople(record, api.session()), body: bodyOf(this.kind, record), fields: this.fields(record), state: statuses[record.status] || record.status,
      status: record.status, serverId: record.id, dateField: schemas[this.kind].date, editable: false,
      conflict: false, error: '', canClear: !!local && !local.dirty && !local.pending,
      rejectReason: record.rejectReason || '', projectName: '项目 ' + record.projectId,
      canRevise: record.status === 'approved' && String(record.authorId || record.inspectorId) === this.uid, sources: array(record.diarySources), media: [] });
    this.loadFiles(record);
  },
  async loadContext() {
    try {
      const project = await api.request('/projects/' + this.data.body.projectId);
      const summary = await api.request('/field/summary', 'GET', { projectId: project.id, date: this.data.body[this.data.dateField] });
      this.setData({ projectName: project.name, canReview: summary.canReview });
    } catch (e) { this.fail(e); }
  },
  async loadFiles(body) {
    const sequence = this.fileSequence = (this.fileSequence || 0) + 1;
    const load = async value => Promise.all(array(value).map(async item => {
      const file = typeof item === 'string' ? { url: item } : item;
      try { return Object.assign({}, file, { preview: await api.fileUrl(file.url) }); }
      catch (e) { return Object.assign({}, file, { error: '联网后点击重新获取附件' }); }
    }));
    const [photos, attachments] = await Promise.all([load(body.photos), load(body.attachments)]);
    if (api.userId() === this.uid && sequence === this.fileSequence && !this.unloaded) {
      const current = array(this.data.body.photos).map(p => typeof p === 'string' ? { url: p } : p);
      this.setData({ photos: photos.filter(p => current.some(c => c.url === p.url)).map(p =>
        Object.assign({}, p, current.find(c => c.url === p.url))), attachments });
    }
  },
  input(e) {
    if (!this.data.editable || this.data.busy) return;
    const field = e.currentTarget.dataset.field;
    if (['supervision-diaries', 'supervision-logs'].includes(this.kind) && (field === this.data.dateField || field === 'projectId')) return;
    this.markFieldEdit(field);
    const body = Object.assign({}, this.data.body, { [field]: e.detail.value });
    if (field === this.data.dateField) { body.diarySources = '[]'; this.setData({ sources: [] }); }
    this.setData({ body }); this.persist();
  },
  persist() {
    try {
      api.assertUser(this.uid);
      const draft = drafts.edit(this.localId, { body: this.data.body, media: this.data.media });
      this.setData({ body: draft.body, media: draft.media, state: draft.state, error: draft.error || '', storageFailed: false, canClear: false });
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      return true;
    } catch (e) {
      this.setData({ storageFailed: true }); this.fail(e);
      if (wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '内容未保存成功，请留在此页重试' });
      return false;
    }
  },
  async choosePhoto(e) {
    if (!this.data.editable || this.data.busy) return;
    if (this.data.media.length + this.data.photos.length >= 50) { this.fail(new Error('最多 50 张照片')); return; }
    const source = e.currentTarget.dataset.source;
    try {
      const result = await new Promise((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: [source], sizeType: ['compressed'], success: resolve, fail: reject }));
      const temp = result.tempFiles[0].tempFilePath;
      const compressed = await new Promise(resolve => wx.compressImage({ src: temp, quality: 85, success: r => resolve(r.tempFilePath), fail: () => resolve(temp) }));
      api.assertUser(this.uid);
      const photo = await drafts.persistPhoto(compressed); photo.source = source;
      this.setData({ media: this.data.media.concat(photo) }); this.persist();
    } catch (e) { this.fail(new Error('未能添加照片：请检查照片授权、存储空间后重试；可继续填写文字')); }
  },
  photoDescription(e) {
    if (!this.data.editable || this.data.busy) return;
    const media = this.data.media.map(m => m.id === e.currentTarget.dataset.id ? Object.assign({}, m, { description: e.detail.value }) : m);
    this.setData({ media }); this.persist();
  },
  removePhoto(e) { if (!this.data.editable || this.data.busy) return; this.setData({ media: this.data.media.filter(m => m.id !== e.currentTarget.dataset.id) }); this.persist(); },
  remotePhotoDescription(e) {
    if (!this.data.editable || this.data.busy) return;
    const url = e.currentTarget.dataset.url;
    const photos = array(this.data.body.photos).map(p => typeof p === 'string' ? { url: p } : p)
      .map(p => p.url === url ? Object.assign({}, p, { description: e.detail.value }) : p);
    this.setData({ body: Object.assign({}, this.data.body, { photos: JSON.stringify(photos) }),
      photos: this.data.photos.map(p => p.url === url ? Object.assign({}, p, { description: e.detail.value }) : p) }); this.persist();
  },
  removeRemotePhoto(e) {
    if (!this.data.editable || this.data.busy) return;
    const url = e.currentTarget.dataset.url;
    const photos = array(this.data.body.photos).filter(p => (typeof p === 'string' ? p : p.url) !== url);
    this.setData({ body: Object.assign({}, this.data.body, { photos: JSON.stringify(photos) }), photos: this.data.photos.filter(p => p.url !== url) }); this.persist();
  },
  async preview(e) {
    try {
      const path = e.currentTarget.dataset.path || await api.fileUrl(e.currentTarget.dataset.url);
      wx.previewImage({ current: path, urls: [path] });
    } catch (e) { this.fail(e); }
  },
  async openAttachment(e) {
    try {
      const url = await api.fileUrl(e.currentTarget.dataset.url);
      const result = await new Promise((resolve, reject) => wx.downloadFile({ url, success: resolve, fail: reject }));
      if (result.statusCode !== 200) throw new Error('附件链接已失效，请重试');
      api.assertUser(this.uid);
      wx.openDocument({ filePath: result.tempFilePath, showMenu: true, fail: () => this.fail(new Error('此附件格式请在 PC 查看')) });
    } catch (e) { this.fail(e); }
  },
  recordVoice(e) {
    if (!this.data.editable || this.data.busy) return;
    if (this.data.recording) { voice.stop(); return; }
    this.cancelPrefill();
    const field = e.currentTarget.dataset.field; this.setData({ recording: true });
    voice.start(async text => {
      if (!this.visible || api.userId() !== this.uid) return;
      const result = await modal({ title: '核对识别文字（尤其轴线、尺寸及数字）', content: text, editable: true, confirmText: '追加文字' });
      if (result.confirm && this.visible && this.data.editable && !this.data.busy && api.userId() === this.uid) {
        this.markFieldEdit(field);
        const body = Object.assign({}, this.data.body, { [field]: (this.data.body[field] || '') + (result.content == null ? text : result.content) });
        this.setData({ body, fields: this.fields(body) }); this.persist();
      }
    }, e => { if (this.visible && api.userId() === this.uid) this.fail(e); },
    () => { if (!this.unloaded) this.setData({ recording: false }); });
  },
  async action(e) {
    if (!this.data.editable || this.data.busy || this.data.recording) return;
    const submit = e.currentTarget.dataset.action === 'submit';
    if (submit && !(await modal({ title: '确认提交审核', content: '请核对项目、日期、正文及全部照片。提交后正文锁定。' })).confirm) return;
    if (!this.persist()) return;
    this.cancelPrefill();
    this.setData({ busy: true });
    try {
      const draft = await (submit ? drafts.submit(this.localId) : drafts.sync(this.localId));
      this.showDraft(draft);
      wx.showToast({ title: submit ? '服务器已确认提交' : '服务器草稿已保存', icon: 'none' });
    } catch (e) {
      if (api.userId() === this.uid) this.showDraft(drafts.get(this.localId));
      this.fail(e);
    } finally { this.setData({ busy: false }); }
  },
  async review(e) {
    if (this.data.busy) return;
    const status = e.currentTarget.dataset.status;
    const result = await modal({ title: status === 'approved' ? '确认审核通过？' : '填写退回原因', editable: status === 'rejected', content: '' });
    if (!result.confirm) return;
    this.setData({ busy: true });
    try {
      const version = this.localId ? drafts.get(this.localId).version : this.server.lockVersion;
      const record = await api.request('/' + this.kind + '/' + this.data.serverId + '/approve', 'POST',
        { status, rejectReason: result.content || '' }, { 'X-Record-Version': version });
      this.server = record;
      const own = String(record.authorId || record.inspectorId) === this.uid;
      if (own && (this.localId || record.status === 'rejected')) {
        const draft = drafts.create(this.kind, bodyOf(this.kind, record), record);
        this.localId = draft.localId; this.showDraft(draft);
      } else this.showRecord(record);
    } catch (e) { this.fail(e); } finally { this.setData({ busy: false }); }
  },
  async history() {
    try {
      const history = await api.request('/' + this.kind + '/' + this.data.serverId + '/history');
      this.setData({ history: history.map(h => Object.assign({}, h, { text: JSON.stringify(JSON.parse(h.snapshot), null, 2) })) });
    } catch (e) { this.fail(e); }
  },
  async remote() {
    try {
      const record = await api.request('/' + this.kind + '/' + this.data.serverId);
      const text = this.fields(record).map(f => f.label + '：' + f.value).join('\n\n');
      await modal({ title: '服务器当前正文（本机稿仍保留）', content: text, showCancel: false });
    } catch (e) { this.fail(e); }
  },
  async fork() {
    if (!(await modal({ title: '保留冲突稿并建立副本？', content: '不会覆盖原记录。请核对双方内容，避免将相同内容再次提交。' })).confirm) return;
    if (this.data.storageFailed && !this.persist()) return;
    try { const draft = drafts.fork(this.localId); wx.redirectTo({ url: '/pages/record/index?localId=' + draft.localId }); } catch (e) { this.fail(e); }
  },
  async revise() {
    if (!(await modal({ title: '建立修订草稿？', content: '已审核原件及审批历史保持不变，新稿需重新提交审核。' })).confirm) return;
    try {
      const record = await api.request('/' + this.kind + '/' + this.data.serverId);
      api.assertUser(this.uid);
      if (record.status !== 'approved' || String(record.authorId || record.inspectorId) !== this.uid) throw new Error('只能为本人已通过记录建立修订稿');
      const body = bodyOf(this.kind, record); delete body.code; body.sourceRecordId = record.id;
      const draft = drafts.create(this.kind, body); wx.redirectTo({ url: '/pages/record/index?localId=' + draft.localId });
    } catch (e) { this.fail(e); }
  },
  async forget() {
    if (!(await modal({ title: '清除已同步本机副本？', content: '服务器记录不会删除；未同步草稿不可清除。' })).confirm) return;
    try { drafts.forget(this.localId); wx.navigateBack(); } catch (e) { this.fail(e); }
  },
  markFieldEdit(field) {
    this.fieldEdits = this.fieldEdits || {};
    this.fieldEdits[field] = (this.fieldEdits[field] || 0) + 1;
  },
  cancelPrefill() {
    this.prefillSequence = (this.prefillSequence || 0) + 1;
    if (!this.unloaded) this.setData({ prefillState: '' });
  },
  async prefillLog(automatic = false) {
    automatic = automatic === true;
    if (this.kind !== 'supervision-logs' || !this.localId || !this.data.editable || this.data.busy || this.data.recording
        || this.data.storageFailed || this.data.conflict || this.unloaded || this.visible === false) return;
    const original = drafts.get(this.localId);
    if (!original || original.pending || original.state === '待同步') return;
    const localId = this.localId, projectId = this.data.body.projectId, date = this.data.body.logDate;
    const sequence = this.prefillSequence = (this.prefillSequence || 0) + 1;
    const edits = Object.assign({}, this.fieldEdits);
    const valid = () => api.userId() === this.uid && sequence === this.prefillSequence && localId === this.localId
      && !this.unloaded && this.visible !== false && this.data.editable && !this.data.busy && !this.data.recording
      && !this.data.storageFailed && !this.data.conflict && this.data.body.projectId === projectId && this.data.body.logDate === date;
    this.setData({ prefillState: '正在读取同项目、日志当日的已审核日记，可继续填写…' });
    try {
      const source = await api.request('/field/diary-prefill', 'GET', { projectId, date });
      if (!valid()) return;
      const latest = drafts.get(localId);
      if (!latest || latest.pending || latest.state === '待同步' || !['draft', 'rejected'].includes(latest.serverStatus)
          || latest.serverId !== original.serverId || latest.version !== original.version) {
        this.setData({ prefillState: '草稿同步状态已变化，请按需重新预填共享字段。' }); return;
      }
      const excluded = schemas[this.kind].prefillFields.filter(field => ((this.fieldEdits || {})[field] || 0) !== (edits[field] || 0)
        || automatic && (this.fieldEdits || {})[field]);
      const patch = logPrefillPatch(this.data.body, source, excluded), count = Object.keys(patch).length;
      if (count) {
        const body = Object.assign({}, this.data.body, patch);
        this.setData({ body, fields: this.fields(body) });
        if (!this.persist()) { this.setData({ prefillState: '预填内容尚未保存到本机，请保留页面并重试保存。' }); return; }
      }
      this.setData({ prefillState: count ? '已预填 ' + count + ' 个共享字段，仅供参考；可修改后保存，已有内容未覆盖。'
        : '暂无可预填的空白字段或当日已审核日记，已有内容保持不变。' });
    } catch (e) {
      if (valid()) this.setData({ prefillState: '日记预填未完成：' + e.message + '。可继续手动填写，或重新预填共享字段。' });
    } finally {
      if (sequence === this.prefillSequence && !valid() && !this.unloaded && this.visible !== false && api.userId() === this.uid
          && this.data.prefillState.startsWith('正在读取'))
        this.setData({ prefillState: '页面状态已变化，本次预填已取消；可按需重新预填共享字段。' });
    }
  },
  async diarySource() {
    if (!this.data.editable || this.data.busy || this.data.recording) return;
    this.cancelPrefill();
    this.setData({ busy: true });
    try {
      const source = await api.request('/field/diary-source', 'GET', { projectId: this.data.body.projectId, date: this.data.body.logDate });
      const body = Object.assign({}, this.data.body); let filled = false;
      schemas[this.kind].fields.forEach(f => { if (!String(body[f[0]] || '').trim() && source[f[0]]) { body[f[0]] = source[f[0]]; filled = true; } });
      if (filled) body.diarySources = JSON.stringify(source.sources);
      this.setData({ body, fields: this.fields(body), sources: array(body.diarySources) }); this.persist();
      wx.showToast({ title: filled ? '仅填入空白栏目，请核对' : '无可填充内容，原文未变', icon: 'none' });
    } catch (e) { this.fail(e); } finally { this.setData({ busy: false }); }
  }
});
