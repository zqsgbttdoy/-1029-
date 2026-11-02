const api = require('../../utils/api');
const { statusText } = require('../../utils/schema');
function foldersOf(tree) {
  const result = [{ id: null, name: '全部目录' }];
  function walk(nodes, path) { (nodes || []).forEach(n => { const name = path.concat(n.name); result.push({ id: n.id, name: name.join(' / ') }); walk(n.children, name); }); }
  walk(tree, []); return result;
}
Page({
  data: { projects: [], projectIndex: 0, folders: [], folderIndex: 0, documents: [], page: 1, total: null, loading: false, error: '', treeError: '', refId: null, references: [], refPage: 1, refTotal: null, refLoading: false, refError: '' },
  async onLoad(options) {
    this.uid = api.userId(); this.visible = true;
    if (!this.uid) { wx.reLaunch({ url: '/pages/login/index' }); return; }
    this.preferredProject = options.projectId;
    await this.initialize();
  },
  async initialize() {
    try {
      const projects = await api.allProjects(); if (!this.alive()) return;
      const index = Math.max(0, projects.findIndex(p => String(p.id) === String(this.preferredProject)));
      this.setData({ projects, projectIndex: index, error: projects.length ? '' : '暂无获授权项目' });
      this.initialized = true; if (projects.length) await this.loadTree();
    } catch (e) { if (this.alive()) this.setData({ error: '项目读取失败：' + e.message }); }
  },
  onShow() { this.visible = true; if (this.initialized) this.refresh(); },
  onHide() { this.visible = false; this.cancel(); },
  onUnload() { this.dead = true; this.cancel(); },
  onPullDownRefresh() { Promise.resolve(this.refresh()).finally(() => wx.stopPullDownRefresh()); },
  alive() { return !this.dead && this.visible && api.userId() === this.uid; },
  cancel() { this.sequence = (this.sequence || 0) + 1; this.refSequence = (this.refSequence || 0) + 1; this.treeSequence = (this.treeSequence || 0) + 1; },
  project() { return this.data.projects[this.data.projectIndex]; },
  selectProject(e) {
    this.cancel(); this.setData({ projectIndex: Number(e.detail.value), folders: [], folderIndex: 0, page: 1, total: null, documents: [], refId: null, error: '' });
    this.loadTree();
  },
  selectFolder(e) { this.cancel(); this.setData({ folderIndex: Number(e.detail.value), page: 1, refId: null }); this.load(); },
  async loadTree() {
    if (!this.alive() || !this.project()) return;
    this.cancel();
    const seq = this.treeSequence, project = this.project().id;
    this.setData({ treeError: '', loading: true, documents: [], total: null, refId: null, references: [], refTotal: null });
    try {
      const tree = await api.request('/sub-item-databases/tree', 'GET', { projectId: project });
      if (!this.alive() || seq !== this.treeSequence || project !== this.project().id) return;
      const folders = foldersOf(tree), old = this.data.folders[this.data.folderIndex];
      const index = Math.max(0, folders.findIndex(f => old && f.id === old.id));
      this.setData({ folders, folderIndex: index }); await this.load();
    } catch (e) { if (this.alive() && seq === this.treeSequence) this.setData({ loading: false, treeError: '目录读取失败：' + e.message }); }
  },
  async refresh() { if (!this.initialized) return this.initialize(); return this.loadTree(); },
  async load() {
    if (!this.alive() || !this.project() || !this.data.folders.length) return;
    const seq = this.sequence = (this.sequence || 0) + 1, projectId = this.project().id, folder = this.data.folders[this.data.folderIndex];
    this.refSequence = (this.refSequence || 0) + 1;
    this.setData({ loading: true, documents: [], total: null, refId: null, error: '' });
    try {
      const result = await api.request('/project-documents', 'GET', { projectId, subItemId: folder.id, pageNum: this.data.page, pageSize: 20 });
      if (!this.alive() || seq !== this.sequence) return;
      if (!result.list.length && this.data.page > 1) { this.setData({ page: Math.max(1, Math.ceil(result.total / 20)) }); return this.load(); }
      this.setData({ documents: result.list, total: result.total, loading: false });
    } catch (e) { if (this.alive() && seq === this.sequence) this.setData({ loading: false, error: '资料读取失败，当前计数不可用：' + e.message }); }
  },
  page(e) { const page = this.data.page + Number(e.currentTarget.dataset.delta); if (page < 1 || this.data.total == null || (page - 1) * 20 >= this.data.total) return; this.setData({ page }); this.load(); },
  async showReferences(e) {
    const id = Number(e.currentTarget.dataset.id), page = Number(e.currentTarget.dataset.page || 1);
    if (!this.alive() || !this.data.documents.some(d => d.id === id)) return;
    const seq = this.refSequence = (this.refSequence || 0) + 1;
    this.setData({ refId: id, refPage: page, refTotal: null, references: [], refLoading: true, refError: '' });
    try {
      const result = await api.request('/project-documents/' + id + '/diary-references', 'GET', { pageNum: page, pageSize: 10 });
      if (!this.alive() || seq !== this.refSequence) return;
      this.setData({ references: result.list.map(d => Object.assign({}, d, { statusText: statusText('supervision-diaries', d.status) })), refTotal: result.total, refLoading: false });
    } catch (e) { if (this.alive() && seq === this.refSequence) this.setData({ refLoading: false, refError: '引用读取失败：' + e.message }); }
  },
  diary(e) { if (this.alive()) wx.navigateTo({ url: '/pages/record/index?kind=supervision-diaries&id=' + Number(e.currentTarget.dataset.id) + '&readonly=true' }); },
  file(e) { const file = this.data.documents.find(d => d.id === Number(e.currentTarget.dataset.id)); return file && { sourceType: 'project-documents', sourceId: file.id, file: file.filePath }; },
  async open(e) { if (!this.alive()) return; try { await api.openReference(this.file(e)); } catch (error) { if (this.alive()) wx.showModal({ title: '无法打开原件', content: error.message, showCancel: false }); } },
  copy(e) { if (this.alive()) wx.setClipboardData({ data: api.referenceUrl(this.file(e)), fail: () => this.setData({ error: '复制失败，请重试' }) }); }
});
