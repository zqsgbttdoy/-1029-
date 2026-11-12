/* PC 与小程序共用的巡视检查明细模型；不读取模板或改变原巡视正文。 */
(function (root) {
  'use strict';
  const results = { unchecked: '未检查', compliant: '符合', noncompliant: '不符合' };
  const types = ['质量问题', '安全问题', '人员问题', '工艺问题', '环保问题', '程序问题', '其他问题'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const id = () => 'ci-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
  const empty = () => ({ version: 1, items: [] });
  const newItem = () => ({ id: id(), content: '', result: 'unchecked', photos: [], problems: [] });
  const newProblem = () => ({ id: id(), description: '', attachments: [] });
  function parse(raw) {
    if (raw == null || raw === '') return empty();
    if (typeof raw === 'string' && raw.length > 60000) throw new Error('检查明细不能超过 60000 字符，请保留原始草稿');
    let data;
    try { data = typeof raw === 'string' ? JSON.parse(raw) : clone(raw); } catch (e) { throw new Error('检查明细无法解析，请保留原始草稿'); }
    validate(data, false);
    return data;
  }
  function validate(data, submit) {
    if (!data || data.version !== 1 || !Array.isArray(data.items) || data.items.length > 100) throw new Error('检查明细格式或版本无效，最多 100 项');
    const ids = new Set(), problemIds = new Set(); let problems = 0, files = 0;
    const unique = (value, set) => { if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id) || set.has(value.id)) throw new Error('检查项或问题 ID 无效或重复'); set.add(value.id); };
    const text = (obj, fields) => fields.forEach(k => { if (Object.prototype.hasOwnProperty.call(obj, k) && (typeof obj[k] !== 'string' || obj[k].length > 10000)) throw new Error('检查明细文本最多 10000 字符'); });
    data.items.forEach((item, n) => {
      unique(item, ids); text(item, ['category', 'content', 'method', 'standard']);
      if (!Object.prototype.hasOwnProperty.call(results, item.result) || !Array.isArray(item.problems) || item.problems.length > 20) throw new Error('检查结果或问题列表无效，每项最多 20 个问题');
      // 检查项现场照片：旧记录无此字段时视为空，不作强制要求
      const itemPhotos = item.photos == null ? [] : item.photos;
      if (!Array.isArray(itemPhotos) || itemPhotos.length > 10) throw new Error('检查项照片列表无效，每项最多 10 张');
      text(itemPhotos, ['name']); itemPhotos.forEach(f => { if (!f || typeof f.url !== 'string' || !f.url.trim() || Object.prototype.hasOwnProperty.call(f, 'size') && (!Number.isSafeInteger(f.size) || f.size < 0)) throw new Error('检查项照片尚未上传或格式无效'); });
      files += itemPhotos.length;
      if (submit && !(item.content || '').trim()) throw new Error('请填写第 ' + (n + 1) + ' 项检查内容');
      if (submit && item.result === 'unchecked') throw new Error('请选择第 ' + (n + 1) + ' 项的检查结果');
      item.problems.forEach(p => {
        unique(p, problemIds); text(p, ['name', 'type', 'description']);
        // 问题名称与类型已下线：仅保留说明；历史数据的类型仍校验，缺失时视为兼容
        if (p.type != null && !types.includes(p.type)) throw new Error('问题类型无效');
        if (!Array.isArray(p.attachments)) throw new Error('问题附件列表无效');
        p.attachments.forEach(f => { if (!f || typeof f.url !== 'string' || !f.url.trim() || Object.prototype.hasOwnProperty.call(f, 'size') && (!Number.isSafeInteger(f.size) || f.size < 0)) throw new Error('问题附件尚未上传或格式无效'); text(f, ['name']); });
        problems++; files += p.attachments.length;
      });
    });
    if (problems > 200 || files > 50) throw new Error('每份巡视最多 200 个问题、50 个附件（含问题附件与检查项照片）');
    if (JSON.stringify(data).length > 60000) throw new Error('检查明细不能超过 60000 字符，请减少内容');
    return data;
  }
  function stringify(data) { validate(data, false); return JSON.stringify(data); }
  function stats(raw) {
    const data = parse(raw), s = { total: data.items.length, unchecked: 0, compliant: 0, noncompliant: 0, problems: 0 };
    data.items.forEach(i => { s[i.result]++; s.problems += i.problems.length; }); return s;
  }
  function summary(raw) {
    try { const s = stats(raw); return s.total ? '检查项 ' + s.total + ' · 未检查 ' + s.unchecked + ' · 符合 ' + s.compliant + ' · 不符合 ' + s.noncompliant + ' · 问题 ' + s.problems : '未录入检查项'; }
    catch (e) { return e.message; }
  }
  function writable(raw) {
    return { version: 1, items: parse(raw).items.map(i => ({
      id: i.id, content: i.content || '', result: i.result,
      photos: (i.photos || []).map(f => {
        const value = { url: f.url, name: f.name || '' }; if (f.size != null) value.size = f.size; return value;
      }),
      problems: i.problems.map(p => ({ id: p.id, description: p.description || '', attachments: p.attachments.map(f => {
        const value = { url: f.url, name: f.name || '' }; if (f.size != null) value.size = f.size; return value;
      }) }))
    })) };
  }
  function mergeFoundBy(raw, remote) {
    const data = parse(raw), saved = parse(remote);
    const found = new Map(); saved.items.forEach(i => i.problems.forEach(p => found.set(p.id, p)));
    data.items.forEach(i => i.problems.forEach(p => { const value = found.get(p.id); if (value && value.foundById != null) { p.foundById = value.foundById; p.foundByName = value.foundByName; } }));
    return stringify(data);
  }
  function normalizeTime(value) {
    if (!value) return null;
    const time = String(value).replace(' ', 'T');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(time)) throw new Error('巡视时间格式应为 YYYY-MM-DD HH:mm 或 HH:mm:ss');
    const normalized = time.length === 16 ? time + ':00' : time;
    const date = new Date(normalized + 'Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== normalized) throw new Error('巡视日期或时间无效');
    return normalized;
  }
  function pack(body, submit) {
    const next = Object.assign({}, body);
    // 巡视时间已合并为单一 startTime：历史草稿可能带 endTime，提交时不再发送
    if ('startTime' in body) next.startTime = normalizeTime(body.startTime);
    delete next.endTime;
    ['workerCount', 'manageCount'].forEach(k => {
      if (!(k in body)) return;
      const v = body[k];
      if (v === '' || v == null) { next[k] = null; return; }
      if (!/^\d+$/.test(String(v)) || Number(v) > 2147483647) throw new Error('施工人数、管理人数必须为非负整数');
      next[k] = Number(v);
    });
    if (body.checklist != null && body.checklist !== '') { const data = parse(body.checklist); validate(data, submit); next.checklist = JSON.stringify(data); }
    return next;
  }
  function sameBody(kind, remote, body) {
    return Object.keys(body).every(k => {
      if (kind === 'daily-inspections' && k === 'checklist') return JSON.stringify(writable(remote[k])) === JSON.stringify(writable(body[k]));
      if (kind === 'daily-inspections' && ['startTime', 'endTime'].includes(k)) return normalizeTime(remote[k]) === normalizeTime(body[k]);
      return JSON.stringify(remote[k] == null ? null : remote[k]) === JSON.stringify(body[k] == null ? null : body[k]);
    });
  }
  function mediaProblem(data, media) {
    const item = data.items.find(i => i.id === media.itemId);
    return item && item.problems.find(p => p.id === media.problemId);
  }
  function withMedia(raw, media) {
    const data = parse(raw);
    media.filter(m => m.itemId && !m.problemId && m.url).forEach(m => {
      const item = data.items.find(i => i.id === m.itemId);
      if (item && !(item.photos || []).some(f => f.url === m.url)) {
        const file = { url: m.url, name: m.name || '检查项照片' }; if (m.size != null) file.size = m.size;
        item.photos = (item.photos || []).concat(file);
      }
    });
    media.filter(m => m.problemId && m.url).forEach(m => {
      const problem = mediaProblem(data, m);
      if (problem && !problem.attachments.some(f => f.url === m.url)) {
        const file = { url: m.url, name: m.name || '问题照片' }; if (m.size != null) file.size = m.size;
        problem.attachments.push(file);
      }
    });
    return stringify(data);
  }
  function format(raw) {
    return parse(raw).items.map((i, n) => [
      (n + 1) + '. ' + (i.content || '未填写检查内容'), '结果：' + results[i.result],
      ...((i.photos || []).length ? ['照片：' + i.photos.map(f => f.name || '检查项照片').join('、')] : []),
      ...i.problems.map((p, m) => '问题 ' + (m + 1) + '：' + (p.description || p.name || '未填写问题说明') + '\n发现人：' + (p.foundByName || '未同步') + '\n附件：' + (p.attachments.map(f => f.name || '文件').join('、') || '无'))
    ].join('\n')).join('\n\n') || '未录入检查项';
  }
  const value = { results, types, clone, id, empty, newItem, newProblem, parse, validate, stringify, stats, summary, writable, mergeFoundBy, pack, sameBody, mediaProblem, withMedia, format };
  if (typeof module !== 'undefined') module.exports = value; else root.InspectionChecklist = value;
})(typeof window !== 'undefined' ? window : this);
