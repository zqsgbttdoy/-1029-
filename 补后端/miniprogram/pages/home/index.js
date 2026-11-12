const api = require('../../utils/api');
const drafts = require('../../utils/drafts');
const { schemas, today, nowMinute, statusText } = require('../../utils/schema');
Page({
  data: { projects: [], projectIndex: 0, types: Object.keys(schemas).map(kind => ({ kind, title: schemas[kind].title })),
    kind: 'supervision-diaries', mode: 'mine', records: [], drafts: [], summary: [], error: '', loading: false, more: false, date: today() },
  async onShow() {
    if (!api.userId()) { wx.reLaunch({ url: '/pages/login/index' }); return; }
    const showing = this.showSequence = (this.showSequence || 0) + 1;
    const uid = api.userId(); this.setData({ drafts: drafts.list(), userName: api.session().userName });
    this.cacheKey = api.namespace() + ':projects:' + uid;
    const cached = wx.getStorageSync(this.cacheKey) || [];
    const lastId = wx.getStorageSync(this.cacheKey + ':last');
    this.setData({ projects: cached, projectIndex: Math.max(0, cached.findIndex(p => p.id === lastId)) });
    try {
      const projects = await api.allProjects(); api.assertUser(uid);
      if (showing !== this.showSequence) return;
      const selected = this.data.projects[this.data.projectIndex];
      wx.setStorageSync(this.cacheKey, projects);
      this.setData({ projects, projectIndex: Math.max(0, projects.findIndex(p => p.id === (selected ? selected.id : lastId))), error: '' });
      await this.reload();
    } catch (e) { this.fail(e); }
  },
  fail(e) { this.setData({ error: e.message }); if (e.code === 401) wx.reLaunch({ url: '/pages/login/index' }); },
  selectProject(e) {
    this.setData({ projectIndex: Number(e.detail.value) });
    wx.setStorageSync(this.cacheKey + ':last', this.data.projects[this.data.projectIndex].id);
    this.reload().catch(e => this.fail(e));
  },
  // 日常巡检不产生审核待办：切到巡检时从“项目待审核”回到我的记录
  selectKind(e) {
    const kind = e.currentTarget.dataset.kind;
    this.setData({ kind, mode: kind === 'daily-inspections' && this.data.mode === 'todo' ? 'mine' : this.data.mode });
    this.reload().catch(error => this.fail(error));
  },
  mode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === 'todo' && this.data.kind === 'daily-inspections') return;
    this.setData({ mode }); this.reload().catch(error => this.fail(error));
  },
  async reload() {
    const seq = this.sequence = (this.sequence || 0) + 1;
    this.page = 1; this.setData({ records: [], more: false, loading: false, summary: [], canReview: false });
    const project = this.data.projects[this.data.projectIndex]; if (!project) return;
    const summary = await api.request('/field/summary', 'GET', { projectId: project.id, date: this.data.date });
    if (seq !== this.sequence) return;
    this.setData({ summary: this.data.types.map(t => ({ kind: t.kind, title: t.title, memo: t.kind === 'daily-inspections', counts: summary[t.kind] })), canReview: summary.canReview,
      mode: !summary.canReview && this.data.mode === 'todo' ? 'mine' : this.data.mode });
    await this.loadRecords(seq);
  },
  async loadRecords(seq = this.sequence) {
    const project = this.data.projects[this.data.projectIndex]; if (!project || this.data.loading) return;
    this.setData({ loading: true });
    try {
      // 巡检只按“我的记录”读取，不倒查待审核；状态文案按类型区分（巡检为已保存）
      const kind = this.data.kind, todo = this.data.mode === 'todo' && kind !== 'daily-inspections';
      const data = await api.request('/' + kind, 'GET', { projectId: project.id, pageNum: this.page, pageSize: 20,
        authorId: this.data.mode === 'mine' ? api.userId() : undefined, status: todo ? 'submitted' : undefined });
      if (seq !== this.sequence) return;
      const records = this.data.records.concat(data.list.map(r => Object.assign({}, r, { statusText: statusText(kind, r.status) })));
      this.setData({ records, more: records.length < data.total, error: '' });
    } finally { if (seq === this.sequence) this.setData({ loading: false }); }
  },
  async more() { if (this.data.loading || !this.data.more) return; this.page++; try { await this.loadRecords(); } catch (e) { this.page--; this.fail(e); } },
  onHide() { this.sequence = (this.sequence || 0) + 1; this.showSequence = (this.showSequence || 0) + 1; },
  refresh() { this.setData({ drafts: drafts.list() }); this.reload().catch(e => this.fail(e)); },
  create(e) {
    const project = this.data.projects[this.data.projectIndex]; if (!project) { this.fail(new Error('没有获授权的项目，请联系管理员')); return; }
    const kind = e.currentTarget.dataset.kind || this.data.kind;
    const body = { projectId: project.id, photos: '[]', attachments: '[]' }; body[schemas[kind].date] = today();
    // 日常巡检新建时自动带入当前系统时间（精确到分钟），进入页面后可在时间面板内调整
    if (kind === 'daily-inspections') body.startTime = nowMinute();
    try {
      const draft = drafts.create(kind, body); draft.projectName = project.name; drafts.save(draft);
      wx.navigateTo({ url: '/pages/record/index?localId=' + draft.localId });
    } catch (e) { this.fail(e); }
  },
  open(e) { wx.navigateTo({ url: '/pages/record/index?kind=' + this.data.kind + '&id=' + e.currentTarget.dataset.id }); },
  go(e) { wx.navigateTo({ url: e.currentTarget.dataset.url }); },
  openDraft(e) { wx.navigateTo({ url: '/pages/record/index?localId=' + e.currentTarget.dataset.id }); },
  async sync() {
    this.setData({ syncing: true });
    try { await drafts.syncQueued(); this.setData({ drafts: drafts.list() }); await this.reload(); } catch (e) { this.fail(e); }
    finally { this.setData({ syncing: false }); }
  },
  login() { api.logout(); wx.reLaunch({ url: '/pages/login/index' }); },
  logout() {
    wx.showModal({ title: '退出登录', content: '未同步草稿保留在本机，同账号登录后可继续。请勿清理微信数据。', success: res => { if (res.confirm) this.login(); } });
  }
});
