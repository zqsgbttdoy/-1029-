const L = require('../../utils/diary-links');
const api = require('../../utils/api');
const config = require('../../config');
Component({
  properties: {
    value: { type: String, value: '', observer(value) { if (value !== this.raw) this.reset(value); } },
    readonly: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false, observer() { this.cancel(); } },
    projectId: { type: Number, value: 0, observer() { this.cancel(); } },
    context: { type: String, value: '', observer() { this.cancel(); } }
  },
  data: { nodes: [], active: -1, cursor: 0, error: '', canUndo: false },
  lifetimes: {
    attached() { this.dead = false; this.uid = api.userId(); this.token = (api.session() || {}).token; this.reset(this.properties.value); },
    detached() { this.dead = true; this.cancel(); }
  },
  pageLifetimes: { hide() { this.hiddenPage = true; this.cancel(); }, show() { this.hiddenPage = false; this.checkFiles(); } },
  methods: {
    cancel() { this.version = (this.version || 0) + 1; },
    alive() { return !this.dead && !this.hiddenPage && api.userId() === this.uid && (api.session() || {}).token === this.token; },
    editable() { return this.alive() && !this.properties.readonly && !this.properties.disabled; },
    reset(value) {
      this.cancel(); this.raw = String(value || ''); this.undoStack = [];
      this.setData({ nodes: L.editableNodes(this.raw), active: -1, error: '', canUndo: false });
      if (this.uid) this.checkFiles();
    },
    checkpoint() { this.undoStack = this.undoStack || []; if (this.undoStack[this.undoStack.length - 1] !== this.raw) this.undoStack.push(this.raw); if (this.undoStack.length > 50) this.undoStack.shift(); },
    emit() {
      this.cancel(); this.raw = L.serialize(this.data.nodes);
      this.setData({ canUndo: !!(this.undoStack || []).length });
      this.triggerEvent('change', { value: this.raw });
      if (this.raw.length > 60000) this.setData({ error: '本栏超过 60000 字符，请缩短后保存，内容未截断' });
    },
    collect() { this.cancel(); return L.serialize(this.data.nodes); },
    guard() { if (L.serialize(this.data.nodes).length > 60000) throw new Error('单个正文栏目不能超过 60000 字符'); },
    edit(e) {
      if (!this.editable()) return;
      const index = Number(e.currentTarget.dataset.index), node = this.data.nodes[index];
      if (!node || node.type !== 'text') return;
      this.cancel(); this.setData({ active: index, cursor: node.text.length });
    },
    cursor(e) { if (Number.isInteger(e.detail.cursor) && e.detail.cursor >= 0) this.setData({ cursor: e.detail.cursor }); },
    input(e) {
      if (!this.editable()) return;
      const index = Number(e.currentTarget.dataset.index), nodes = this.data.nodes.slice();
      if (!nodes[index] || nodes[index].type !== 'text') return;
      const previous = nodes[index].text, value = e.detail.value;
      let start = 0, end = value.length, oldEnd = previous.length;
      while (start < Math.min(previous.length, value.length) && previous[start] === value[start]) start++;
      while (end > start && oldEnd > start && value[end - 1] === previous[oldEnd - 1]) { end--; oldEnd--; }
      this.checkpoint(); nodes[index] = { type: 'text', text: value };
      this.setData({ nodes, cursor: e.detail.cursor == null ? value.length : e.detail.cursor }); this.emit();
      // 原生 textarea 没有 paste 事件；仅对这次用户编辑的文字段进行识别。
      void this.convert(index, { start, end });
    },
    async convert(index, inserted) {
      if (!this.editable()) return;
      const text = this.data.nodes[index].text, version = this.version, context = this.properties.context, projectId = this.properties.projectId;
      let candidates = inserted ? L.pasted(text.slice(inserted.start, inserted.end), config.baseUrl) : [];
      if (candidates.some(n => n.type === 'file')) candidates = [{ type: 'text', text: text.slice(0, inserted.start) }, ...candidates, { type: 'text', text: text.slice(inserted.end) }];
      else candidates = L.pasted(text, config.baseUrl);
      if (!candidates.some(n => n.type === 'file')) return;
      try {
        const resolved = await Promise.all(candidates.map(async n => n.type === 'text' ? n : Object.assign({}, n, { name: (await api.referenceAccess(n, projectId)).name })));
        if (!this.editable() || version !== this.version || context !== this.properties.context || projectId !== this.properties.projectId) return;
        this.checkpoint(); const nodes = this.data.nodes.slice(); nodes.splice(index, 1, ...resolved);
        this.setData({ nodes: L.editableNodes(L.serialize(nodes)), active: -1, error: '' }); this.emit();
      } catch (e) { if (this.alive() && version === this.version) this.setData({ error: '链接未转换，粘贴文字已保留：' + e.message }); }
    },
    async paste() {
      if (!this.editable()) return;
      if (this.data.active < 0) { this.setData({ error: '请先点击需要插入链接的文字段，确定编辑位置' }); return; }
      const version = this.version, index = this.data.active, cursor = this.data.cursor;
      try {
        const result = await new Promise((resolve, reject) => wx.getClipboardData({ success: resolve, fail: () => reject(new Error('无法读取剪贴板，请使用文字框的系统粘贴')) }));
        if (!this.editable() || version !== this.version || index !== this.data.active) return;
        const text = this.data.nodes[index].text, inserted = String(result.data || '');
        this.input({ currentTarget: { dataset: { index } }, detail: { value: text.slice(0, cursor) + inserted + text.slice(cursor), cursor: cursor + inserted.length } });
      } catch (e) { if (this.alive()) this.setData({ error: e.message }); }
    },
    remove(e) {
      if (!this.editable()) return;
      const index = Number(e.currentTarget.dataset.index);
      if (!this.data.nodes[index] || this.data.nodes[index].type !== 'file') return;
      this.checkpoint(); const nodes = this.data.nodes.slice(); nodes.splice(index, 1);
      this.setData({ nodes: L.editableNodes(L.serialize(nodes)), active: -1 }); this.emit();
    },
    undo() {
      if (!this.editable() || !this.undoStack || !this.undoStack.length) return;
      const raw = this.undoStack.pop(); this.setData({ nodes: L.editableNodes(raw), active: -1, error: '' }); this.emit(); this.checkFiles();
    },
    async open(e) {
      const item = this.data.nodes[Number(e.currentTarget.dataset.index)]; if (!item || !this.alive()) return;
      try { await api.openReference(item); } catch (error) { if (this.alive()) { this.setData({ error: error.message }); this.checkFiles(); } }
    },
    copy(e) {
      if (!this.alive()) return;
      const item = this.data.nodes[Number(e.currentTarget.dataset.index)];
      if (item) wx.setClipboardData({ data: api.referenceUrl(item), fail: () => this.setData({ error: '复制失败，请重试' }) });
    },
    checkFiles() {
      if (!this.alive()) return;
      const version = this.version;
      this.data.nodes.forEach((item, index) => {
        if (item.type !== 'file') return;
        api.referenceAccess(item).then(() => {
          if (this.alive() && version === this.version) this.setData({ ['nodes[' + index + '].unavailable']: '' });
        }).catch(e => {
          if (this.alive() && version === this.version) this.setData({ ['nodes[' + index + '].unavailable']: e.code === 403 || e.code === 404 ? '资料已删除／不可用' : '联网后点击重新核验' });
        });
      });
    }
  }
});
