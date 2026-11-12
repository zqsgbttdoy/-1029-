/* 日常巡检 → 监理日记的共用同步规则；仅追加草稿内容与照片，不直接写服务器。 */
(function (root) {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./inspection-checklist') : root.InspectionChecklist;
  const clean = value => String(value == null ? '' : value).trim();
  const array = value => {
    if (Array.isArray(value)) return value;
    try { const result = JSON.parse(value || '[]'); return Array.isArray(result) ? result : []; }
    catch (e) { return []; }
  };
  const urlOf = photo => clean(typeof photo === 'string' ? photo : photo && photo.url);
  const timeText = value => clean(value).replace('T', ' ').slice(0, 16);

  /** 监理工作记录与问题分栏，避免把问题明细在两个栏目重复一遍。 */
  function sections(record) {
    record = record || {};
    const code = clean(record.code) || ('记录#' + record.id);
    const heading = '【日常巡检】' + code;
    const work = [heading];
    if (timeText(record.startTime)) work.push('巡检时间：' + timeText(record.startTime));
    if (clean(record.title || record.location)) work.push('检查部位：' + clean(record.title || record.location));
    const counts = [];
    if (record.workerCount != null && record.workerCount !== '') counts.push('施工人数：' + record.workerCount + ' 人');
    if (record.manageCount != null && record.manageCount !== '') counts.push('管理人数：' + record.manageCount + ' 人');
    if (counts.length) work.push(counts.join('；'));
    const inspectionContent = Object.prototype.hasOwnProperty.call(record, 'inspectionContent') ? record.inspectionContent : record.content;
    if (clean(inspectionContent)) work.push('巡视内容：' + clean(inspectionContent));
    const checklist = C.parse(record.checklist);
    if (checklist.items.length) {
      work.push('检查项：');
      checklist.items.forEach((item, index) => {
        work.push((index + 1) + '. ' + (clean(item.content) || '未填写检查内容'));
        work.push('检查结果：' + (C.results[item.result] || item.result));
      });
    }
    const issues = [];
    if (clean(record.issues)) issues.push('巡视补充说明：' + clean(record.issues));
    checklist.items.forEach((item, index) => {
      if (item.result !== 'noncompliant' && !item.problems.length) return;
      const lines = ['检查项 ' + (index + 1) + '：' + (clean(item.content) || '未填写检查内容')];
      if (item.result === 'noncompliant') lines.push('检查结果：不符合');
      item.problems.forEach(problem => {
        const text = clean(problem.description) || clean(problem.name) || '未填写问题说明';
        lines.push('问题说明：' + text);
      });
      issues.push(lines.join('\n'));
    });
    return { inspection: work.join('\n'), newIssues: issues.length ? heading + '\n' + issues.join('\n\n') : '' };
  }

  /** 完整保留已有文字；相同同步块重复操作时不再追加。 */
  function append(existing, addition, label) {
    const raw = String(existing == null ? '' : existing);
    if (!addition || raw.includes(addition)) return { value: raw, added: false };
    if (!raw.trim()) return { value: addition, added: true };
    const separator = raw.endsWith('\n\n') ? '' : raw.endsWith('\n') ? '\n' : '\n\n';
    const value = raw + separator + addition;
    if (value.length > 60000) throw new Error('同步后“' + label + '”超过 60000 字符，请先精简日记内容');
    return { value, added: true };
  }

  /**
   * options.inspection / issues / photos 默认均为 true。
   * 返回完整新值，调用方一次性写回；校验失败时不产生部分修改。
   */
  function merge(record, body, currentPhotos, options) {
    options = options || {};
    const enabled = key => options[key] !== false;
    const blocks = sections(record), nextBody = Object.assign({}, body || {});
    let addedText = 0;
    if (enabled('inspection')) {
      const result = append(nextBody.inspection, blocks.inspection, '监理工作情况');
      nextBody.inspection = result.value; if (result.added) addedText++;
    }
    if (enabled('issues')) {
      const result = append(nextBody.newIssues, blocks.newIssues, '工作中的新问题');
      nextBody.newIssues = result.value; if (result.added) addedText++;
    }
    const photos = array(currentPhotos == null ? nextBody.photos : currentPhotos).slice(), seen = new Set(photos.map(urlOf).filter(Boolean));
    let addedPhotos = 0;
    if (enabled('photos')) {
      array(record && record.syncPhotos).forEach(file => {
        const url = urlOf(file); if (!url || seen.has(url)) return;
        const photo = { url, name: clean(file.name) || '巡检现场照片',
          source: 'daily-inspection', sourceId: record.id,
          description: '来源：日常巡检 ' + (clean(record.code) || ('记录#' + record.id)) };
        if (Number.isSafeInteger(file.size) && file.size >= 0) photo.size = file.size;
        photos.push(photo); seen.add(url); addedPhotos++;
      });
      if (photos.length > 50) throw new Error('同步后日记照片最多 50 张，请先移除不需要的照片或减少本次同步内容');
    }
    nextBody.photos = JSON.stringify(photos);
    return { body: nextBody, photos, addedText, addedPhotos, blocks };
  }

  const value = { sections, merge };
  if (typeof module !== 'undefined') module.exports = value; else root.DailyInspectionSync = value;
})(typeof window !== 'undefined' ? window : this);
