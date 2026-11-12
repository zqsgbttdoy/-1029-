/* 四类 PC 记录共用业务组件，使用与小程序相同的字段、权限、版本和状态。 */
(function () {
  'use strict';
  const { schemas, today, statuses, statusText, isSavedMemo, canEditStatus, canReviseStatus, pack, unpack, diaryPeople, logPrefillPatch } = window.FieldSchema;
  const root = document.getElementById('fieldWorkspace');
  const kind = root.dataset.kind, schema = schemas[kind], esc = App.escape;
  const isDaily = kind === 'daily-inspections', isSideline = kind === 'sideline-inspections', C = window.FieldSchema.inspectionChecklist;
  // 巡检已免审核：历史审核态（submitted/pending/approved 等）文案统一为“已保存”，徽标底色也归一到 recorded，避免同文案异色
  const chipClass = status => isDaily && isSavedMemo(kind, status || 'draft') ? 'recorded' : (status || 'draft');
  let checklistView = null, linkEditors = [];
  const linkView = window.DiaryLinkView, links = window.DiaryLinks, DailySync = window.DailyInspectionSync;
  const api = async (...args) => { const result = await App.apiFetch(...args); assertAccount(); return result; };
  if (!App.requireAuth()) return;
  App.initTopbar();
  const uid = String(App.getUser().userId), storageKey = 'field-pc:' + location.origin + ':' + uid + ':' + kind;
  const isDiary = kind === 'supervision-diaries', isLog = kind === 'supervision-logs', hasTemplate = isDiary || isLog;
  const uploadView = isDiary
    ? { label: '现场照片与附件', title: '点击或拖拽现场照片、附件到此处上传', sub: '图片计入现场照片；PDF／Word／Excel／TXT／ZIP 计入附件。提交至少需要一张现场照片。' }
    : isLog
      ? { label: '附件上传', title: '<span class="fd-dz-link">点击上传</span> 或拖放文件', sub: '图片计入照片；PDF／Word／Excel／TXT／ZIP 计入附件。文件上传成功后仍需保存表单。' }
      : { label: '附件材料上传', title: '<span class="fd-dz-link">点击上传</span> 或拖拽文件到此处', sub: '图片计入照片，PDF／Word／Excel／TXT／ZIP 计入附件' };
  const submitLabel = hasTemplate ? '提交' : '提交审核';
  // 记录类页面（日常巡检、旁站巡检、监理日记、监理日志）统一使用简洁的“导出”文案
  const exportLabel = '导出';
  let projects = [], page = 1, total = 0, serverRows = [], querySeq = 0, draft = null, busy = false, dirty = false, photos = [], attachments = [], reviewAllowed = false, summaryCache = null;
  const $ = id => document.getElementById(id);
  const parse = value => { try { return JSON.parse(value || '[]'); } catch (e) { return []; } };
  // 服务端时间以 ISO 返回（含 T），界面与导出统一为标签声明的 YYYY-MM-DD HH:mm:ss
  const prettyTime = value => value == null ? '' : String(value).replace('T', ' ').replace(/\.\d+$/, '');
  const key = () => 'pc-' + Date.now().toString(36) + '-' + crypto.getRandomValues(new Uint32Array(4)).join('-');
  const projectRequiredMessage = '请先在上方选择本次填报项目，系统将自动带入工程名称和当天日期';
  const notice = message => {
    const text = message || '';
    ['fieldError', 'fwError'].forEach(id => { const el = $(id); if (el) el.textContent = text; });
  };
  function clearProjectNotice() {
    ['fieldError', 'fwError'].forEach(id => {
      const el = $(id);
      if (el && el.textContent === projectRequiredMessage) el.textContent = '';
    });
  }
  function reportError(error) {
    notice(error.message || '操作失败，请重试');
    if (!$('fwEditor').hidden) {
      $('fwError').scrollIntoView({ block: 'nearest' });
      $('fwError').focus({ preventScroll: true });
    }
  }
  const run = fn => (...args) => Promise.resolve().then(() => { if (!busy) { assertAccount(); return fn(...args); } }).catch(reportError);
  let pendingUploads = [], prefillSequence = 0, fieldEdits = {};
  let participantSeq = 0, participantProjectId = null, participantOptions = [], participantLoaded = false, participantLoading = false, participantError = '';
  let diaryDaySeq = 0, diaryRelatedSeq = 0, diaryDayData = null, diaryDayLoading = false, diaryDayError = '';
  let diaryRelated = { list: [], count: 0, loaded: false, error: '' }, diaryBadgeOpen = false, diarySyncIndex = -1;
  function assertAccount() { if (String((App.getUser() || {}).userId) !== uid) throw new Error('账号已变化，请重新登录原账号恢复草稿'); }
  function persistDraft() {
    assertAccount();
    if (!draft.localId) draft.localId = key();
    draft.updatedAt = Date.now();
    sessionStorage.setItem(storageKey + ':draft:' + draft.localId, JSON.stringify(draft));
  }
  function removeDraft() { if (draft && draft.localId) sessionStorage.removeItem(storageKey + ':draft:' + draft.localId); }
  function savedDrafts() {
    assertAccount();
    const items = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const name = sessionStorage.key(i);
      if (name === storageKey || name.startsWith(storageKey + ':conflict:') || name.startsWith(storageKey + ':draft:')) {
        try {
          const value = JSON.parse(sessionStorage.getItem(name));
          if (!value || !value.body || !value.record) throw new Error('草稿结构不完整');
          items.push({ name, value });
        } catch (e) { notice('存在无法解析的旧草稿，请保留浏览器数据并联系管理员'); }
      }
    }
    return items.sort((a, b) => (b.value.updatedAt || 0) - (a.value.updatedAt || 0));
  }
  const own = record => String(record.authorId || record.inspectorId || uid) === uid;
  const editable = record => !(draft && draft.readOnly) && own(record) && (!record.id || canEditStatus(kind, record.status));
  // 列表删除入口的开放范围：本人草稿与已保存（recorded 及从未被审核过的遗留 submitted/pending）；已审核通过/退回的历史记录不可删
  const canDeleteRow = record => isDaily && own(record) && ['draft', 'recorded', 'submitted', 'pending'].includes(record.status || '');
  function options(list) { return list.map(p => '<option value="' + p.id + '">' + esc(p.name) + '</option>').join(''); }
  function participantIds(raw) {
    const values = Array.isArray(raw) ? raw : parse(raw);
    return [...new Set(values.map(Number).filter(id => Number.isSafeInteger(id) && id > 0).map(String))];
  }
  function participantText(raw, names) {
    return participantIds(raw).map(id => (names && names.get(id)) || (participantOptions.find(p => String(p.userId) === id) || {}).userName || '用户#' + id).join('、');
  }
  function renderParticipants() {
    const box = $('fwF-participants');
    if (!isLog || !box || !draft) return;
    const selected = participantIds(draft.body.participants);
    if (!editable(draft.record)) {
      box.innerHTML = '<div class="fd-readonly">' + esc(participantText(selected) || '—') + '</div>';
      return;
    }
    const known = new Set(participantOptions.map(p => String(p.userId)));
    const optionsHtml = participantOptions.map(person => {
      const id = String(person.userId), label = person.userName + (person.position ? '（' + person.position + '）' : '');
      return '<label class="fd-participant-option"><input type="checkbox" data-participant-id="' + esc(id) + '"' + (selected.includes(id) ? ' checked' : '') + (busy ? ' disabled' : '') + '><span>' + esc(label) + '</span></label>';
    }).join('');
    const legacyHtml = selected.filter(id => !known.has(id)).map(id => '<label class="fd-participant-option fd-participant-legacy"><input type="checkbox" data-participant-id="' + esc(id) + '" checked' + (busy ? ' disabled' : '') + '><span>用户#' + esc(id) + '（已停用或已移出本项目，保存前请取消勾选）</span></label>').join('');
    const state = participantLoading ? '<p class="fd-hint">正在加载本项目人员…</p>' : participantError
      ? '<p class="fd-hint fd-participant-error">' + esc(participantError) + ' <button type="button" data-participant-retry>重试</button></p>'
      : participantLoaded && !participantOptions.length ? '<p class="fd-hint">本项目暂无可选择的启用人员，请联系管理员维护项目成员。</p>' : '';
    box.innerHTML = '<div class="fd-participant-list" role="group" aria-label="参会人员">' + optionsHtml + legacyHtml + '</div>' + state;
    box.querySelectorAll('[data-participant-id]').forEach(input => { input.onchange = () => {
      draft.body.participants = JSON.stringify(Array.from(box.querySelectorAll('[data-participant-id]:checked')).map(el => Number(el.dataset.participantId)));
      try { localSave(); } catch (e) { notice('本机保存失败，请勿关闭页面：' + e.message); }
    }; });
    const retry = box.querySelector('[data-participant-retry]'); if (retry) retry.onclick = () => { if (!busy) void loadParticipants(draft); };
  }
  async function loadParticipants(local) {
    if (!isLog || !local || draft !== local) return;
    const projectId = local.body.projectId, seq = ++participantSeq;
    participantProjectId = projectId == null ? null : String(projectId); participantOptions = []; participantLoaded = false; participantLoading = !!projectId; participantError = '';
    renderParticipants();
    if (!projectId) { participantLoaded = true; participantLoading = false; renderParticipants(); return; }
    try {
      const list = await api('/field/projects/' + encodeURIComponent(projectId) + '/member-options');
      if (draft !== local || seq !== participantSeq || $('fwEditor').hidden || String(local.body.projectId) !== String(projectId)) return;
      participantOptions = Array.isArray(list) ? list : []; participantLoaded = true; participantLoading = false; renderParticipants();
    } catch (error) {
      if (draft !== local || seq !== participantSeq || $('fwEditor').hidden) return;
      participantLoaded = true; participantLoading = false; participantError = '参会人员加载失败：' + (error.message || '请重试'); renderParticipants();
    }
  }

  /* ---------------- 编辑器骨架：标题 + 独立滚动正文 + 固定底部操作栏 ---------------- */
  root.innerHTML = '<div class="fw-toolbar"><label>项目 <select id="fwProject"><option value="">全部获授权项目</option></select></label>'
    + '<label>状态 <select id="fwStatus" aria-describedby="fwDraftHint">' + (isDaily ? '<option value="">全部</option><option value="draft">草稿</option><option value="recorded">已保存</option>' : '<option value="">全部状态</option>' + Object.keys(statuses).filter(s => s !== 'pending').map(s => '<option value="' + s + '">' + statusText(kind, s) + '</option>').join('')) + '</select></label>'
    + '<label>从 <input id="fwFrom" type="date"></label><label>至 <input id="fwTo" type="date"></label><label>编号 <input id="fwCode"></label>'
    + '<label><input id="fwMine" type="checkbox">仅本人</label><button type="button" id="fwSearch">查询</button><button type="button" id="fwNew">新建</button><button type="button" id="fwExport">' + exportLabel + '</button></div>'
    + '<p id="fwDraftHint" class="fw-list-hint">选择“草稿”可继续填写本人草稿。本机未同步内容仅在当前浏览器标签页保留，列于筛选结果首页，不计入服务器总数或 CSV；请保存草稿到服务器后再关闭标签页。</p>'
    + '<p id="fieldError" role="alert" class="fw-error"></p><p id="fwSummary"></p><div class="fw-table"><table><thead><tr><th>编号</th><th>项目</th><th>日期</th><th>填写人 ID</th><th>状态</th>' + (isDaily ? '' : '<th>业务版本</th>') + '<th>操作</th></tr></thead><tbody id="fwLocalRows"></tbody><tbody id="fwRows"></tbody></table></div>'
    + '<div class="fw-toolbar"><button type="button" id="fwPrev">上一页</button><span id="fwPage"></span><button type="button" id="fwNext">下一页</button></div>'
    + '<div id="fwEditor" class="fw-editor" hidden>'
      + '<div class="fd-modal" role="dialog" aria-modal="true" aria-labelledby="fwTitle">'
        + '<div class="fd-header"><div><h2 class="fd-title" id="fwTitle"></h2><div class="fd-sub" id="fwState"></div></div>'
        + '<button type="button" class="fd-close" id="fwClose" title="关闭" aria-label="关闭">✕</button></div>'
        + '<div class="fd-body">'
          + '<p id="fwError" class="fd-error" role="alert" tabindex="-1"></p>'
          + '<p id="fwPrefillState" class="fd-hint" role="status"></p>'
          + '<div id="fwForm" class="fd-grid"></div>'
          + '<div id="fwDefaultDirs"></div>'
          + '<div id="fwMedia"></div>'
          + '<div class="fd-field" id="fwUploadField">'
            + '<div class="fd-label">' + uploadView.label + '</div>'
            + '<label class="fd-dropzone" id="fwUploadLabel" for="fwUpload">'
              + '<span class="fd-dz-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 18a4 4 0 1 1 .6-7.96A6 6 0 0 1 19 12a3 3 0 0 1-1 5.83M12 16V8m0 0-3 3m3-3 3 3"/></svg></span>'
              + '<span class="fd-dz-title">' + uploadView.title + '</span>'
              + '<span class="fd-dz-sub">' + uploadView.sub + '</span>'
              + '<input id="fwUpload" type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip">'
            + '</label>'
            + (schema.attachmentHint ? '<div class="fd-hint">' + esc(schema.attachmentHint) + '</div>' : '')
            + (hasTemplate ? '' : '<div class="fd-hint">文件逐个上传并确认；未成功上传的文件不能提交，可点击“重试失败的文件”。</div>')
            + '<div class="fd-files"><button type="button" id="fwRetryUpload" hidden>重试失败的文件</button><p id="fwUploadState" class="fd-hint"></p></div>'
          + '</div>'
          + '<div id="fwHistoryContent" class="fw-history"></div>'
        + '</div>'
        + '<div class="fd-footer">'
          + '<div class="fd-footer-left">'
            + '<button type="button" id="fwPrint" class="fd-btn fd-btn-ghost">打印</button>'
            + '<button type="button" id="fwPrefill" class="fd-btn fd-btn-ghost">重新预填共享字段</button>'
            + '<button type="button" id="fwSource" class="fd-btn fd-btn-ghost" title="手动整编原文并关联来源，与自动字段预填独立">整编日记原文（含来源）</button>'
            + '<button type="button" id="fwHistory" class="fd-btn fd-btn-ghost">处理历史</button>'
            + '<button type="button" id="fwCompare" class="fd-btn fd-btn-ghost">查看服务器版本</button>'
            + '<button type="button" id="fwRevise" class="fd-btn fd-btn-ghost">建立修订稿</button>'
            + '<button type="button" id="fwFork" class="fd-btn fd-btn-ghost">另存为新草稿</button>'
            + '<button type="button" id="fwDelete" class="fd-btn fd-btn-ghost-danger">删除草稿</button>'
          + '</div>'
          + '<div class="fd-footer-right">'
            + '<button type="button" id="fwApprove" class="fd-btn fd-btn-primary">审核通过</button>'
            + '<button type="button" id="fwReject" class="fd-btn fd-btn-ghost-danger">退回修改</button>'
            + '<button type="button" id="fwSave" class="fd-btn fd-btn-draft">保存草稿</button>'
            + '<button type="button" id="fwCancel" class="fd-btn fd-btn-cancel">取消</button>'
            + '<button type="button" id="fwSubmit" class="fd-btn fd-btn-primary">' + submitLabel + '</button>'
          + '</div>'
        + '</div>'
      + '</div>'
    + '</div>';

  /* ---------------- 字段编排：只调整呈现顺序与控件类型，字段名与提交内容不变 ---------------- */
  const AUTHOR_LABEL = { 'supervision-diaries': '记录人', 'supervision-logs': '填写人', 'daily-inspections': '检查人员', 'sideline-inspections': '旁站人员' }[kind] || '填写人';
  const labels = { [schema.date]: '日期', projectId: '项目名称', code: '编号', participants: '参会人员', weather: '天气', wind: '风力', temperature: '气温', weekStart: '周起始日期（可选）', weekEnd: '周结束日期（可选）' };
  schema.fields.forEach(f => { labels[f[0]] = f[1]; });
  if (hasTemplate) Object.assign(labels, { projectId: '工程名称', reviewer: '审核人' });
  const requiredKeys = new Set([schema.date, 'projectId']);
  if (hasTemplate) requiredKeys.add('author');
  if (isDiary) requiredKeys.add('weather');
  // 与服务端提交校验一致：巡检的检查部位、巡视内容与时间均为选填（时间默认当前分钟），旁站仍要求部位、工序、时间、人数、结果、关联资料
  ({
    'sideline-inspections': ['location', 'process', 'startTime', 'endTime', 'manageCount', 'workerCount', 'result', 'docsText']
  }[kind] || []).forEach(field => requiredKeys.add(field));
  // 日常巡检的日期与巡检时间、旁站的时间与日期改由选择面板填写：面板内点“确定”才写回输入框，取消/遮罩/Esc 均不落库
  const PICK_HINTS = isDaily ? {
    startTime: '新建时自动带入当前时间，精确到分钟；可按实际巡视时间调整，留空表示未记录。'
  } : isSideline ? {
    startTime: '点选日期、整点与分钟（5 分钟一档），例：2026-10-29 08:00；须早于结束时间。',
    endTime: '点选日期、整点与分钟（5 分钟一档），例：2026-10-29 11:30；须晚于开始时间。'
  } : {};
  const PICK_PLACEHOLDER = isDaily
    ? { startTime: '请选择巡检时间（精确到分钟）' }
    : isSideline ? { startTime: '请选择旁站开始时间', endTime: '请选择旁站结束时间' } : {};
  const HINTS = Object.assign({ code: '留空由系统生成，可按需修改。', participants: '可勾选多名本项目的启用人员；保存人员账号，改名后仍能对应同一人。' }, schema.hints || {}, PICK_HINTS);
  const PLACEHOLDERS = Object.assign({}, schema.placeholders || {}, PICK_PLACEHOLDER);
  const closePicker = () => { if (window.FdDateTimePicker) window.FdDateTimePicker.close(); };
  // 服务端的 ISO 时间转成选择器展示的“YYYY-MM-DD HH:mm”；旁站保留秒位，未改动的历史值原样往返
  function pickableValue(value, withTime, withSeconds) {
    if (value == null || value === '') return '';
    const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return String(value);
    if (!withTime || m[4] == null) return m[1] + '-' + m[2] + '-' + m[3];
    const clock = m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
    if (withSeconds) return clock + ':' + (m[6] || '00');
    return clock + (m[6] && m[6] !== '00' ? ':' + m[6] : '');
  }

  function topKeys() {
    const rows = [];
    if (isDiary) rows.push('projectId', schema.date, 'author', 'reviewer', 'weather', 'wind', 'temperature', 'code');
    else if (isLog) rows.push('projectId', schema.date, 'author', 'reviewer', 'weather', 'wind', 'temperature', 'code', 'participants');
    else rows.push(schema.date, 'projectId', 'author', 'code');
    const names = schema.fields.map(f => f[0]);
    return rows.filter(k => ['author', 'reviewer', 'projectId', 'code', 'participants'].includes(k) || k === schema.date || names.includes(k));
  }
  function longKeys() { const top = topKeys(); return schema.fields.map(f => f[0]).filter(k => !top.includes(k)); }
  function compatibilityKeys() { return isLog ? (schema.legacyFields || []).concat('weekStart', 'weekEnd') : []; }
  function controlKind(field) {
    if (field === 'projectId') return 'project';
    if (isDaily && field === 'startTime') return 'minute';
    // 旁站时间需要分钟精度，用“日期+整点+分钟”面板；日期同样改成带确认的面板
    if (isSideline && ['startTime', 'endTime'].includes(field)) return 'minute';
    if ((isDaily || isSideline) && field === schema.date) return 'date-pick';
    if (isDaily && ['workerCount', 'manageCount'].includes(field)) return 'number';
    if (field === schema.date || field === 'weekStart' || field === 'weekEnd') return 'date';
    if (['code', 'weather', 'wind', 'temperature'].includes(field) || (schema.shortFields || []).includes(field)) return 'text';
    return 'textarea';
  }
  function fieldCell(field, body, read, projectLocked, opts) {
    const option = opts || {}, label = (labels[field] || field).replace(/\s*\*+$/, '');
    // 新建监理日记允许在表单内直接选择工程名称；既有记录仍锁定原项目，日志继续由工具栏选定后只读带入
    const projectPick = field === 'projectId' && isDiary && !read && !draft.record.id;
    const hint = projectPick ? '从获授权项目中选择本次填报的工程名称；保存后项目归属锁定。' : HINTS[field];
    const inlineHint = hasTemplate && !['author', 'reviewer', 'projectId', schema.date, 'participants'].includes(field);
    const placeholder = esc((inlineHint ? hint : PLACEHOLDERS[field]) || '');
    const help = hint && !inlineHint ? '<div class="fd-hint" id="fwHint-' + field + '">' + esc(hint) + '</div>' : '';
    const described = (requiredKeys.has(field) ? ' aria-required="true"' : '') + (!hint ? '' : inlineHint
      ? ' title="' + esc(hint) + '" aria-description="' + esc(hint) + '"'
      : ' aria-describedby="fwHint-' + field + '"');
    if (field === 'participants') {
      return '<div class="fd-field fd-wide"><div class="fd-label">参会人员</div><div id="fwF-participants"></div>' + help + '</div>';
    }
    if (hasTemplate && ['author', 'reviewer', 'projectId'].includes(field) && !projectPick) {
      const people = diaryPeople(draft.record, App.getUser());
      const value = field === 'projectId' ? (projects.find(p => String(p.id) === String(body.projectId)) || {}).name || '项目#' + body.projectId : people[field];
      return '<div class="fd-field"><div class="fd-label">' + esc(field === 'author' ? AUTHOR_LABEL : label) + '</div><div class="fd-readonly">' + esc(value) + '</div>' + help + '</div>';
    }
    if (field === 'author') {
      return '<div class="fd-field"><div class="fd-label">' + esc(AUTHOR_LABEL) + (requiredKeys.has('author') ? '<span class="fd-req">*</span>' : '') + '</div><div class="fd-readonly">' + esc(isDaily && draft.record.id ? draft.record.authorName || '用户#' + draft.record.inspectorId : (App.getUser() || {}).userName || '当前登录账号') + '</div>'
        + (hasTemplate ? '' : '<div class="fd-hint">按当前登录账号记录，不支持手工修改。</div>') + '</div>';
    }
    const kindOfControl = controlKind(field), value = body[field] == null ? '' : String(body[field]);
    let control;
    if (kindOfControl === 'project') {
      /* 巡检、旁站与监理日记新建时可以不先选工具栏项目，由本下拉选择；未选时给出占位项便于识别 */
      const pick = body.projectId ? '' : '<option value="">请选择项目名称</option>';
      control = '<select class="fd-select" id="fwF-projectId" data-field="projectId"' + described + ' ' + (projectLocked ? 'disabled' : '') + '>' + pick + options(projects) + '</select>';
    } else if (kindOfControl === 'hour' || kindOfControl === 'minute' || kindOfControl === 'date-pick') {
      /* 整点/分钟/日期选择器：输入框只读展示，选择在面板内进行，点“确定”才写回并派发 input/change */
      const withTime = kindOfControl !== 'date-pick', shown = pickableValue(value, withTime, kindOfControl === 'minute');
      // 起止时间互为约束，提示文案按记录类型区分，避免旁站页出现“巡视”字样
      const owner = isDaily ? '巡视' : '旁站';
      const relation = field === 'endTime'
        ? ' data-picker-after="fwF-startTime" data-picker-after-msg="' + owner + '结束时间必须晚于开始时间"'
        : isSideline && field === 'startTime'
          ? ' data-picker-before="fwF-endTime" data-picker-before-msg="' + owner + '开始时间必须先于结束时间"'
          : '';
      const pickMode = kindOfControl === 'date-pick' ? 'date' : kindOfControl === 'minute' ? 'minute' : 'hour';
      control = read
        ? '<div class="fd-readonly">' + esc(shown || '—') + '</div>'
        : '<div class="fd-pick"><input type="text" class="fd-input" id="fwF-' + field + '" data-field="' + field
          + '" data-picker="' + pickMode + '" value="' + esc(shown) + '" placeholder="' + placeholder
          + '" readonly aria-haspopup="dialog"' + described + relation + '></div>';
    } else if (kindOfControl === 'date' && (!value || /^\d{4}-\d{2}-\d{2}$/.test(value))) {
      /* 空值或标准 ISO 日期用日期控件；非标准历史值退回文本框，避免控件吞掉原值 */
      control = '<input type="date" class="fd-input" id="fwF-' + field + '" data-field="' + field + '" value="' + esc(value) + '"' + described + (read || hasTemplate && field === schema.date ? ' readonly' : '') + '>';
    } else if (kindOfControl === 'datetime-local' || kindOfControl === 'number') {
      control = '<input type="' + kindOfControl + '" class="fd-input" id="fwF-' + field + '" data-field="' + field + '" value="' + esc(kindOfControl === 'datetime-local' ? value.replace(' ', 'T') : value) + '"' + (kindOfControl === 'number' ? ' min="0" max="2147483647" step="1"' : ' step="1"') + described + (read ? ' readonly' : '') + '>';
    } else if (kindOfControl === 'text' || kindOfControl === 'date') {
      const maxLength = hasTemplate ? (field === 'code' ? 50 : 30) : 60;
      control = '<input type="text" class="fd-input" id="fwF-' + field + '" data-field="' + field + '" maxlength="' + maxLength + '" value="' + esc(value) + '" placeholder="' + placeholder + '"' + described + (read || hasTemplate && field === schema.date ? ' readonly' : '') + '>';
    } else {
      control = '<textarea class="fd-textarea" id="fwF-' + field + '" data-field="' + field + '" maxlength="60000" placeholder="' + placeholder + '"' + described + (read ? ' readonly' : '') + '>' + esc(value) + '</textarea>';
    }
    return '<div class="fd-field' + (option.wide ? ' fd-wide' : '') + '">'
      + (option.headless ? '' : '<label class="fd-label" for="fwF-' + field + '">' + esc(label)
        + (requiredKeys.has(field) ? '<span class="fd-req">*</span>' : '') + '</label>')
      + control + help + '</div>';
  }

  /* 日记当天摘要与直传资料独立加载；旧正文稳定链接仍由 linkView.mount 负责。 */
  function diaryValid(local, seq, projectId, date) {
    return draft === local && seq === diaryDaySeq && !$('fwEditor').hidden
      && String((App.getUser() || {}).userId) === uid
      && String(local.body.projectId || '') === String(projectId || '')
      && String(local.body[schema.date] || '') === String(date || '');
  }
  function diarySummaryLocal() {
    const record = draft.record;
    return { id: record.id, code: record.code || draft.body.code, diaryDate: record.diaryDate || draft.body.diaryDate,
      authorId: record.authorId || uid, authorName: record.authorName || (App.getUser() || {}).userName,
      status: record.status || 'draft', route: 'supervision-diary.html?id=' + record.id + '&readonly=true' };
  }
  function diarySyncPanel(record, index) {
    const count = (record.syncPhotos || []).length;
    return '<div class="diary-sync-panel"><strong>选择同步内容</strong><p>追加到当前日记草稿，不覆盖已有文字；相同文字块与照片自动去重。</p>'
      + '<label><input type="checkbox" data-daily-sync-option="inspection" checked> 监理工作情况（时间、部位、人数、巡视内容与检查项）</label>'
      + '<label><input type="checkbox" data-daily-sync-option="issues" checked> 工作中的新问题（巡视补充与不符合项）</label>'
      + '<label><input type="checkbox" data-daily-sync-option="photos"' + (count ? ' checked' : ' disabled') + '> 现场照片（可同步 ' + count + ' 张）</label>'
      + '<div class="diary-day-actions"><button type="button" class="diary-sync-confirm" data-daily-sync-confirm="' + index + '">确认同步</button>'
      + '<button type="button" data-daily-sync-cancel>取消</button></div></div>';
  }
  function diaryBusinessHtml(title, group, records) {
    const daily = group === 'dailyInspections';
    const rows = (records || []).map((record, index) => '<article class="diary-day-record">'
      + '<div class="diary-day-record-head"><strong>' + esc(record.code || ('记录#' + record.id)) + '</strong><span>' + esc(record.title || '无标题') + '</span></div>'
      + (record.content ? '<p>' + esc(record.content) + '</p>' : '')
      + '<div class="diary-day-actions"><button type="button" data-diary-copy="' + group + ':' + index + '">复制</button>'
      + (daily ? '<button type="button" class="diary-sync-button" data-daily-sync="' + index + '">同步到日记</button>' : '')
      + (record.route ? '<a href="' + esc(record.route) + '" target="_blank" rel="noopener">查看原记录</a>' : '') + '</div>'
      + ((record.attachments || []).length ? '<div class="diary-day-files">' + record.attachments.map((file, fileIndex) =>
        '<button type="button" class="diary-file-link" data-daily-file="' + index + ':' + fileIndex + '">' + esc(file.name || '查看附件') + '</button>').join('') + '</div>' : '')
      + '<div class="diary-copy-host"></div>' + (daily && diarySyncIndex === index ? diarySyncPanel(record, index) : '') + '</article>').join('');
    return '<section class="diary-day-group"><h4>' + esc(title) + '</h4>' + (rows || '<p class="diary-day-empty">当天暂无记录</p>') + '</section>';
  }
  function diaryDocumentHtml(document, index) {
    const current = document.diaryId != null && String(document.diaryId) === String(draft.record.id || '');
    const related = document.relatedDiary || (current ? diarySummaryLocal() : null);
    const canBind = editable(draft.record) && draft.record.status === 'draft';
    const tag = document.diaryId != null
      ? '<details class="diary-linked-details"><summary class="diary-linked-tag">' + (related ? '已关联监理日记 [' + esc(related.code || ('#' + related.id)) + ']' : '已关联其他日记') + '</summary>'
        + (related ? '<div class="diary-linked-summary">编号：' + esc(related.code) + '<br>日期：' + esc(related.diaryDate) + '<br>作者：' + esc(related.authorName || related.authorId) + '<br>状态：' + esc(statusText(kind, related.status))
          + '<br><a href="' + esc(related.route) + '" target="_blank" rel="noopener">打开日记</a></div>' : '<div class="diary-linked-summary">目标日记详情不可见</div>') + '</details>'
      : '<span class="diary-unlinked-tag">未关联日记</span>';
    return '<article class="diary-document-row"><div class="diary-document-main"><strong>' + esc(document.name || '未命名资料') + '</strong>'
      + '<p>' + esc(document.directoryPath || '目录不可用') + '</p><p>上传时间：' + esc(prettyTime(document.createTime) || '—') + ' · 上传者：' + esc(document.uploaderName || document.uploaderId || '—') + '</p>'
      + tag + '</div><div class="diary-document-actions"><button type="button" data-document-open="' + index + '">打开</button>'
      + (canBind && !document.diaryId ? '<button type="button" class="diary-bind-button" data-document-attach="' + document.id + '">关联</button>' : '')
      + (canBind && current ? '<button type="button" class="diary-unbind-button" data-document-detach="' + document.id + '">取消关联</button>' : '')
      + '</div></article>';
  }
  function renderDiaryDay() {
    const box = $('fwDiaryDay'); if (!box || !draft) return;
    if (!draft.body.projectId || !draft.body[schema.date]) {
      box.innerHTML = '<section class="diary-day-panel"><h3>当天业务与资料</h3><p class="diary-day-empty">选择项目和日记日期后自动加载</p></section>'; return;
    }
    let content;
    if (diaryDayLoading) content = '<p class="diary-day-empty">正在加载当天业务摘要和直传资料…</p>';
    else if (diaryDayError) content = '<p class="diary-day-error">' + esc(diaryDayError) + '</p><button type="button" data-diary-day-retry>重试</button>';
    else if (diaryDayData) {
      const data = diaryDayData;
      content = '<div class="diary-day-grid">'
        + diaryBusinessHtml('日常巡检', 'dailyInspections', data.dailyInspections)
        + diaryBusinessHtml('发出的监理通知单', 'supervisionNotices', data.supervisionNotices)
        + diaryBusinessHtml('工作联系单', 'workContacts', data.workContacts) + '</div>'
        + '<section class="diary-documents"><h4>当天直传资料</h4>'
        + ((data.documents || []).length ? data.documents.map(diaryDocumentHtml).join('') : '<p class="diary-day-empty">今天暂无关联资料</p>') + '</section>';
    } else content = '<p class="diary-day-empty">暂无当天数据</p>';
    box.innerHTML = '<section class="diary-day-panel"><div class="diary-day-title"><h3>当天业务摘要与资料</h3><button type="button" data-diary-day-retry>刷新</button></div>'
      + '<p class="fd-hint">巡检可追加同步文字与照片，核对后仍需保存日记；其他业务复制只写入剪贴板。资料关联实时生效，与旧正文引用分开统计。</p>' + content + '</section>';
    box.querySelectorAll('[data-diary-day-retry]').forEach(button => { button.onclick = () => { if (!busy) void loadDiaryWorkbench(draft); }; });
    box.querySelectorAll('[data-diary-copy]').forEach(button => { button.onclick = () => {
      const parts = button.dataset.diaryCopy.split(':'), record = (diaryDayData[parts[0]] || [])[Number(parts[1])];
      if (record) void copyDiaryText(record.copyText || [record.code, record.title, record.content].filter(Boolean).join('\n'), button);
    }; });
    box.querySelectorAll('[data-daily-file]').forEach(button => { button.onclick = () => {
      const parts = button.dataset.dailyFile.split(':'), record = (diaryDayData.dailyInspections || [])[Number(parts[0])], file = record && record.attachments[Number(parts[1])];
      if (file && linkView) void linkView.open({ sourceType: 'daily-inspections', sourceId: record.id, file: file.file }, button, reportError);
    }; });
    box.querySelectorAll('[data-daily-sync]').forEach(button => { button.onclick = () => { if (!busy) { diarySyncIndex = Number(button.dataset.dailySync); renderDiaryDay(); } }; });
    box.querySelectorAll('[data-daily-sync-cancel]').forEach(button => { button.onclick = () => { diarySyncIndex = -1; renderDiaryDay(); }; });
    box.querySelectorAll('[data-daily-sync-confirm]').forEach(button => { button.onclick = () => {
      const panel = button.closest('.diary-sync-panel'), options = {};
      panel.querySelectorAll('[data-daily-sync-option]').forEach(input => { options[input.dataset.dailySyncOption] = input.checked; });
      syncDailyInspection(Number(button.dataset.dailySyncConfirm), options);
    }; });
    box.querySelectorAll('[data-document-open]').forEach(button => { button.onclick = () => {
      const document = diaryDayData.documents[Number(button.dataset.documentOpen)]; if (document) openFile(document.filePath);
    }; });
    box.querySelectorAll('[data-document-attach]').forEach(button => { button.onclick = run(async () => changeDiaryAttachment(Number(button.dataset.documentAttach), true)); });
    box.querySelectorAll('[data-document-detach]').forEach(button => { button.onclick = run(async () => changeDiaryAttachment(Number(button.dataset.documentDetach), false)); });
  }
  function syncDailyInspection(index, options) {
    const local = draft, record = diaryDayData && (diaryDayData.dailyInspections || [])[index];
    if (!local || local !== draft || busy || !editable(local.record) || !record || !DailySync) return;
    try {
      collect();
      const merged = DailySync.merge(record, local.body, photos, options);
      diarySyncIndex = -1;
      if (!merged.addedText && !merged.addedPhotos) { renderDiaryDay(); notice('所选内容已同步过，日记未重复追加。'); return; }
      local.body = merged.body; photos = merged.photos;
      form(local.body, local.record); localSave(); renderMedia(); renderDiaryDay();
      notice('已追加 ' + merged.addedText + ' 个正文栏目、' + merged.addedPhotos + ' 张巡检照片；请核对并保存日记。');
    } catch (error) { reportError(error); }
  }
  async function copyDiaryText(text, button) {
    const local = draft;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('剪贴板不可用');
      await navigator.clipboard.writeText(text);
      if (draft === local) { button.textContent = '已复制'; setTimeout(() => { if (button.isConnected) button.textContent = '复制'; }, 1600); }
    } catch (error) {
      if (draft !== local) return;
      const host = button.closest('.diary-day-record').querySelector('.diary-copy-host');
      host.innerHTML = '';
      const manual = document.createElement('textarea'); manual.className = 'diary-manual-copy'; manual.readOnly = true;
      manual.setAttribute('aria-label', '请手动选择并复制当天业务内容'); manual.value = text;
      host.appendChild(manual); manual.focus(); manual.select(); button.textContent = '请手动复制';
    }
  }
  async function loadDiaryWorkbench(local) {
    if (!isDiary || !local || draft !== local || !editable(local.record)) return;
    collect();
    const projectId = local.body.projectId, date = local.body[schema.date], seq = ++diaryDaySeq;
    diaryDayData = null; diaryDayError = '';
    if (!projectId || !date) { diaryDayLoading = false; renderDiaryDay(); return; }
    diaryDayLoading = true; renderDiaryDay();
    try {
      const data = await api('/field/diary-day-workbench?' + App.buildQuery({ projectId, date }));
      if (!diaryValid(local, seq, projectId, date)) return;
      diaryDayLoading = false; diaryDayData = data; renderDiaryDay();
    } catch (error) {
      if (!diaryValid(local, seq, projectId, date)) return;
      diaryDayLoading = false; diaryDayError = '当天业务与资料加载失败：' + (error.message || '请重试'); renderDiaryDay();
    }
  }
  function diaryBadgeHtml() {
    return '<button type="button" id="fwDiaryBadge" class="fw-chip diary-related-badge" aria-expanded="' + diaryBadgeOpen + '">已关联 ' + diaryRelated.count + ' 份附件</button>';
  }
  function renderDiaryRelated() {
    const box = $('fwDiaryRelated'); if (!box || !draft) return;
    box.hidden = !diaryBadgeOpen;
    if (!diaryBadgeOpen) { box.innerHTML = ''; return; }
    let content;
    if (!draft.record.id) content = '<p class="diary-day-empty">首次关联时将先保存服务器草稿</p>';
    else if (!diaryRelated.loaded && !diaryRelated.error) content = '<p class="diary-day-empty">正在读取实际关联资料…</p>';
    else if (diaryRelated.error) content = '<p class="diary-day-error">' + esc(diaryRelated.error) + '</p><button type="button" data-related-retry>重试</button>';
    else if (!diaryRelated.list.length) content = '<p class="diary-day-empty">暂无实际关联资料</p>';
    else content = diaryRelated.list.map((document, index) => '<article class="diary-document-row"><div class="diary-document-main"><strong>' + esc(document.name) + '</strong><p>' + esc(document.directoryPath || '目录不可用') + '</p></div>'
      + '<div class="diary-document-actions"><button type="button" data-related-open="' + index + '">打开</button>'
      + (editable(draft.record) && draft.record.status === 'draft' ? '<button type="button" class="diary-unbind-button" data-document-detach="' + document.id + '">取消关联</button>' : '') + '</div></article>').join('');
    box.innerHTML = '<section class="diary-related-panel"><h3>实际绑定资料 <span>' + diaryRelated.count + ' 份</span></h3>' + content + '</section>';
    const retry = box.querySelector('[data-related-retry]'); if (retry) retry.onclick = () => void loadDiaryRelated(draft);
    box.querySelectorAll('[data-related-open]').forEach(button => { button.onclick = () => openFile(diaryRelated.list[Number(button.dataset.relatedOpen)].filePath); });
    box.querySelectorAll('[data-document-detach]').forEach(button => { button.onclick = run(async () => changeDiaryAttachment(Number(button.dataset.documentDetach), false)); });
  }
  async function loadDiaryRelated(local) {
    if (!isDiary || !local || draft !== local) return;
    const seq = ++diaryRelatedSeq, id = local.record.id;
    if (!id) { diaryRelated = { list: [], count: 0, loaded: true, error: '' }; renderState(local.record); renderDiaryRelated(); return; }
    diaryRelated.loaded = false; diaryRelated.error = ''; renderDiaryRelated();
    try {
      const result = await api('/supervision-diaries/' + id + '/related-attachments');
      if (draft !== local || seq !== diaryRelatedSeq || $('fwEditor').hidden || String(local.record.id) !== String(id)) return;
      diaryRelated = { list: result.list || [], count: Number(result.count || 0), loaded: true, error: '' };
      local.record.relatedAttachmentIds = JSON.stringify(diaryRelated.list.map(document => document.id));
      renderState(local.record); renderDiaryRelated();
    } catch (error) {
      if (draft !== local || seq !== diaryRelatedSeq || $('fwEditor').hidden) return;
      diaryRelated.loaded = true; diaryRelated.error = '关联资料读取失败：' + (error.message || '请重试'); renderDiaryRelated();
    }
  }
  async function ensureDiaryDraftForAttachment() {
    if (draft.record.id) return draft.record;
    collect();
    if (!draft.body.projectId) throw new Error('请选择项目名称后再关联资料');
    if (pendingUploads.length) throw new Error('请先完成正在上传的文件，再保存草稿并关联资料');
    localSave();
    if (!draft.pending) draft.pending = { body: pack(kind, Object.assign({}, draft.body, { status: 'draft' })), id: null, version: null };
    persistDraft();
    let record;
    try { record = await api('/' + kind, { method: 'POST', body: draft.pending.body, headers: { 'Idempotency-Key': draft.requestId } }); }
    catch (error) { if ([400, 413, 415, 422].includes(error.code)) { draft.pending = null; persistDraft(); } throw error; }
    draft.record = record; draft.pending = null;
    if (!draft.body.code) draft.body.code = record.code;
    dirty = false; persistDraft();
    $('fwTitle').textContent = schema.title + ' · V' + (record.version || 1) + ' · ' + record.code;
    $('fwDelete').hidden = false; $('fwHistory').hidden = false; $('fwCompare').hidden = false;
    renderState(record);
    return record;
  }
  async function changeDiaryAttachment(documentId, attach) {
    const local = draft;
    if (!isDiary || !local || !editable(local.record) || local.record.status !== 'draft') throw new Error('仅本人可编辑草稿可以修改资料关联');
    await locked(async () => {
      await ensureDiaryDraftForAttachment();
      const id = local.record.id;
      diaryRelatedSeq++;
      const result = await api('/supervision-diaries/' + id + '/related-attachments/' + documentId, { method: attach ? 'PUT' : 'DELETE' });
      if (draft !== local || $('fwEditor').hidden || String(local.record.id) !== String(id)) return;
      local.record = result.diary;
      diaryRelated = { list: result.list || [], count: Number(result.count || 0), loaded: true, error: '' };
      if (diaryDayData) {
        const document = (diaryDayData.documents || []).find(item => String(item.id) === String(documentId));
        if (document) { document.diaryId = attach ? id : null; document.relatedDiary = attach ? diarySummaryLocal() : null; }
      }
      dirty = false; persistDraft(); renderState(local.record); renderDiaryRelated(); renderDiaryDay();
      notice(attach ? '资料已实时关联，服务器草稿及最新并发版本已同步。' : '已实时取消资料关联，最新并发版本已同步。');
    });
  }

  function filters() { return { projectId: $('fwProject').value, status: $('fwStatus').value, dateFrom: $('fwFrom').value, dateTo: $('fwTo').value, code: $('fwCode').value, authorId: $('fwMine').checked ? uid : undefined }; }
  function renderLocalRows() {
    const f = filters();
    const saved = page !== 1 || f.status && f.status !== 'draft' ? [] : savedDrafts().filter(({ value }) => {
      const body = value.body, date = body[schema.date] || '';
      return own(value.record) && (!body.projectId || projects.some(p => String(p.id) === String(body.projectId)))
        && (!f.projectId || String(body.projectId) === f.projectId)
        && (!f.dateFrom || date >= f.dateFrom) && (!f.dateTo || date <= f.dateTo)
        && (!f.code || String(body.code || '').includes(f.code));
    });
    $('fwLocalRows').innerHTML = saved.map(({ name, value }) => '<tr class="fw-local-row"><td data-label="编号">' + esc(value.body.code || '未编号') + (isDaily ? '<small class="ic-list-summary">' + esc(C.summary(value.body.checklist)) + '</small>' : '')
      + '</td><td data-label="项目">' + esc((projects.find(p => String(p.id) === String(value.body.projectId)) || {}).name || (value.body.projectId ? '项目#' + value.body.projectId : '未选择项目'))
      + '</td><td data-label="日期">' + esc(value.body[schema.date]) + '</td><td data-label="填写人">本人</td>'
      + '<td data-label="状态"><span class="fw-chip draft">本机未同步</span><small>草稿副本 · 非服务器状态</small></td>' + (isDaily ? '' : '<td data-label="业务版本">—</td>')
      + '<td data-label="操作"><button type="button" data-local="' + esc(name) + '">继续编辑本机内容</button></td></tr>').join('');
  }
  async function resumeLocal(name) {
    if (!await mayLeave()) return;
    const item = savedDrafts().find(saved => saved.name === name);
    if (!item) throw new Error('本机内容已更新，请重新查询列表');
    const value = item.value;
    if (!own(value.record) || value.body.projectId && !projects.some(p => String(p.id) === String(value.body.projectId))) throw new Error('当前账号无权继续编辑此草稿');
    dirty = true; await show(value, true); persistDraft();
    if (!item.name.startsWith(storageKey + ':draft:')) sessionStorage.removeItem(item.name);
    notice('已打开本机未同步内容；服务器记录可能已变化，请先对照服务器版本，再保存草稿。');
  }
  async function load() {
    const seq = ++querySeq;
    notice(''); renderLocalRows();
    // 先抹掉上一屏内容再请求：避免查询/翻页时旧记录短暂残留
    $('fwRows').innerHTML = '<tr data-app-placeholder="1"><td colspan="7" style="text-align:center;color:#9CA3AF;padding:24px;">数据加载中...</td></tr>';
    let data;
    try {
      data = await App.apiGetPage('/records/' + kind, Object.assign(filters(), { pageNum: page, pageSize: 20 }));
      assertAccount();
    } catch (error) {
      if (seq !== querySeq) return;
      $('fwRows').innerHTML = '<tr data-app-placeholder="1"><td colspan="7">服务器列表加载失败，请重新查询。本机未同步内容（如有）仍显示在上方。</td></tr>';
      $('fwPage').textContent = '服务器总数暂不可用'; $('fwSummary').textContent = '';
      $('fwPrev').disabled = true; $('fwNext').disabled = true;
      throw error;
    }
    if (seq !== querySeq) return;
    total = data.total; serverRows = data.list;
    $('fwRows').innerHTML = data.list.map(r => '<tr data-status="' + esc(r.status) + '"><td data-label="编号">' + esc(r.code) + (isDaily ? '<small class="ic-list-summary">' + esc(C.summary(r.checklist)) + '</small>' : '') + '</td><td data-label="项目">' + esc((projects.find(p => String(p.id) === String(r.projectId)) || {}).name || r.projectId) + '</td><td data-label="日期">' + esc(r[schema.date])
      + '</td><td data-label="填写人">' + esc(hasTemplate ? diaryPeople(r).author : r.authorName || r.authorId || r.inspectorId) + '</td><td data-label="状态"><span class="fw-chip ' + esc(chipClass(r.status)) + '">' + esc(statusText(kind, r.status)) + '</span></td>' + (isDaily ? '' : '<td data-label="业务版本">V' + esc(r.version || 1) + '</td>') + '<td data-label="操作"><button type="button" data-id="' + esc(r.id) + '">' + (own(r) && canEditStatus(kind, r.status) ? '继续编辑' : '查看 / 办理') + '</button>' + (isDaily && canDeleteRow(r) ? '<button type="button" data-del="' + esc(r.id) + '">删除</button>' : '') + '</td></tr>').join('') || '<tr data-app-placeholder="1"><td colspan="' + (isDaily ? 6 : 7) + '" style="text-align:center;color:#9CA3AF;padding:24px;">当前筛选下暂无服务器记录</td></tr>';
    $('fwPage').textContent = '服务器共 ' + total + ' 条，第 ' + page + ' / ' + Math.max(1, Math.ceil(total / 20)) + ' 页';
    $('fwPrev').disabled = page <= 1; $('fwNext').disabled = page * 20 >= total;
    if ($('fwProject').value) {
      const summary = await api('/field/summary?' + App.buildQuery({ projectId: $('fwProject').value, date: today() }));
      if (seq !== querySeq) return;
      const counts = summary[kind];
      $('fwSummary').textContent = isDaily
        ? '今日可见记录：草稿 ' + counts.draft + ' · 已保存 ' + counts.recorded + '（巡检作为现场备忘录，提交即保存，不计审核待办）'
        : '今日可见记录：草稿 ' + counts.draft + ' · 待审核 ' + counts.submitted + ' · 通过 ' + counts.approved + ' · 退回 ' + counts.rejected + '（不把草稿计为已提交）';
    } else $('fwSummary').textContent = '按服务器项目权限筛选；日期未选择时查询全部日期。';
  }
  // 日常巡检本人草稿与已保存记录均可删除：软删除保留历史留痕，已保存记录删除后日记侧关联链接由服务端标记失效
  async function deleteRow(id) {
    const row = serverRows.find(r => String(r.id) === String(id));
    if (!row || !canDeleteRow(row)) return;
    const message = row.status === 'draft'
      ? '删除本人草稿巡检记录？删除后列表不再显示该草稿。'
      : '删除本人已保存的巡检记录？历史留痕保留，监理日记中的关联链接将标记为失效。';
    if (!await App.confirm(message)) return;
    if (row.lockVersion == null) { notice('缺少记录版本，请重新查询后再删除'); return; }
    await locked(async () => {
      await api('/' + kind + '/' + id, { method: 'DELETE', headers: { 'X-Record-Version': row.lockVersion } });
      if (draft && draft.record && String(draft.record.id) === String(id)) { dirty = false; removeDraft(); closeEditor(); }
      await load();
    });
  }
  function collect() {
    if (!draft) return;
    linkEditors.forEach(editor => editor.collect());
    root.querySelectorAll('[data-field]').forEach(el => { draft.body[el.dataset.field] = el.value; });
    draft.body.projectId = Number(draft.body.projectId);
    if (isLog && participantLoaded && String(participantProjectId) === String(draft.body.projectId)) {
      draft.body.participants = JSON.stringify(Array.from(root.querySelectorAll('[data-participant-id]:checked')).map(el => Number(el.dataset.participantId)));
    }
    draft.body.photos = JSON.stringify(photos); draft.body.attachments = JSON.stringify(attachments);
  }
  function localSave() {
    collect();
    if (!draft || !editable(draft.record)) return;
    if (String(App.getUser().userId) !== uid) throw new Error('登录账号已变化，请保留本页内容并重新登录');
    dirty = true;
    persistDraft();
    renderState(draft.record);
    $('fwState').insertAdjacentHTML('beforeend', '<span class="diary-local-state">仅本机保存，尚未同步到服务器</span>');
  }
  function renderState(record) {
    if (!record) { $('fwState').textContent = ''; return; }
    const badge = isDiary ? diaryBadgeHtml() : '';
    if (!record.id) { $('fwState').innerHTML = '<span class="fw-chip draft">本机草稿</span>尚未同步到服务器' + badge; }
    else {
      const status = record.status || 'draft';
      const chip = '<span class="fw-chip ' + esc(chipClass(status)) + '">' + esc(statusText(kind, status)) + '</span>';
      const meta = (hasTemplate ? 'V' + (record.version || 1) + (record.sourceRecordId ? ' · 修订自记录 #' + record.sourceRecordId : '')
        + (record.status === 'draft' ? ' · 可编辑草稿' : ' · 原件已冻结，正文及附件不可覆盖') + ' · ' : '')
        + '并发版本 ' + (record.lockVersion == null ? '—' : record.lockVersion);
      $('fwState').innerHTML = chip + esc(meta) + badge
        + (!isDaily && record.rejectReason ? '<div class="fw-sub-reject">退回原因：' + esc(record.rejectReason) + '</div>' : '');
    }
    const button = $('fwDiaryBadge');
    if (button) button.onclick = () => { diaryBadgeOpen = !diaryBadgeOpen; renderState(draft.record); renderDiaryRelated(); if (diaryBadgeOpen) $('fwDiaryRelated').scrollIntoView({ block: 'nearest' }); };
  }
  function form(body, record) {
    const read = !editable(record), projectLocked = !!record.id || read;
    const topHtml = topKeys().map(field => fieldCell(field, body, read, projectLocked)).join('');
    // 填写指引面板已下线：仅保留输入框占位文案，日记工作区与关联资料容器照常渲染
    const extraHtml = (isDiary && !read ? '<div id="fwDiaryDay" class="fd-wide"></div>' : '')
      + (isDiary ? '<div id="fwDiaryRelated" class="fd-wide" hidden></div>' : '');
    let bodyHtml;
    if (isDiary) {
      bodyHtml = '<div class="fd-section-heading fd-wide">基础信息</div>' + topHtml + extraHtml
        + '<div class="fd-section-heading fd-wide">当日工作记录</div>'
        + longKeys().map(field => fieldCell(field, body, read, projectLocked, { wide: true })).join('');
    } else if (isLog) {
      const compatibility = compatibilityKeys(), hasLegacy = compatibility.some(field => String(body[field] || '').trim());
      bodyHtml = '<div class="fd-section-heading fd-wide">基础信息</div>' + topHtml + extraHtml
        + '<div class="fd-section-heading fd-wide">当日安全监理记录</div>'
        + longKeys().filter(field => !compatibility.includes(field)).map(field => fieldCell(field, body, read, projectLocked, { wide: true })).join('')
        + '<details class="fd-compat"' + (hasLegacy ? ' open' : '') + '><summary>原有栏目与日记整编内容（保留原文）</summary><div class="fd-compat-grid">'
        + compatibility.map(field => fieldCell(field, body, read, projectLocked, { wide: controlKind(field) === 'textarea' })).join('') + '</div></details>';
    } else if (schema.pcSections) {
      bodyHtml = '<div class="fd-section-heading fd-wide">基础信息</div>' + topHtml + extraHtml
        + schema.pcSections.map(section => (isDaily && section.fields.includes('issues') ? '<div class="fd-wide ic-workspace" id="fwChecklist"></div>' : '')
          + '<div class="fd-section-heading fd-wide">' + esc(section.title) + '</div>'
          + section.fields.map(field => fieldCell(field, body, read, projectLocked, { wide: controlKind(field) === 'textarea' })).join('')).join('');
    } else {
      const longs = longKeys(), grouped = longs.length >= 3;
      // 栏目标题统一承载必填红星，并去掉字段名里自带的星号，避免出现“* *”或样式不一致
      const sectionTitle = field => (labels[field] || field).replace(/\s*\*+$/, '');
      bodyHtml = extraHtml + topHtml + longs.map(field => grouped
        ? '<div class="fd-sec"><div class="fd-sec-title">' + esc(sectionTitle(field)) + (requiredKeys.has(field) ? '<span class="fd-req">*</span>' : '') + '</div>' + fieldCell(field, body, read, projectLocked, { wide: true, headless: true }) + '</div>'
        : fieldCell(field, body, read, projectLocked, { wide: true })).join('');
    }
    if (checklistView) { checklistView.destroy(); checklistView = null; }
    destroyLinks();
    closePicker();
    $('fwForm').innerHTML = bodyHtml;
    if (isLog) { renderParticipants(); void loadParticipants(draft); }
    if (isDiary && linkView) {
      const current = draft;
      const active = () => draft === current && !$('fwEditor').hidden && String((App.getUser() || {}).userId) === uid;
      links.fields.forEach(field => {
        const el = $('fwF-' + field); if (!el) return;
        linkEditors.push(linkView.mount(el, {
          label: labels[field], projectId: body.projectId, readOnly: read, current: active,
          valid: () => active() && !busy && editable(current.record),
          change: () => { fieldEdits[field] = (fieldEdits[field] || 0) + 1; try { localSave(); } catch (e) { notice('本机保存失败，请勿关闭页面：' + e.message); } },
          error: reportError
        }));
      });
    }
    if (isDaily) {
      const current = draft;
      checklistView = window.InspectionChecklistView($('fwChecklist'), {
        raw: () => current.body.checklist, readOnly: read, busy: () => busy || draft !== current,
        change: raw => { assertAccount(); if (draft !== current) throw new Error('记录已切换'); current.body.checklist = raw; localSave(); },
        upload: async file => { assertAccount(); const result = await App.uploadFile(file); assertAccount(); return result; },
        openFile, error: reportError
      });
    }
    const select = root.querySelector('[data-field="projectId"]');
    if (select) select.value = body.projectId || '';
    root.querySelectorAll('[data-field]').forEach(el => el.addEventListener('input', () => {
      fieldEdits[el.dataset.field] = (fieldEdits[el.dataset.field] || 0) + 1;
      if (el.dataset.field === schema.date || el.dataset.field === 'projectId') draft.body.diarySources = '[]';
      try { localSave(); } catch (e) { notice('本机保存失败，请勿关闭页面：' + e.message); }
    }));
    // 项目或日期变化后刷新当日摘要与审核权限，取数失败不影响填写
    root.querySelectorAll('[data-field="' + schema.date + '"], [data-field="projectId"]').forEach(el => el.addEventListener('change', () => {
      if (el.dataset.field === 'projectId') {
        if (isLog) draft.body.participants = '[]';
        attachments.forEach(a => { a.dirs = []; });
        defaultDirPaths = [];
        dirTreeInvalidate();
        renderMedia();
        renderDefaultDirTree();
        void ensureDirTree();
      }
      try { localSave(); } catch (e) { notice('本机保存失败，请勿关闭页面：' + e.message); }
      if (!draft.body.projectId || !draft.body[schema.date]) return;
      run(async () => { summaryCache = await api('/field/summary?' + App.buildQuery({ projectId: draft.body.projectId, date: draft.body[schema.date] })); })();
      if (isDiary) void loadDiaryWorkbench(draft);
    }));
    if ((isDaily || isSideline) && !read && window.FdDateTimePicker) window.FdDateTimePicker.enhance($('fwForm'));
    $('fwTitle').textContent = record.code ? schema.title + (hasTemplate ? ' · V' + (record.version || 1) : '') + ' · ' + record.code : '新建' + schema.title;
    renderState(record);
    // 已保存巡检只保留“保存修改”，不再提供保存草稿、审核通过/退回或建立修订稿
    const memo = isDaily && isSavedMemo(kind, record.status);
    ['fwSave', 'fwSubmit', 'fwUploadField'].forEach(id => $(id).hidden = read);
    $('fwSave').hidden = read || memo;
    $('fwSubmit').textContent = isDaily ? (memo ? '保存修改' : '提交') : submitLabel;
    $('fwSource').hidden = read || kind !== 'supervision-logs';
    $('fwPrefill').hidden = read || !isLog;
    $('fwDelete').hidden = read || !record.id || memo;
    $('fwRevise').hidden = !!draft.readOnly || !canReviseStatus(kind, record.status) || !own(record);
    $('fwRevise').textContent = record.status === 'rejected' ? '修订后重提 / 打开后续版本' : '建立修订稿 / 打开后续版本';
    $('fwHistory').textContent = hasTemplate ? '版本与处理历史' : '处理历史';
    ['fwApprove', 'fwReject'].forEach(id => $(id).hidden = isDaily || !!draft.readOnly || !reviewAllowed || !['submitted', 'pending'].includes(record.status));
    ['fwHistory', 'fwCompare'].forEach(id => $(id).hidden = !record.id);
    $('fwFork').hidden = !!draft.readOnly || !own(record) || hasTemplate && record.id && !canEditStatus(kind, record.status);
    $('fwHistoryContent').textContent = '';
    if (busy) $('fwEditor').querySelectorAll('button, input, textarea, select').forEach(e => e.disabled = true);
  }
  function openEditor() { $('fwEditor').hidden = false; document.body.classList.add('fw-modal-open'); }
  function cancelPrefill() { prefillSequence++; $('fwPrefillState').textContent = ''; }
  function destroyLinks() {
    linkEditors.forEach(editor => editor.destroy()); linkEditors = [];
  }
  function closeEditor() { diaryDaySeq++; diaryRelatedSeq++; participantSeq++; closePicker(); cancelPrefill(); destroyLinks(); dirTreeInvalidate(); if (checklistView) { checklistView.destroy(); checklistView = null; } $('fwEditor').hidden = true; document.body.classList.remove('fw-modal-open'); }
  async function prefillLog(automatic = false) {
    if (!isLog || !draft || busy || draft.pending || !editable(draft.record) || $('fwEditor').hidden) return;
    collect();
    const local = draft, projectId = draft.body.projectId, date = draft.body.logDate;
    const sequence = ++prefillSequence, edits = Object.assign({}, fieldEdits);
    const valid = () => sequence === prefillSequence && draft === local && !busy && !local.pending
      && !$('fwEditor').hidden && editable(local.record) && local.body.projectId === projectId && local.body.logDate === date;
    $('fwPrefillState').textContent = '正在读取同项目、日志当日的已审核日记，可继续填写…';
    try {
      const source = await api('/field/diary-prefill?' + App.buildQuery({ projectId, date }));
      if (!valid()) return;
      collect();
      const excluded = schema.prefillFields.filter(field => (fieldEdits[field] || 0) !== (edits[field] || 0) || automatic && fieldEdits[field]);
      const patch = logPrefillPatch(local.body, source, excluded), fields = Object.keys(patch);
      if (fields.length) {
        Object.assign(local.body, patch);
        fields.forEach(field => { const el = $('fwF-' + field); if (el) el.value = patch[field]; });
        const compatibility = $('fwForm').querySelector('.fd-compat');
        if (compatibility && fields.some(field => schema.legacyFields.includes(field))) compatibility.open = true;
        localSave();
      }
      $('fwPrefillState').textContent = fields.length ? '已预填 ' + fields.length + ' 个共享字段，仅供参考；可修改后保存，已有内容未覆盖。'
        : '暂无可预填的空白字段或当日已审核日记，已有内容保持不变。';
    } catch (e) {
      if (valid() && String((App.getUser() || {}).userId) === uid)
        $('fwPrefillState').textContent = '日记预填未完成：' + e.message + '。可继续手动填写，或点击“重新预填共享字段”。';
    }
  }
  async function show(local, autoPrefill = false) {
    cancelPrefill(); fieldEdits = {}; diaryDaySeq++; diaryRelatedSeq++;
    diaryDayData = null; diaryDayLoading = false; diaryDayError = ''; diaryBadgeOpen = false; diarySyncIndex = -1;
    diaryRelated = { list: [], count: parse(local.record.relatedAttachmentIds).length, loaded: !local.record.id, error: '' };
    draft = local;
    photos = parse(draft.body.photos).map(p => typeof p === 'string' ? { url: p } : p);
    attachments = parse(draft.body.attachments).map(p => typeof p === 'string' ? { url: p } : p);
    defaultDirPaths = [];
    dirTreeInvalidate();
    reviewAllowed = false;
    openEditor(); form(draft.body, draft.record); renderMedia(); renderDefaultDirTree();
    if (isDiary) {
      renderDiaryDay(); renderDiaryRelated();
      if (editable(draft.record)) void loadDiaryWorkbench(draft);
      if (draft.record.id) void loadDiaryRelated(draft);
    }
    await ensureDirTree();
    const body = $('fwEditor').querySelector('.fd-body'); if (body) body.scrollTop = 0;
    // 预填独立启动，统计接口延迟不能拖延取数或在保存后重新补回空栏。
    if (autoPrefill) void prefillLog(true);
    // 未选择项目（巡检/旁站新建）时不请求统计，避免无意义的参数错误提示
    if (draft.body.projectId) try {
      const summary = await api('/field/summary?' + App.buildQuery({ projectId: draft.body.projectId, date: draft.body[schema.date] }));
      if (draft !== local) return;
      summaryCache = summary;
      reviewAllowed = summary.canReview;
      ['fwApprove', 'fwReject'].forEach(id => $(id).hidden = isDaily || !!draft.readOnly || !reviewAllowed || !['submitted', 'pending'].includes(draft.record.status));
    } catch (e) { if (draft === local) notice(e.message); }
  }
  async function mayLeave() {
    if (checklistView) checklistView.guard();
    if (pendingUploads.length) throw new Error('仍有未成功上传的文件，请重试完成后再切换');
    if (dirty) { localSave(); return App.confirm('未同步内容已在当前标签页保留，可从列表“草稿”筛选继续编辑；关闭标签页可能丢失，请及时保存到服务器。确定返回或切换？', { danger: false }); }
    return true;
  }
  async function open(id, readOnly = false) {
    if (!await mayLeave()) return;
    const cached = !readOnly && savedDrafts().find(item => String(item.value.record.id) === String(id));
    if (cached) {
      dirty = true; await show(cached.value, true); persistDraft();
      if (!cached.name.startsWith(storageKey + ':draft:')) sessionStorage.removeItem(cached.name);
      notice('已恢复本机未同步内容，请先对照服务器版本。'); return;
    }
    const record = await api('/' + kind + '/' + id); dirty = false;
    const data = unpack(kind, record), body = {};
    ['code', 'projectId', schema.date, 'participants', 'photos', 'attachments', 'diarySources', 'weekStart', 'weekEnd'].concat(schema.fields.map(f => f[0]), schema.extraFields || []).forEach(k => { if (data[k] != null) body[k] = data[k]; });
    ['startTime', 'endTime'].forEach(k => { if (body[k]) body[k] = prettyTime(body[k]); });
    await show({ record, body, readOnly, requestId: key() }, true);
  }
  async function create() {
    if (!projects.length) throw new Error('暂无获授权项目，请联系管理员');
    // 巡检、旁站与监理日记的项目名称可在表单内直接选择；日志工程名称仍为只读带入，需先在上方选定项目
    if (isLog && !$('fwProject').value && projects.length > 1) {
      $('fwProject').focus();
      throw new Error(projectRequiredMessage);
    }
    if (!await mayLeave()) return;
    clearProjectNotice();
    const selected = Number($('fwProject').value);
    // 多项目且工具栏未选时不猜测归属：日记与巡检均留空，等待表单内明确选择；单项目可直接带入
    const fallback = isLog || projects.length === 1 ? projects[0].id : null;
    const body = { projectId: selected || fallback, [schema.date]: today(), photos: '[]', attachments: '[]' };
    if (isLog) body.participants = '[]';
    // 巡检新建时自动带入当前系统时间（精确到分钟），用户可在时间面板内按实际巡视时间调整
    if (isDaily) body.startTime = window.FieldSchema.nowMinute();
    dirty = false; await show({ record: { status: 'draft' }, body, requestId: key() }, true); localSave();
  }
  function openFile(url) {
    run(async () => {
      const target = window.open('about:blank', '_blank');
      if (target) target.opener = null;
      try { const result = await api('/files/access?' + App.buildQuery({ url })); if (target) target.location = result.url; else notice('请允许浏览器弹出附件窗口后重试'); }
      catch (e) { if (target) target.close(); throw e; }
    })();
  }
  function renderMedia() {
    const current = draft, editableNow = editable(draft.record);
    $('fwMedia').innerHTML = '';
    if (photos.length) {
      const field = document.createElement('div'); field.className = 'fd-field';
      field.innerHTML = '<div class="fd-label">现场照片（' + photos.length + '）</div>';
      const grid = document.createElement('div'); grid.className = 'fd-photo-grid';
      photos.forEach(item => {
        const card = document.createElement('div'); card.className = 'fd-photo-item';
        const thumb = document.createElement('div'); thumb.className = 'fd-photo-thumb';
        const image = document.createElement('img'); image.alt = item.description || '现场照片'; thumb.appendChild(image);
        api('/files/access?' + App.buildQuery({ url: item.url }))
          .then(link => { if (draft === current) image.src = link.url; })
          .catch(e => { if (draft === current) { thumb.textContent = e.message || '照片不可预览'; } });
        card.appendChild(thumb);
        if (isDaily) { const name = document.createElement('span'); name.className = 'ic-photo-name'; name.textContent = item.name || '现场照片'; card.appendChild(name); }
        if (editableNow) {
          const text = document.createElement('input'); text.placeholder = '照片部位说明'; text.value = item.description || '';
          text.oninput = () => { item.description = text.value; try { localSave(); } catch (e) { notice(e.message); } };
          card.appendChild(text);
        }
        const act = document.createElement('div'); act.className = 'fd-photo-act';
        const view = document.createElement('button'); view.type = 'button'; view.textContent = '查看'; view.onclick = () => openFile(item.url);
        act.appendChild(view);
        if (editableNow) {
          const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'fd-danger'; remove.textContent = '移除';
          remove.onclick = run(async () => { photos.splice(photos.indexOf(item), 1); localSave(); renderMedia(); });
          act.appendChild(remove);
        }
        card.appendChild(act);
        grid.appendChild(card);
      });
      field.appendChild(grid);
      $('fwMedia').appendChild(field);
    }
    if (attachments.length) {
      const field = document.createElement('div'); field.className = 'fd-field';
      field.innerHTML = '<div class="fd-label">附件材料（' + attachments.length + '）</div>';
      const list = document.createElement('div'); list.className = 'fd-files';
      attachments.forEach(item => {
        const row = document.createElement('div'); row.className = 'fd-file-row'; row.style.alignItems = 'flex-start';
        const info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0;';
        const name = document.createElement('div'); name.className = 'fd-file-name'; name.textContent = item.name || '已上传文件';
        info.appendChild(name);
        const dirWrap = document.createElement('div'); dirWrap.innerHTML = attachmentDirSectionHtml();
        const dirHost = dirWrap.firstElementChild;
        dirHost._attachment = item;
        dirHost._dirs = (item.dirs || []).filter(Boolean).slice();
        dirHost._readOnly = !editableNow;
        info.appendChild(dirHost);
        row.appendChild(info);
        const view = document.createElement('button'); view.type = 'button'; view.textContent = '查看'; view.onclick = () => openFile(item.url);
        row.appendChild(view);
        if (editableNow) {
          const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'fd-danger'; remove.textContent = '移除';
          remove.onclick = run(async () => { attachments.splice(attachments.indexOf(item), 1); localSave(); renderMedia(); });
          row.appendChild(remove);
        }
        list.appendChild(row);
        renderDirTree(dirHost);
      });
      field.appendChild(list);
      $('fwMedia').appendChild(field);
    }
    if (draft.body.diarySources) {
      const source = document.createElement('div'); source.className = 'fd-hint';
      source.textContent = '引用日记：' + parse(draft.body.diarySources).map(s => s.code + ' / ' + s.date + ' / v' + s.lockVersion).join('；');
      $('fwMedia').appendChild(source);
    }
  }

  /* ---------------- 常驻工程资料目录树；仅附件级 dirs 落库，默认目录只用于新附件继承 ---------------- */
  const DIR_CSS = ''
    + '.doc-section{background:#F0F5FF;border:1px solid #BFDBFE;border-radius:8px;padding:16px;margin-top:16px;}'
    + '.doc-section h5{font-size:13px;font-weight:600;color:#1E40AF;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;}'
    + '.doc-section .doc-desc{font-size:11px;color:#6B7280;margin-bottom:12px;}'
    + '.doc-tree{background:#fff;border:1px solid #E5E7EB;border-radius:6px;padding:8px;max-height:240px;overflow-y:auto;}'
    + '.doc-tree-node{padding:6px 8px;border-radius:4px;font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer;transition:background .15s;}'
    + '.doc-tree-node:hover{background:#F0F5FF;}'
    + '.doc-tree-node .expand-icon{font-size:10px;color:#9CA3AF;width:16px;text-align:center;flex-shrink:0;}'
    + '.doc-tree-node .node-icon{font-size:13px;flex-shrink:0;}'
    + '.doc-tree-node .node-label{flex:1;}'
    + '.doc-tree-node input[type="checkbox"]{accent-color:#2563EB;width:15px;height:15px;cursor:pointer;flex-shrink:0;}'
    + '.doc-tree-children{padding-left:24px;}'
    + '.doc-tree-children.collapsed{display:none;}'
    + '.selected-docs{margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;min-height:28px;}'
    + '.selected-doc-tag{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:11px;background:#DBEAFE;color:#1D4ED8;}'
    + '.selected-doc-tag .remove-tag{cursor:pointer;font-size:12px;color:#6B7280;margin-left:2px;}'
    + '.selected-doc-tag .remove-tag:hover{color:#DC2626;}'
    + '.selected-doc-empty{font-size:12px;color:#9CA3AF;}'
    + '.att-dir-tags{margin-top:10px;}.att-dir-tag{cursor:pointer;}'
    + '.doc-tree .demo-placeholder{padding:20px;text-align:center;color:#9CA3AF;font-size:13px;}';
  let defaultDirPaths = [], dirTreeData = null, dirTreeProjectId = null;
  let dirTreeReady = false, dirTreeLoadError = false, dirTreeLoadSeq = 0;
  function ensureDirTreeStyles() {
    if ($('fwDirInlineStyles')) return;
    const style = document.createElement('style'); style.id = 'fwDirInlineStyles'; style.textContent = DIR_CSS; document.head.appendChild(style);
  }
  function attachmentDirSectionHtml() {
    return '<div class="doc-section attachment-dir-section">'
      + '<h5><span>📂 所属工程资料</span><span class="dir-selected-count">已选 0 项</span></h5>'
      + '<div class="doc-desc">根据工程资料目录设置绑定，一个附件可对应多个目录</div>'
      + '<div class="doc-tree dir-tree-container"><div class="demo-placeholder">暂无工程资料目录，请先在“工程资料目录设置”中创建</div></div>'
      + '<div class="selected-docs dir-selected-tags att-dir-tags"><span class="selected-doc-empty">未选择工程资料目录</span></div></div>';
  }
  function defaultDirSectionHtml() {
    return '<div class="doc-section" id="fwDefaultDirSection">'
      + '<h5><span>📂 所属工程资料</span><span class="dir-selected-count" style="font-size:11px;font-weight:400;color:#6B7280;">已选 0 项</span></h5>'
      + '<div class="doc-desc">根据工程资料目录设置绑定，新上传的附件默认关联到所选目录，每个附件下方仍可单独调整</div>'
      + '<div class="doc-tree dir-tree-container"><div class="demo-placeholder">暂无工程资料目录，请先在“工程资料目录设置”中创建</div></div>'
      + '<div class="selected-docs dir-selected-tags"><span class="selected-doc-empty">未选择工程资料目录</span></div></div>';
  }
  function dirTreeInvalidate() {
    dirTreeLoadSeq++; dirTreeReady = false; dirTreeLoadError = false; dirTreeProjectId = null; dirTreeData = null;
  }
  function setDirTreePlaceholder(container, text) {
    if (!container) return;
    container.innerHTML = '';
    const placeholder = document.createElement('div'); placeholder.className = 'demo-placeholder'; placeholder.textContent = text;
    container.appendChild(placeholder);
  }
  function directoryHosts() { return Array.from(root.querySelectorAll('#fwDefaultDirs .doc-section, #fwMedia .attachment-dir-section')); }
  function renderDefaultDirTree() {
    const wrap = $('fwDefaultDirs'); if (!wrap || !draft) return;
    wrap.innerHTML = defaultDirSectionHtml();
    const host = wrap.firstElementChild;
    host._attachment = null; host._dirs = defaultDirPaths.slice(); host._readOnly = !editable(draft.record);
    renderDirTree(host);
  }
  function renderAllDirTrees() { directoryHosts().forEach(renderDirTree); }
  function appendDirTreeNodes(nodes, container, parentPath, host) {
    let leafCount = 0;
    (nodes || []).forEach(node => {
      if (!node || node.status === 'inactive') return;
      const path = parentPath ? parentPath + ' / ' + node.name : String(node.name || '');
      const children = (node.children || []).filter(child => child && child.status !== 'inactive');
      const row = document.createElement('div');
      row.className = 'doc-tree-node dir-tree-node ' + (children.length ? 'doc-parent-node parent-node' : 'doc-leaf-node leaf-node');
      row.setAttribute('data-path', path); row.setAttribute('data-project-id', String(node.projectId || ''));
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
      checkbox.disabled = children.length > 0 || host._readOnly || busy;
      if (!children.length) {
        checkbox.setAttribute('data-id', String(node.id)); checkbox.setAttribute('data-label', path);
        checkbox.addEventListener('change', () => updateSelectedDirList(host, true));
      }
      checkbox.addEventListener('click', event => event.stopPropagation()); row.appendChild(checkbox);
      const expand = document.createElement('span'); expand.className = 'expand-icon'; expand.textContent = children.length ? '▼' : '';
      if (!children.length) expand.style.visibility = 'hidden';
      row.appendChild(expand);
      const icon = document.createElement('span'); icon.className = 'node-icon'; icon.textContent = children.length ? '📁' : '📄'; row.appendChild(icon);
      const label = document.createElement('span'); label.className = 'node-label'; label.textContent = node.name || ''; label.title = path; row.appendChild(label);
      row.addEventListener('click', () => {
        if (children.length) { toggleDirTreeNode(row); return; }
        if (host._readOnly || busy) return;
        checkbox.checked = !checkbox.checked; updateSelectedDirList(host, true);
      });
      container.appendChild(row);
      if (children.length) {
        const childContainer = document.createElement('div'); childContainer.className = 'doc-tree-children dir-tree-children'; container.appendChild(childContainer);
        leafCount += appendDirTreeNodes(children, childContainer, path, host);
      } else leafCount++;
    });
    return leafCount;
  }
  function ensureDirTree() {
    const pid = String((draft && draft.body && draft.body.projectId) || ''), seq = ++dirTreeLoadSeq;
    if (!pid) {
      dirTreeProjectId = null; dirTreeData = null; dirTreeReady = false; dirTreeLoadError = false; renderAllDirTrees(); return Promise.resolve();
    }
    if (dirTreeReady && dirTreeProjectId === pid && dirTreeData) { renderAllDirTrees(); return Promise.resolve(); }
    dirTreeProjectId = pid; dirTreeData = null; dirTreeReady = false; dirTreeLoadError = false; renderAllDirTrees();
    if (!App.apiFetch) { dirTreeLoadError = true; renderAllDirTrees(); return Promise.resolve(); }
    return App.apiFetch('/sub-item-databases/tree?projectId=' + encodeURIComponent(pid)).then(tree => {
      if (seq !== dirTreeLoadSeq || String((draft && draft.body && draft.body.projectId) || '') !== pid) return;
      dirTreeData = Array.isArray(tree) ? tree : []; dirTreeReady = true; renderAllDirTrees();
    }).catch(() => {
      if (seq !== dirTreeLoadSeq || String((draft && draft.body && draft.body.projectId) || '') !== pid) return;
      dirTreeLoadError = true; renderAllDirTrees();
    });
  }
  function renderDirTree(host) {
    const container = host && host.querySelector('.dir-tree-container'); if (!container) return;
    const pid = String((draft && draft.body && draft.body.projectId) || '');
    if (!pid) { setDirTreePlaceholder(container, '暂无工程资料目录，请先在“工程资料目录设置”中创建'); renderDirTags(host); return; }
    if (dirTreeLoadError && dirTreeProjectId === pid) { setDirTreePlaceholder(container, '工程资料目录加载失败，请稍后重试'); renderDirTags(host); return; }
    if (!dirTreeReady || dirTreeProjectId !== pid || !dirTreeData) { setDirTreePlaceholder(container, '正在加载工程资料目录…'); renderDirTags(host); return; }
    container.innerHTML = '';
    const leafCount = appendDirTreeNodes(dirTreeData, container, '', host);
    if (!leafCount) { setDirTreePlaceholder(container, '暂无工程资料目录，请先在“工程资料目录设置”中创建'); renderDirTags(host); return; }
    applyDirSelection(host);
  }
  function applyDirSelection(host) {
    const selected = host._dirs || [];
    host.querySelectorAll('.dir-tree-container input[type="checkbox"][data-label]').forEach(checkbox => {
      checkbox.checked = selected.includes(checkbox.getAttribute('data-label'));
    });
    updateSelectedDirList(host, false);
  }
  function toggleDirTreeNode(row) {
    const children = row.nextElementSibling;
    if (!children || !children.classList.contains('doc-tree-children')) return;
    children.classList.toggle('collapsed');
    const icon = row.querySelector('.expand-icon');
    if (icon && icon.style.visibility !== 'hidden') icon.textContent = children.classList.contains('collapsed') ? '▶' : '▼';
  }
  function updateSelectedDirList(host, save) {
    const selected = [];
    host.querySelectorAll('.dir-tree-container input[type="checkbox"][data-label]').forEach(checkbox => {
      if (checkbox.checked) selected.push(checkbox.getAttribute('data-label'));
    });
    host._dirs = selected;
    if (host._attachment) host._attachment.dirs = selected.slice(); else defaultDirPaths = selected.slice();
    renderDirTags(host); syncDirParentCheckboxes(host);
    if (save && host._attachment && !host._readOnly) {
      try { localSave(); } catch (e) { notice(e.message); }
    }
  }
  function renderDirTags(host) {
    const tagsEl = host.querySelector('.dir-selected-tags'), countEl = host.querySelector('.dir-selected-count');
    if (!tagsEl || !countEl) return;
    const selected = host._dirs || []; countEl.textContent = '已选 ' + selected.length + ' 项'; tagsEl.innerHTML = '';
    if (!selected.length) {
      const empty = document.createElement('span'); empty.className = 'selected-doc-empty'; empty.textContent = '未选择工程资料目录'; tagsEl.appendChild(empty); return;
    }
    selected.forEach(path => {
      const tag = document.createElement('span'); tag.className = 'selected-doc-tag att-dir-tag'; tag.setAttribute('data-path', path);
      tag.setAttribute('role', 'button'); tag.setAttribute('tabindex', '0'); tag.title = path + '（点击定位到目录树，可重新修改）';
      tag.appendChild(document.createTextNode(path)); tag.addEventListener('click', () => focusDirTreePath(host, path));
      tag.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusDirTreePath(host, path); } });
      if (!host._readOnly) {
        const remove = document.createElement('span'); remove.className = 'remove-tag remove-dir-tag'; remove.textContent = '✕';
        remove.addEventListener('click', event => { event.stopPropagation(); removeDirTag(host, path); }); tag.appendChild(remove);
      }
      tagsEl.appendChild(tag);
    });
  }
  function focusDirTreePath(host, path) {
    const checkbox = Array.from(host.querySelectorAll('.dir-tree-container input[type="checkbox"][data-label]'))
      .find(el => el.getAttribute('data-label') === path);
    if (checkbox) {
      let children = checkbox.closest('.doc-tree-children');
      while (children) {
        children.classList.remove('collapsed');
        const parentRow = children.previousElementSibling, icon = parentRow && parentRow.querySelector('.expand-icon');
        if (icon) icon.textContent = '▼';
        children = children.parentElement.closest('.doc-tree-children');
      }
      checkbox.scrollIntoView({ block: 'center', behavior: 'smooth' }); checkbox.focus({ preventScroll: true }); return;
    }
    const container = host.querySelector('.dir-tree-container'); if (container) container.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function removeDirTag(host, path) {
    if (host._readOnly || busy) return;
    const checkbox = Array.from(host.querySelectorAll('.dir-tree-container input[type="checkbox"][data-label]'))
      .find(el => el.getAttribute('data-label') === path);
    if (checkbox) { checkbox.checked = false; updateSelectedDirList(host, true); return; }
    host._dirs = (host._dirs || []).filter(value => value !== path);
    if (host._attachment) host._attachment.dirs = host._dirs.slice(); else defaultDirPaths = host._dirs.slice();
    renderDirTags(host);
  }
  function syncDirParentCheckboxes(host) {
    const rows = Array.from(host.querySelectorAll('.dir-tree-container .doc-tree-node'));
    for (let i = rows.length - 1; i >= 0; i--) {
      const checkbox = rows[i].querySelector('input[type="checkbox"]'), children = rows[i].nextElementSibling;
      if (!checkbox || !children || !children.classList.contains('doc-tree-children')) continue;
      const direct = Array.from(children.querySelectorAll(':scope > .doc-tree-node > input[type="checkbox"]'));
      if (!direct.length) continue;
      const allChecked = direct.every(child => child.checked), anyChecked = direct.some(child => child.checked || child.indeterminate);
      checkbox.checked = allChecked; checkbox.indeterminate = !allChecked && anyChecked;
    }
  }
  function syncDirectoryControls() {
    directoryHosts().forEach(host => host.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
      checkbox.disabled = !checkbox.hasAttribute('data-label') || host._readOnly || busy;
    }));
  }
  ensureDirTreeStyles();
  async function locked(action) {
    if (busy) return;
    if (checklistView) checklistView.guard();
    cancelPrefill();
    linkEditors.forEach(editor => { editor.guard(); editor.cancel(); });
    busy = true; $('fwEditor').querySelectorAll('button, input, textarea, select').forEach(e => e.disabled = true);
    try { await action(); } finally {
      busy = false; $('fwEditor').querySelectorAll('button, input, textarea, select').forEach(e => e.disabled = false);
      syncDirectoryControls();
      if (isLog) renderParticipants();
      const select = root.querySelector('[data-field="projectId"]'); if (select && draft) select.disabled = !!draft.record.id || !editable(draft.record);
      if (isDaily && draft && !editable(draft.record)) root.querySelectorAll('[data-ic-field], [data-problem-field]').forEach(e => e.disabled = true);
    }
  }
  // 保存后当前筛选可能把刚保存的记录筛掉，必要时重置项目/状态/日期/编号以展示它
  function revealSaved(record) {
    if ($('fwProject').value && String($('fwProject').value) !== String(record.projectId)) $('fwProject').value = '';
    if ($('fwStatus').value && $('fwStatus').value !== 'recorded') $('fwStatus').value = '';
    const date = record[schema.date] || '';
    if ($('fwFrom').value && date < $('fwFrom').value) $('fwFrom').value = '';
    if ($('fwTo').value && date > $('fwTo').value) $('fwTo').value = '';
    if ($('fwCode').value && !String(record.code || '').includes($('fwCode').value)) $('fwCode').value = '';
  }
  async function save(submit) {
    if (!draft || !editable(draft.record)) throw new Error('原版本已冻结，请通过修订入口建立下一版本');
    if (checklistView) checklistView.guard();
    linkEditors.forEach(editor => editor.guard());
    collect();
    // 项目未选时可继续填写，但保存/提交前必须明确归属，避免写入 0 号项目
    if (!draft.body.projectId) {
      const pick = $('fwF-projectId'); if (pick) pick.focus();
      throw new Error('请选择项目名称（工程名称）后再' + (submit ? '提交' : '保存草稿'));
    }
    if (isDaily && submit && !draft.pending) { localSave(); C.pack(draft.body, true); }
    if (pendingUploads.length) throw new Error('请先重试未成功上传的文件，不能显示表单已完成');
    // 巡检是现场备忘录：提交/保存修改直接写服务器，不弹审核或正文锁定确认
    const memo = isDaily && submit && !!draft.record.id && isSavedMemo(kind, draft.record.status);
    if (submit && !isDaily && !await App.confirm('核对项目、日期、正文及照片后提交审核？提交后正文锁定。', { danger: false })) return;
    await locked(async () => {
      localSave();
      if (!draft.pending) draft.pending = { body: pack(kind, Object.assign({}, draft.body, { status: memo ? 'recorded' : 'draft' })), id: draft.record.id, version: draft.record.lockVersion };
      persistDraft();
      const pending = draft.pending, path = '/' + kind + (pending.id ? '/' + pending.id : '');
      let record;
      try { record = await api(path, { method: pending.id ? 'PUT' : 'POST', body: pending.body, headers: pending.id ? { 'X-Record-Version': pending.version } : { 'Idempotency-Key': draft.requestId } }); }
      catch (error) {
        if ([400, 413, 415, 422].includes(error.code)) { draft.pending = null; persistDraft(); }
        if (error.code !== 409 || !pending.id) throw error;
        const remote = await api(path);
        if (!(isDaily ? C.sameBody(kind, remote, pending.body) : Object.keys(pending.body).every(k => JSON.stringify(remote[k] == null ? null : remote[k]) === JSON.stringify(pending.body[k] == null ? null : pending.body[k])))) throw error;
        record = remote;
      }
      // 巡检“保存修改”的预期终态是已保存，比较基线必须同样用 recorded，否则会把成功请求当成待确认。
      const current = pack(kind, Object.assign({}, draft.body, { status: memo ? 'recorded' : 'draft' }));
      draft.record = record; draft.pending = null;
      if (isDaily && record.checklist) draft.body.checklist = C.mergeFoundBy(draft.body.checklist, record.checklist);
      if (!draft.body.code || draft.body.code === pending.body.code) draft.body.code = record.code;
      persistDraft();
      if (isDaily ? !(C.sameBody(kind, current, pending.body) && C.sameBody(kind, pending.body, current)) : JSON.stringify(current) !== JSON.stringify(pending.body)) {
        notice('此前未确认的请求已恢复；本机新修改仍保留，请再次保存后提交。'); return;
      }
      if (submit && !memo) {
        try { record = await api('/' + kind + '/' + record.id + '/submit', { method: 'POST', headers: { 'X-Record-Version': record.lockVersion } }); }
        catch (error) { const remote = await api('/' + kind + '/' + record.id); if (!['submitted', 'approved', 'recorded', 'pending'].includes(remote.status)) throw error; record = remote; }
        draft.record = record;
      }
      dirty = false; removeDraft();
      // 巡检保存成功后关闭弹窗并回到列表首页；其他记录保持现状，便于核对审核结果
      if (submit && isDaily) { closeEditor(); revealSaved(record); page = 1; await load(); }
      else { await show(draft); await load(); }
      notice(memo ? '巡检修改已保存，可在数据列表中继续查看或再次编辑。'
        : submit ? (isDaily ? '巡检已保存到数据列表，不进入审核。' : '服务器已确认提交审核，正文已锁定；可在列表“已提交（待审核）”中查看。')
        : '服务器草稿已保存，可关闭编辑器后在列表“草稿”中继续编辑；PC 与小程序可见同一记录。');
    });
  }
  async function review(status) {
    let reason = '';
    if (status === 'rejected') { reason = await App.prompt({ title: '填写退回原因' }); if (reason == null) return; }
    else if (!await App.confirm('确认审核通过当前正文及附件？', { danger: false, okText: '审核通过' })) return;
    await locked(async () => { draft.record = await api('/' + kind + '/' + draft.record.id + '/approve', { method: 'POST', body: { status, rejectReason: reason }, headers: { 'X-Record-Version': draft.record.lockVersion } }); await show(draft); await load(); });
  }
  async function exportRows() {
    const rows = []; let number = 1; const params = filters();
    while (true) { const data = await App.apiGetPage('/records/' + kind, Object.assign({}, params, { pageNum: number++, pageSize: 100 })); assertAccount(); rows.push(...data.list); if (rows.length >= data.total || !data.list.length) break; }
    const exportNames = new Map();
    if (isLog) {
      const projectIds = [...new Set(rows.map(r => r.projectId).filter(Boolean))];
      await Promise.all(projectIds.map(async projectId => {
        const list = await api('/field/projects/' + encodeURIComponent(projectId) + '/member-options');
        (list || []).forEach(person => exportNames.set(String(person.userId), person.userName));
      }));
    }
    const fields = [['code', '编号'], ['projectId', '项目 ID'], [schema.date, '日期'], ['status', '状态']]
      .concat(isLog ? [['participants', '参会人员']] : [], hasTemplate ? [['version', '业务版本'], ['sourceRecordId', '上一版本记录 ID'], ['submittedAt', '提交时间'], ['reviewedAt', '审核时间'], ['rejectReason', '驳回原因']] : [])
      .concat(hasTemplate ? [['projectName', '工程名称'], ['authorName', AUTHOR_LABEL], ['reviewerName', '审核人及审核记录']] : [], schema.fields,
        isLog ? [['weekStart', '周起始日期'], ['weekEnd', '周结束日期'], ['photos', '照片清单'], ['attachments', '附件清单'], ['diarySources', '引用日记']] : [],
        isDaily ? [['inspectionSummary', '检查统计'], ['inspectionDetails', '检查项与问题明细'], ['fileNames', '照片与附件名称']] : []);
    const cell = value => '"' + String(value == null ? '' : value).replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"';
    const csv = [fields.map(f => cell(f[1].replace(/\s*\*+$/, ''))).join(',')].concat(rows.map(r => {
      const data = unpack(kind, r);
      if (isLog) data.participants = participantText(r.participants, exportNames);
      if (isDaily) { data.inspectionSummary = C.summary(r.checklist); data.inspectionDetails = C.format(r.checklist); data.fileNames = parse(r.photos).concat(parse(r.attachments)).map(f => f.name || '附件').join('、'); data.status = statusText(kind, r.status); }
      ['startTime', 'endTime'].forEach(k => { if (data[k]) data[k] = prettyTime(data[k]); });
      if (hasTemplate) {
        const people = diaryPeople(r);
        Object.assign(data, { projectName: (projects.find(p => String(p.id) === String(r.projectId)) || {}).name || '项目#' + r.projectId, authorName: people.author, reviewerName: people.reviewer, status: statuses[r.status] || r.status });
      }
      return fields.map(f => cell(isDiary && links && links.fields.includes(f[0]) ? links.readable(data[f[0]]) : data[f[0]])).join(',');
    })).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = schema.title + '-' + today() + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  $('fwSearch').onclick = run(async () => { page = 1; await load(); });
  $('fwStatus').onchange = run(async () => { page = 1; await load(); });
  $('fwLocalRows').onclick = run(async event => { const button = event.target.closest('[data-local]'); if (button) await resumeLocal(button.dataset.local); });
  $('fwPrev').onclick = run(async () => { page--; await load(); }); $('fwNext').onclick = run(async () => { page++; await load(); });
  $('fwRows').onclick = run(async event => { const del = event.target.closest('[data-del]'); if (del && del.dataset.del) { await deleteRow(del.dataset.del); return; } const button = event.target.closest('[data-id]'); if (button) await open(button.dataset.id); });
  $('fwNew').onclick = run(create); $('fwExport').onclick = run(exportRows);
  $('fwProject').onchange = () => {
    if (projects.some(p => String(p.id) === $('fwProject').value)) clearProjectNotice();
  };
  // 关闭与取消只关闭编辑器：未点“保存草稿”就丢弃本次暂存，列表不留下这条；保存草稿仅由底部按钮执行
  const dismissEditor = run(async () => { removeDraft(); closeEditor(); dirty = false; renderLocalRows(); });
  $('fwClose').onclick = dismissEditor; $('fwCancel').onclick = dismissEditor;
  $('fwSave').onclick = run(() => save(false)); $('fwSubmit').onclick = run(() => save(true));
  $('fwApprove').onclick = run(() => review('approved')); $('fwReject').onclick = run(() => review('rejected'));
  $('fwDelete').onclick = run(async () => { if (!await App.confirm('删除本人草稿？')) return; await locked(async () => { await api('/' + kind + '/' + draft.record.id, { method: 'DELETE', headers: { 'X-Record-Version': draft.record.lockVersion } }); dirty = false; removeDraft(); closeEditor(); await load(); }); });
  $('fwRevise').onclick = run(async () => {
    if (!draft || draft.readOnly || !own(draft.record) || !canReviseStatus(kind, draft.record.status)) return;
    if (!await App.confirm('原版本的正文、附件和审核信息将永久保留。建立下一版草稿？已有后续版本时将直接打开。', { danger: false })) return;
    if (hasTemplate) {
      const record = await api('/' + kind + '/' + draft.record.id + '/new-version', { method: 'POST' });
      dirty = false; await open(record.id); await load();
      notice('已打开 V' + (record.version || 1) + '，原版本保持不变；草稿修改后需重新提交审核。');
    } else {
      const body = Object.assign({}, draft.body, { sourceRecordId: draft.record.id }); delete body.code;
      await show({ record: { status: 'draft' }, body, requestId: key() }, true); localSave();
    }
  });
  $('fwFork').onclick = run(async () => {
    if (!await App.confirm('原记录保持不变；另存副本可能形成重复填报，请核对后再提交。', { danger: false })) return;
    if (checklistView) checklistView.guard();
    localSave();
    const body = Object.assign({}, draft.body); delete body.code; delete body.sourceRecordId;
    if (isDaily && body.checklist) body.checklist = C.stringify(C.writable(body.checklist));
    await show({ record: { status: 'draft' }, body, requestId: key() }, true); localSave();
  });
  function snapshotHtml(record) {
    if (!isDiary || !linkView) return '<pre>' + esc(JSON.stringify(record, null, 2)) + '</pre>';
    const meta = Object.assign({}, record);
    links.fields.forEach(field => { delete meta[field]; });
    return '<pre>' + esc(JSON.stringify(meta, null, 2)) + '</pre>' + links.fields.map(field => '<h4>' + esc(labels[field]) + '</h4><div class="fd-history-body" data-diary-raw="' + esc(record[field] || '') + '"></div>').join('');
  }
  function renderSnapshotLinks() {
    if (isDiary && linkView) $('fwHistoryContent').querySelectorAll('[data-diary-raw]').forEach(el => linkView.render(el, el.dataset.diaryRaw, reportError));
  }
  function versionHtml(record) {
    const values = unpack(kind, record);
    const people = diaryPeople(record);
    return '<details><summary>V' + esc(record.version || 1) + ' · ' + esc(statusText(kind, record.status)) + ' · ' + esc(record[schema.date]) + '</summary>'
      + '<p>编号：' + esc(record.code) + ' · 填写人：' + esc(people.author) + '</p><p>提交：' + esc(record.submittedAt || '尚未提交') + ' · 审核：' + esc(people.reviewer) + '</p>'
      + (record.rejectReason ? '<p class="fw-sub-reject">驳回原因：' + esc(record.rejectReason) + '</p>' : '')
      + (isLog ? '<h4>参会人员</h4><p>' + esc(participantText(record.participants) || '—') + '</p>' : '')
      + schema.fields.map(f => '<h4>' + esc(f[1]) + '</h4>' + (isDiary && links && links.fields.includes(f[0])
        ? '<div class="fd-history-body" data-diary-raw="' + esc(values[f[0]] || '') + '"></div>'
        : '<p style="white-space:pre-wrap">' + esc(values[f[0]] == null ? '' : values[f[0]]) + '</p>')).join('')
      + '<h4>该版本照片与附件</h4>' + parse(record.photos).concat(parse(record.attachments)).map(f => {
        const file = typeof f === 'string' ? { url: f } : f;
        return '<button type="button" data-version-file="' + esc(file.url) + '">' + esc(file.name || '查看附件') + '</button>';
      }).join('') + '</details>';
  }
  $('fwHistory').onclick = run(async () => {
    const current = draft, path = '/' + kind + '/' + current.record.id;
    const [history, versions] = await Promise.all([api(path + '/history'), hasTemplate ? api(path + '/versions') : Promise.resolve([])]);
    if (draft !== current || $('fwEditor').hidden) return;
    $('fwHistoryContent').innerHTML = (hasTemplate ? '<h3>版本留痕（V1 至当前版本）</h3>' + versions.map(versionHtml).join('') + '<h3>当前版本操作快照</h3>' : '')
      + history.map(h => '<details><summary>' + esc(h.actorName + ' · ' + h.action + ' · ' + h.createTime) + '</summary><p>' + esc(h.reason) + '</p>' + snapshotHtml(JSON.parse(h.snapshot)) + '</details>').join('');
    $('fwHistoryContent').querySelectorAll('[data-version-file]').forEach(button => { button.onclick = () => openFile(button.dataset.versionFile); });
    renderSnapshotLinks();
  });
  $('fwCompare').onclick = run(async () => { const current = draft; const remote = await api('/' + kind + '/' + current.record.id); if (draft !== current || $('fwEditor').hidden) return; $('fwHistoryContent').innerHTML = '<h3>服务器当前版本（本机表单未覆盖）</h3>' + snapshotHtml(remote); renderSnapshotLinks(); });
  $('fwPrefill').onclick = run(() => prefillLog(false));
  $('fwSource').onclick = run(async () => { cancelPrefill(); collect(); const source = await api('/field/diary-source?' + App.buildQuery({ projectId: draft.body.projectId, date: draft.body.logDate })); let filled = false; schema.fields.forEach(f => { if (!String(draft.body[f[0]] || '').trim() && source[f[0]]) { draft.body[f[0]] = source[f[0]]; filled = true; } }); if (filled) draft.body.diarySources = JSON.stringify(source.sources); form(draft.body, draft.record); localSave(); renderMedia(); notice(filled ? '只填入空白栏目，来源已关联；请人工确认后提交。' : '没有可填入内容，原文未改变。'); });
  async function uploadPending() {
    await locked(async () => {
      const failed = [];
      for (const entry of pendingUploads) {
        try {
          $('fwUploadState').textContent = '正在上传：' + entry.file.name;
          if (!entry.remote) { entry.remote = await App.uploadFile(entry.file); assertAccount(); }
          const list = entry.file.type.startsWith('image/') ? photos : attachments;
          if (!list.some(p => p.url === entry.remote.url)) {
            const uploaded = Object.assign({}, entry.remote, { source: 'album', description: '' });
            if (list === attachments) uploaded.dirs = defaultDirPaths.slice();
            list.push(uploaded);
          }
          localSave(); await renderMedia();
        } catch (e) { entry.error = e.message; failed.push(entry); }
      }
      pendingUploads = failed;
      $('fwRetryUpload').hidden = !failed.length;
      $('fwUploadState').textContent = failed.length ? failed.map(x => x.file.name + '：' + x.error).join('；') + '。请勿关闭本页，可逐次重试。' : '全部附件已上传；请继续保存表单。';
    });
  }
  async function queueFiles(files) {
    const list = Array.from(files || []); if (!list.length) return;
    pendingUploads.push(...list.map(file => ({ file })));
    await uploadPending();
  }
  $('fwUpload').onchange = run(async event => { const files = Array.from(event.target.files || []); event.target.value = ''; await queueFiles(files); });
  $('fwRetryUpload').onclick = run(uploadPending);
  const dropzone = $('fwUploadLabel');
  ['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, event => { event.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'dragend'].forEach(name => dropzone.addEventListener(name, event => { event.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', event => {
    event.preventDefault(); dropzone.classList.remove('dragover');
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) run(() => queueFiles(files))();
  });
  $('fwPrint').onclick = run(() => {
    if (checklistView) checklistView.print();
    linkEditors.forEach(editor => editor.collect());
    collect();
    if (isLog) {
      const host = $('fwF-participants'), text = document.createElement('div');
      text.className = 'fw-print-value'; text.textContent = participantText(draft.body.participants) || '—'; text.style.whiteSpace = 'pre-wrap'; host.after(text);
    }
    const fields = Array.from($('fwForm').querySelectorAll('textarea, input, select')).filter(el => el.type !== 'checkbox' && !el.hidden && !el.closest('#fwChecklist') && !el.closest('#fwDiaryDay') && !el.closest('#fwDiaryRelated'));
    fields.forEach(el => { const text = document.createElement('div'); text.className = 'fw-print-value'; text.textContent = el.tagName === 'SELECT' ? (el.options[el.selectedIndex] || {}).text || '' : el.value; text.style.whiteSpace = 'pre-wrap'; el.after(text); el.hidden = true; });
    const collapsed = Array.from($('fwForm').querySelectorAll('details:not([open])'));
    collapsed.forEach(el => { el.open = true; });
    document.body.classList.add('fw-print');
    try { window.print(); } finally { document.body.classList.remove('fw-print'); collapsed.forEach(el => { el.open = false; }); fields.forEach(el => { el.hidden = false; }); root.querySelectorAll('.fw-print-value').forEach(el => el.remove()); }
  });
  window.addEventListener('beforeunload', event => {
    const hasLocal = String((App.getUser() || {}).userId) === uid && savedDrafts().length > 0;
    if (App.getToken() && (dirty || pendingUploads.length || hasLocal || checklistView && checklistView.hasUnsaved())) { event.preventDefault(); event.returnValue = ''; }
  });
  run(async () => {
    let n = 1;
    while (true) { const data = await App.apiGetPage('/projects', { pageNum: n++, pageSize: 100 }); projects.push(...data.list); if (projects.length >= data.total || !data.list.length) break; }
    $('fwProject').insertAdjacentHTML('beforeend', options(projects));
    if (hasTemplate) root.querySelector('thead th:nth-child(4)').textContent = AUTHOR_LABEL;
    await load();
    const params = new URLSearchParams(location.search), id = params.get('id');
    if (id) {
      if (!/^\d+$/.test(id)) throw new Error(schema.title + '编号参数无效');
      await open(id, params.get('readonly') === 'true');
    }
  })();
})();
