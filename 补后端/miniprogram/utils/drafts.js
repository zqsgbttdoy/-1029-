const api = require('./api');
const { pack, statuses, isSavedMemo, canEditStatus } = require('./schema');
const C = require('./inspection-checklist');
function syncedState(kind, status) {
  if (kind === 'daily-inspections') return status === 'draft' ? '已同步草稿' : isSavedMemo(kind, status) ? '已保存' : statuses[status] || status;
  if (status === 'draft') return '已同步草稿';
  if (status === 'submitted' || status === 'pending') return '已提交';
  return statuses[status] || status;
}
const inflight = new Map();
const unsaved = new Set();
const panelUnsaved = new Set();
function taskKey(localId, uid = api.userId()) { return uid + ':' + localId; }
function requireSaved(localId, uid) {
  if (unsaved.has(taskKey(localId, uid)) || panelUnsaved.has(taskKey(localId, uid))) throw new Error('页面有未保存修改，自动同步已暂停；请返回原页面重试保存到本机');
  const draft = get(localId, uid);
  if (draft && draft.problemEdit) throw new Error('请先确认或取消问题编辑，再保存或提交巡视');
}
function id() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2); }
function key(uid) { return api.namespace() + ':drafts:' + uid; }
function readAll(uid = api.userId()) { api.assertUser(uid); return wx.getStorageSync(key(uid)) || []; }
function list() { return readAll().sort((a, b) => b.updatedAt - a.updatedAt); }
function get(localId, uid = api.userId()) { return readAll(uid).find(d => d.localId === localId); }
function save(draft, uid = api.userId()) {
  api.assertUser(uid);
  if (String(draft.ownerId) !== uid) throw new Error('草稿账号不匹配');
  const all = readAll(uid); const index = all.findIndex(d => d.localId === draft.localId);
  if (index < 0) all.push(draft); else all[index] = draft;
  try { wx.setStorageSync(key(uid), all); } catch (e) { throw new Error('本机存储不足，未能保存；请勿退出当前页面'); }
  return draft;
}
// 人员及审核信息只作为服务端展示元数据缓存，不进入可写正文或重试请求。
function recordMeta(server) {
  const meta = {};
  ['authorId', 'authorName', 'reviewerId', 'reviewerName', 'reviewedAt', 'version', 'sourceRecordId', 'submittedAt', 'submittedBy'].forEach(key => {
    if (server && server[key] != null) meta[key] = server[key];
  });
  return meta;
}
function create(kind, body, server) {
  const uid = api.userId();
  if (server) {
    const previous = list().find(d => d.kind === kind && d.serverId === server.id);
    if (previous && previous.problemEdit && !unsaved.has(taskKey(previous.localId, uid)) && !panelUnsaved.has(taskKey(previous.localId, uid))) return previous;
    if (previous) requireSaved(previous.localId, uid);
    if (previous && (previous.dirty || previous.pending)) return previous;
    if (previous) {
      const photos = JSON.parse(body.photos || '[]').map(p => typeof p === 'string' ? { url: p } : p);
      const checklist = kind === 'daily-inspections' ? C.parse(body.checklist) : null;
      // 检查项照片挂在 itemId 下，与问题附件、整单照片分开恢复
      const itemHas = m => { const item = checklist && checklist.items.find(i => i.id === m.itemId); return !!item && (item.photos || []).some(f => f.url === m.url); };
      const media = previous.media.filter(m => m.problemId
        ? checklist && (C.mediaProblem(checklist, m) || { attachments: [] }).attachments.some(p => p.url === m.url)
        : m.itemId ? itemHas(m) : photos.some(p => p.url === m.url)).map(m => {
        if (m.problemId || m.itemId) return m;
        const photo = photos.find(p => p.url === m.url);
        return Object.assign({}, m, photo, { id: m.id, path: m.path, description: photo.description || '' });
      });
      return save(Object.assign(previous, { body, media, version: server.lockVersion, serverStatus: server.status, rejectReason: server.rejectReason || '',
        recordMeta: recordMeta(server), state: syncedState(kind, server.status), updatedAt: Date.now() }));
    }
  }
  if (!server && kind === 'daily-inspections' && body.checklist) body = Object.assign({}, body, { checklist: C.stringify(C.writable(body.checklist)) });
  return save({ localId: id(), ownerId: uid, kind, body, media: [], localRevision: 1,
    serverId: server && server.id || null, version: server && server.lockVersion,
    serverStatus: server && server.status || 'draft', rejectReason: server && server.rejectReason || '', requestId: id(), dirty: !server,
    recordMeta: recordMeta(server), state: server ? syncedState(kind, server.status) : '仅本机保存', updatedAt: Date.now() });
}
function edit(localId, patch) {
  const draft = get(localId);
  if (!draft) throw new Error('草稿不存在');
  if (patch.media) {
    // 页面可能仍持有上传前的照片对象；保留同步任务已确认的服务器字段。
    patch = Object.assign({}, patch, { media: patch.media.map(m => {
      const saved = draft.media.find(x => x.id === m.id);
      return saved && saved.url ? Object.assign({}, m, { url: saved.url, name: saved.name, size: saved.size }) : m;
    }) });
    if (patch.body) {
      const removedMedia = draft.media.filter(m => !patch.media.some(x => x.id === m.id));
      const removed = new Set(removedMedia.filter(m => !m.problemId && !m.itemId).map(m => m.url));
      const body = Object.assign({}, patch.body);
      if (removed.size) body.photos = JSON.stringify(JSON.parse(body.photos || '[]').filter(p => !removed.has(typeof p === 'string' ? p : p.url)));
      if (draft.kind === 'daily-inspections' && body.checklist) {
        const data = C.parse(body.checklist);
        removedMedia.filter(m => m.problemId && m.url).forEach(m => {
          const p = C.mediaProblem(data, m); if (p) p.attachments = p.attachments.filter(f => f.url !== m.url);
        });
        removedMedia.filter(m => m.itemId && !m.problemId && m.url).forEach(m => {
          const item = data.items.find(i => i.id === m.itemId); if (item) item.photos = (item.photos || []).filter(f => f.url !== m.url);
        });
        patch.media = patch.media.filter(m => !m.problemId || C.mediaProblem(data, m));
        body.checklist = C.withMedia(data, patch.media);
      }
      patch.body = body;
    }
  }
  if (patch.body && !patch.body.code && draft.body.code) patch.body = Object.assign({}, patch.body, { code: draft.body.code });
  Object.assign(draft, patch);
  draft.localRevision++; draft.updatedAt = Date.now(); draft.dirty = true;
  if (draft.state !== '内容冲突') { draft.state = '仅本机保存'; draft.error = ''; }
  try {
    const saved = save(draft);
    unsaved.delete(taskKey(localId));
    if (Object.prototype.hasOwnProperty.call(patch, 'problemEdit')) panelUnsaved.delete(taskKey(localId));
    return saved;
  } catch (e) { (Object.prototype.hasOwnProperty.call(patch, 'problemEdit') ? panelUnsaved : unsaved).add(taskKey(localId)); throw e; }
}
function saveProblemEdit(localId, panel) {
  const draft = get(localId);
  if (!draft || draft.kind !== 'daily-inspections') throw new Error('巡视草稿不存在');
  const next = Object.assign({}, draft, { problemEdit: panel ? C.clone(panel) : null });
  try { const saved = save(next); panelUnsaved.delete(taskKey(localId)); return saved; }
  catch (e) { panelUnsaved.add(taskKey(localId)); throw e; }
}
function persistPhoto(tempPath) {
  return new Promise((resolve, reject) => {
    const uid = api.userId(); api.assertUser(uid);
    const ext = (tempPath.match(/\.(jpg|jpeg|png)$/i) || [null, 'jpg'])[1];
    const path = wx.env.USER_DATA_PATH + '/field-' + id() + '.' + ext;
    wx.getFileSystemManager().copyFile({ srcPath: tempPath, destPath: path,
      success: () => { try { api.assertUser(uid); resolve({ id: id(), path, source: 'camera', capturedAt: new Date().toISOString(), description: '' }); } catch (e) { reject(e); } },
      fail: () => reject(new Error('照片未能保存到本机，请检查存储空间后重试')) });
  });
}
function sync(localId, options) {
  const uid = api.userId(); const taskKey = uid + ':' + localId;
  if (inflight.has(taskKey)) return inflight.get(taskKey);
  const promise = synchronize(localId, uid, options).finally(() => inflight.delete(taskKey));
  inflight.set(taskKey, promise); return promise;
}
async function synchronize(localId, uid, options) {
  options = options || {};
  let draft = get(localId, uid);
  if (!draft) throw new Error('草稿不存在');
  requireSaved(localId, uid);
  if (!draft.dirty && !draft.pending && !options.finalize) return draft;
  // 巡检是备忘录：已保存记录允许本人再次同步更新，不降为草稿；finalize 表示本次提交直接保存为已保存
  const memo = isSavedMemo(draft.kind, draft.serverStatus) || options.finalize === true;
  if (!canEditStatus(draft.kind, draft.serverStatus)) throw new Error('已提交或已驳回版本不可覆盖，请打开原记录并建立修订版本');
  try {
    draft.state = '待同步'; save(draft, uid);
    // 已发送但未收到确认的请求保持原样重试；编辑后的新内容在确认后另行保存。
    if (!draft.pending) {
      while (true) {
        requireSaved(localId, uid);
        draft = get(localId, uid);
        const media = draft.media.find(m => !m.url);
        if (!media) break;
        const remote = await api.upload(media.path); api.assertUser(uid);
        draft = get(localId, uid);
        const current = draft.media.find(m => m.id === media.id);
        if (current) Object.assign(current, { url: remote.url, name: remote.name, size: remote.size });
        save(draft, uid);
      }
      requireSaved(localId, uid);
      draft = get(localId, uid);
      let existing = []; try { existing = JSON.parse(draft.body.photos || '[]'); } catch (e) { throw new Error('照片数据异常，请保留草稿并联系管理员'); }
      const photoMedia = draft.media.filter(m => !m.problemId && !m.itemId), mediaUrls = new Set(photoMedia.map(m => m.url));
      const body = pack(draft.kind, Object.assign({}, draft.body, { status: memo ? 'recorded' : 'draft', photos: JSON.stringify(existing.filter(p => !mediaUrls.has(typeof p === 'string' ? p : p.url)).concat(photoMedia.map(m => ({
        url: m.url, name: m.name, source: m.source, capturedAt: m.capturedAt, description: m.description
      })))) }));
      if (draft.kind === 'daily-inspections' && (body.checklist || draft.media.some(m => m.problemId || m.itemId))) body.checklist = C.withMedia(body.checklist, draft.media);
      draft.pending = { body, revision: draft.localRevision, serverId: draft.serverId, version: draft.version };
      save(draft, uid);
    }
    requireSaved(localId, uid);
    const pending = draft.pending;
    const path = '/' + draft.kind + (pending.serverId ? '/' + pending.serverId : '');
    let record;
    try {
      record = await api.request(path, pending.serverId ? 'PUT' : 'POST', pending.body,
        pending.serverId ? { 'X-Record-Version': pending.version } : { 'Idempotency-Key': draft.requestId });
    } catch (error) {
      if (error.code === 409 && pending.serverId) {
        // 响应丢失后，仅在服务器内容与原请求完全相同时接纳，绝不以新版本强行覆盖。
        const remote = await api.request(path);
        const same = C.sameBody(draft.kind, remote, pending.body);
        if (!same) throw error;
        record = remote;
      } else throw error;
    }
    api.assertUser(uid); draft = get(localId, uid);
    draft.serverId = record.id; draft.version = record.lockVersion; draft.serverStatus = record.status;
    draft.recordMeta = recordMeta(record);
    draft.dirty = draft.localRevision !== pending.revision || unsaved.has(taskKey(localId, uid)) || panelUnsaved.has(taskKey(localId, uid)) || !!draft.problemEdit;
    if (draft.kind === 'daily-inspections' && record.checklist) {
      draft.body.checklist = C.mergeFoundBy(C.withMedia(draft.body.checklist, draft.media), record.checklist);
    }
    if (!draft.body.code || draft.body.code === pending.body.code) draft.body.code = record.code;
    draft.rejectReason = record.rejectReason || '';
    draft.pending = null; draft.error = ''; draft.state = draft.dirty ? '仅本机保存' : syncedState(draft.kind, record.status);
    save(draft, uid);
    return draft;
  } catch (error) {
    if (api.userId() === uid) {
      draft = get(localId, uid); draft.state = error.code === 409 ? '内容冲突' : '同步失败'; draft.error = error.message;
      // 服务端明确拒绝且未写入时，允许纠正正文；网络错误仍重放原请求。
      if ([400, 413, 415, 422].includes(error.code)) draft.pending = null;
      // 冲突请求保留，必须人工核对，不自动使用服务器新版本覆盖。
      save(draft, uid);
    }
    throw error;
  }
}
async function syncQueued() {
  if (!api.userId()) return;
  const uid = api.userId();
  for (const draft of list()) {
    if (api.userId() !== uid || typeof getApp === 'function' && !getApp().globalData.foreground) return;
    if ((draft.dirty || draft.pending) && draft.state !== '内容冲突' && !unsaved.has(taskKey(draft.localId, uid))) {
      try { await sync(draft.localId); } catch (e) { if (e.code === 401) return; }
    }
  }
}
async function submit(localId) {
  const first = get(localId);
  if (!first) throw new Error('草稿不存在');
  const daily = first.kind === 'daily-inspections';
  if (daily) C.pack(first.body, true);
  let draft = await sync(localId);
  if (draft.dirty) draft = await sync(localId);
  if (draft.dirty || draft.pending) throw new Error('内容仍在变更，请停止编辑后重新提交');
  // 日常巡检免审核：草稿提交只做“保存为已保存”，不再调用审核提交接口
  if (daily) {
    if (!isSavedMemo(draft.kind, draft.serverStatus)) {
      draft = await sync(localId, { finalize: true });
      if (draft.dirty) draft = await sync(localId, { finalize: true });
      if (draft.dirty || draft.pending) throw new Error('内容仍在变更，请停止编辑后重新提交');
    }
    draft.state = syncedState(draft.kind, draft.serverStatus);
    return save(draft);
  }
  const revision = draft.localRevision;
  const uid = api.userId();
  requireSaved(localId, uid);
  let record;
  try { record = await api.request('/' + draft.kind + '/' + draft.serverId + '/submit', 'POST', {}, { 'X-Record-Version': draft.version }); }
  catch (error) {
    record = await api.request('/' + draft.kind + '/' + draft.serverId);
    if (!['submitted', 'approved', 'recorded'].includes(record.status)) throw error;
  }
  api.assertUser(uid); draft = get(localId, uid);
  draft.serverStatus = record.status; draft.version = record.lockVersion;
  draft.recordMeta = recordMeta(record);
  draft.dirty = draft.localRevision !== revision || unsaved.has(taskKey(localId, uid)) || panelUnsaved.has(taskKey(localId, uid)) || !!draft.problemEdit;
  draft.rejectReason = record.rejectReason || '';
  draft.state = draft.dirty ? '内容冲突' : syncedState(draft.kind, record.status);
  draft.error = draft.dirty ? '提交时出现新的本机修改，已保留；请与服务器正文核对后另建草稿' : '';
  return save(draft, uid);
}
function forget(localId) {
  const uid = api.userId(); const draft = get(localId, uid);
  requireSaved(localId, uid);
  if (inflight.has(taskKey(localId, uid))) throw new Error('请等待当前同步结束');
  if (!draft) throw new Error('草稿不存在');
  if (draft.dirty || draft.pending) throw new Error('未同步草稿不能清除，请先保存到服务器');
  wx.setStorageSync(key(uid), readAll(uid).filter(d => d.localId !== localId));
  const remaining = readAll(uid);
  for (const media of draft.media) {
    if (!remaining.some(d => d.media.concat(d.problemEdit && d.problemEdit.media || []).some(m => m.path === media.path))) wx.getFileSystemManager().unlink({ filePath: media.path, fail() {} });
  }
}
function fork(localId) {
  const original = get(localId);
  requireSaved(localId, api.userId());
  if (inflight.has(api.userId() + ':' + localId)) throw new Error('请等待当前同步结束');
  const body = Object.assign({}, original.body); delete body.code; delete body.sourceRecordId;
  const copy = create(original.kind, body);
  copy.media = JSON.parse(JSON.stringify(original.media)); copy.projectName = original.projectName;
  // 冲突原稿完整保留；新稿由用户核对后手动同步，不自动重复建单。
  copy.state = '内容冲突'; copy.error = '冲突副本，请核对后手动保存';
  return save(copy);
}
module.exports = { id, list, get, save, create, edit, sync, syncQueued, submit, persistPhoto, forget, fork, saveProblemEdit };
