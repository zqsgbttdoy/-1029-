const api = require('../../utils/api');
const L = require('../../utils/diary-links');
Component({
  properties: { projectId: Number, date: String, context: String, disabled: Boolean },
  data: { groups: [] },
  observers: {
    'projectId,date,context'(project, date) { if (this.ready) this.initialize(project, date); },
    disabled(value) { if (value) this.cancel(); else if (this.ready) this.data.groups.forEach((g, i) => { if (g.loading) this.load(i); }); }
  },
  lifetimes: {
    attached() { this.ready = true; this.dead = false; this.uid = api.userId(); this.initialize(this.properties.projectId, this.properties.date); },
    detached() { this.dead = true; this.cancel(); }
  },
  pageLifetimes: { hide() { this.hiddenPage = true; this.cancel(); }, show() { this.hiddenPage = false; if (this.ready) this.data.groups.forEach((g, i) => this.load(i)); } },
  methods: {
    cancel() { this.epoch = (this.epoch || 0) + 1; },
    alive() { return this.ready && !this.dead && !this.hiddenPage && !this.properties.disabled && api.userId() === this.uid; },
    initialize(project, date) {
      this.cancel();
      if (!project || !date) return;
      const key = project + ':' + date;
      if (key !== this.key) { this.key = key; this.setData({ groups: L.sources.map(s => ({ type: s[0], name: s[1], page: 1, total: 0, dateFrom: date, dateTo: date, keyword: '', fileName: '', records: [], loading: false, error: '' })) }); }
      this.data.groups.forEach((g, i) => this.load(i));
    },
    filter(e) {
      const index = Number(e.currentTarget.dataset.group), field = e.currentTarget.dataset.field;
      if (!this.alive() || !['dateFrom', 'dateTo', 'keyword', 'fileName'].includes(field)) return;
      this.setData({ ['groups[' + index + '].' + field]: e.detail.value });
      if (field === 'fileName') { if (!this.data.groups[index].loading && !this.data.groups[index].error) this.draw(index); }
      else {
        this.sequence = this.sequence || {}; this.sequence[index] = (this.sequence[index] || 0) + 1;
        this.setData({ ['groups[' + index + '].loading']: false, ['groups[' + index + '].error']: '筛选条件已改变，请点击查询', ['groups[' + index + '].visibleRecords']: [] });
      }
    },
    draw(index) {
      const g = this.data.groups[index];
      this.setData({ ['groups[' + index + '].visibleRecords']: (g.records || []).map(r => Object.assign({}, r, { visibleFiles: r.files.filter(f => !g.fileName || f.name.includes(g.fileName)) })) });
    },
    search(e) { const i = Number(e.currentTarget.dataset.group); this.setData({ ['groups[' + i + '].page']: 1 }); this.load(i); },
    page(e) {
      const i = Number(e.currentTarget.dataset.group), g = this.data.groups[i], page = g.page + Number(e.currentTarget.dataset.delta);
      if (page < 1 || (page - 1) * 20 >= g.total) return;
      this.setData({ ['groups[' + i + '].page']: page }); this.load(i);
    },
    retry(e) { this.load(Number(e.currentTarget.dataset.group)); },
    async load(index) {
      if (!this.alive()) return;
      const g = this.data.groups[index], epoch = this.epoch, projectId = this.properties.projectId, context = this.properties.context;
      this.sequence = this.sequence || {}; const sequence = this.sequence[index] = (this.sequence[index] || 0) + 1;
      const valid = () => this.alive() && epoch === this.epoch && sequence === this.sequence[index] && projectId === this.properties.projectId && context === this.properties.context;
      const params = { projectId, sourceType: g.type, pageNum: g.page, pageSize: 20, keyword: g.keyword };
      if (g.dateFrom) params.dateFrom = g.dateFrom; if (g.dateTo) params.dateTo = g.dateTo;
      if (!g.dateFrom && !g.dateTo) params.date = this.properties.date;
      this.setData({ ['groups[' + index + '].loading']: true, ['groups[' + index + '].error']: '', ['groups[' + index + '].visibleRecords']: [] });
      try {
        const result = await api.request('/field/diary-resources', 'GET', params); if (!valid()) return;
        this.setData({ ['groups[' + index + '].records']: result.list, ['groups[' + index + '].total']: result.total, ['groups[' + index + '].loading']: false }); this.draw(index);
      } catch (e) { if (valid()) this.setData({ ['groups[' + index + '].loading']: false, ['groups[' + index + '].error']: '读取失败：' + e.message }); }
    },
    file(e) { const d = e.currentTarget.dataset; return this.data.groups[d.group].visibleRecords[d.record].visibleFiles[d.file]; },
    copy(e) { if (this.alive()) wx.setClipboardData({ data: api.referenceUrl(this.file(e)), fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }) }); },
    async open(e) { if (!this.alive()) return; try { await api.openReference(this.file(e)); } catch (error) { if (this.alive()) wx.showModal({ title: '无法打开原件', content: error.message, showCancel: false }); } }
  }
});
