const inspectionChecklist = typeof module !== 'undefined' ? require('./inspection-checklist') : window.InspectionChecklist;
const weather = [['weather', '天气'], ['wind', '风力'], ['temperature', '气温']];
const logLegacy = [['content', '工作内容（日记整编／原有记录）'], ['management', '管理情况（原有栏目）'], ['morningMeeting', '晨会情况（原有栏目）'], ['drawingReview', '图纸审查（原有栏目）']];
const schemas = {
  'supervision-diaries': {
    title: '监理日记', date: 'diaryDate',
    fields: weather.concat([
      ['construction', '施工部位及形象进度'], ['management', '施工管理情况'], ['inspection', '监理工作情况'],
      ['otherWork', '其他工作'], ['otherMatters', '其他事项'], ['morningMeeting', '晨会计划工作安排'],
      ['newIssues', '工作中的新问题'], ['materialInspection', '材料进场检查'], ['drawingReview', '审图情况']
    ]),
    guide: '按当天本专业实际情况逐项记录，无相关事项时据实说明“无”。填写提示不会自动写入正文。提交仍需填写天气、至少一项施工部位及形象进度／施工管理／监理工作内容，并上传至少一张现场照片。',
    hints: {
      projectId: '由系统根据已选项目自动带入工程名称，请核对项目归属。',
      diaryDate: '新建时由系统生成当天日期；编辑、恢复草稿或修订时保留原记录日期。',
      author: '应由专业监理／监理员记录；系统按实际登录账号记录，不支持代填姓名。',
      reviewer: '由项目总监或维保项目部负责人按项目审核权限审阅；这里显示电子审核记录，需手写签字时请打印后签署。',
      weather: '准确记录当天气象信息；本专业当日形象进度在“施工部位及形象进度”中简要概述。',
      wind: '记录当天风向、风力及明显变化。',
      temperature: '记录当天气温或最低／最高气温，注明 ℃。',
      construction: '准确说明本专业施工的具体部位及当日形象进度。',
      management: '重点记录施工单位现场管理人员是否在岗，是否严格按施工方案或措施组织施工。',
      inspection: '按早、中、晚记录现场巡视、旁站、平行检验、验收、见证等监理工作内容及完成情况。',
      otherWork: '列明参加的专题会议、考察调研活动，以及配合其他相关方开展的工作。',
      otherMatters: '记录除气象外的不可抗力或停水、停电等事件（按实际原因说明），相关会议议题，施工、业主、设计单位要求或来文，以及公司、上级主管部门检查意见和要求。',
      morningMeeting: '根据项目负责人对本专业提出的计划，说明晨会工作安排。',
      newIssues: '记录现场新出现的涉及工程进度、质量、造价、安全等方面的问题。',
      materialInspection: '记录材料进场检查、见证取样送检，以及桩基静载、低应变动力检测、实体检测等现场检测；包括原材料、混凝土与砂浆试块、钢筋焊接接头等施工试验的进行情况。',
      drawingReview: '围绕图纸的合规性、一致性、合理性及细节问题进行审查并记录。'
    },
    placeholders: {
      weather: '例：晴转多云，午后短时阵雨', wind: '例：东北风 3～4 级', temperature: '例：18～26 ℃',
      construction: '填写：楼栋／楼层／轴线或区段、施工工序、当日完成量及进展。',
      management: '填写：管理人员岗位及到岗情况、方案／措施执行情况、偏差与处理结果。',
      inspection: '早：时间、部位、监理方式、工作内容及结果。\n中：工作内容及完成情况。\n晚：复查情况、未完成事项及后续跟踪。',
      otherWork: '填写：会议／活动名称、时间、参与方、本人工作及结果；无则据实说明。',
      otherMatters: '分项填写：事件起止时间、原因及影响；会议议题；来文单位、编号及要求；检查意见和落实情况。',
      morningMeeting: '填写：负责人提出的任务、本专业计划工作、责任人、完成时限及重点要求。',
      newIssues: '填写：问题类别、发现时间与部位、具体情况及影响、已采取措施、待协调事项。',
      materialInspection: '填写：材料名称／规格／批次／数量、进场检查结果、取样与送检编号、检测或试验项目、进行情况及结果（待出结果请注明）。',
      drawingReview: '填写：图号／版本、审查部位、合规性／一致性／合理性／细节问题、沟通意见及处理进展。'
    }
  },
  'supervision-logs': {
    title: '监理日志', date: 'logDate',
    fields: weather.concat([
      ['construction', '施工部位及形象进度'], ['inspection', '巡视检查内容、资料审核及验收情况'],
      ['safetyIssues', '存在的安全问题及处理结果'], ['otherMatters', '重大事项']
    ], logLegacy),
    legacyFields: logLegacy.map(f => f[0]),
    prefillFields: ['weather', 'wind', 'temperature', 'construction', 'inspection', 'safetyIssues', 'otherMatters', 'management', 'morningMeeting', 'drawingReview'],
    prefillHint: '打开新建或可编辑日志时，按日志日期自动预填同项目已审核日记的共享字段，仅补空白且未手动改动的栏目。施工进度、监理工作分别对应施工进度、巡视验收；“工作中的新问题”原文供安全问题栏参考，请筛选并补充处理结果。多份日记按字段合并，气象信息不一致时留空供核对；不复制姓名、编号、附件或来源标记，也不会自动提交。',
    guide: '由项目安全监理工程师按当日实际情况记录，无相关事项时据实说明“无”。填写提示不进入正文；提交需至少一项实际工作记录。原巡检情况、其他事项分别保留在巡视验收、重大事项栏，其余旧栏目及日记整编内容在下方保留，不自动拆分或推断安全结论。',
    attachmentHint: '应提供与安全监理行为或验收结果相关的材料，例如：签发的《监理工程师通知单》、相关专题会议纪要、签发的《工程暂停令》，以及脚手架、机械、吊篮等设备的第三方验收单。',
    hints: {
      projectId: '由系统根据已选项目自动带入工程名称，请核对项目归属。',
      logDate: '新建时由系统生成当天日期；编辑、恢复草稿或修订时保留原记录日期。',
      author: '应由项目安全监理工程师负责记录；系统按实际登录账号记录，不支持代填姓名。',
      reviewer: '显示原审批流程中的实际审核人员、时间和状态，不代表手写签字。',
      weather: '准确记录当天气象信息；本专业工程的当日形象进度在“施工部位及形象进度”中简要概述。',
      wind: '记录当天风向、风力及明显变化。',
      temperature: '记录当天气温或最低／最高气温，注明 ℃。',
      construction: '记录现场施工的当前具体部位及其形象进度进展。',
      inspection: '现场安全巡查项目包括但不限于：\n①专职安全员是否在岗履职；\n②特种作业人员是否持有有效证件上岗；\n③施工机械运行状态是否正常，有无进出场登记及环保合规记录；\n④临时用电系统安全状态；\n⑤脚手架、吊篮、升降机、吊车等设备的验收记录与现场状态检查。请记录资料审核及验收结果。',
      safetyIssues: '明确当日施工区域是否存在重大危险源，描述当天整体安全生产现状与异常问题，并记录采取的措施、处理结果及尚需跟踪的事项。',
      otherMatters: '如发生安全事故、停工、重要会议、主管部门检查等需记录的重大事件，应在此栏填写。',
      content: '保留原工作内容及日记整编原文；请核对后在上方对应栏目填写当日记录，不自动推断或拆分旧内容。',
      management: '保留原管理情况记录，按实际情况补充。',
      morningMeeting: '保留原晨会情况记录，按实际情况补充。',
      drawingReview: '保留原图纸审查记录，按实际情况补充。'
    }
  },
  'daily-inspections': {
    title: '日常巡检', date: 'inspectionDate',
    fields: [['location', '检查部位'], ['startTime', '巡检时间'], ['workerCount', '施工人数'], ['manageCount', '管理人数'], ['content', '巡视内容'], ['issues', '发现问题补充说明']],
    extraFields: ['checklist'],
    shortFields: ['startTime', 'workerCount', 'manageCount'],
    pcSections: [
      { title: '时间与现场人数', fields: ['startTime', 'workerCount', 'manageCount'] },
      { title: '巡视内容', fields: ['location', 'content'] },
      { title: '发现问题补充说明', fields: ['issues'] }
    ],
    hints: {
      inspectionDate: '新建时默认当天，可按实际巡视日期修改。',
      startTime: '新建时自动带入当前时间（精确到分钟），可按实际巡视时间调整。',
      workerCount: '可选，填写现场施工人数；0 表示无人，留空表示未记录。',
      manageCount: '可选，填写现场管理人数，须为非负整数。',
      projectId: '从获授权项目中选择本次填报项目。',
      location: '选填；写明楼栋、楼层、轴线或区段，便于复查问题。',
      content: '选填；按时间顺序记录巡视部位、检查内容与结果；具体问题可在检查项中单独记录。',
      issues: '记录问题类别、部位、已采取措施、责任人与复查结果；无问题请填“无”。'
    },
    placeholders: {
      location: '例：3 号楼 5 层东侧模板支撑区（轴线 A~C / 1~3）',
      startTime: '例：2026-11-09 09:30',
      content: '例：上午 9:00 巡视 5 层模板支撑体系，立杆间距、扫地杆、剪刀撑符合专项方案；抽查 12 处扣件扭矩全部合格。',
      issues: '例：3 根立杆底部垫板缺失，已通知施工班组补齐，下午复查合格。'
    }
  },
  'sideline-inspections': {
    title: '旁站检查', date: 'inspectionDate',
    fields: [['location', '旁站部位 *'], ['process', '旁站工序 *'], ['startTime', '开始时间（YYYY-MM-DD HH:mm:ss）*'], ['endTime', '结束时间（YYYY-MM-DD HH:mm:ss）*'], ['manageCount', '施工管理人员数（非负整数）*'], ['workerCount', '施工人员数（非负整数）*'], ['result', '旁站结果 *'], ['docsText', '关联工程资料编号 / 名称（每行一项）*'], ['issuesText', '发现问题及处理情况'], ['content', '其他旁站记录']],
    shortFields: ['startTime', 'endTime', 'manageCount', 'workerCount'],
    pcSections: [
      { title: '旁站范围', fields: ['location', 'process'] },
      { title: '时间与现场人员', fields: ['startTime', 'endTime', 'manageCount', 'workerCount'] },
      { title: '检查结论与关联资料', fields: ['result', 'docsText'] },
      { title: '现场情况与问题处理', fields: ['issuesText', 'content'] }
    ],
    hints: {
      inspectionDate: '新建时默认当天，可按实际旁站日期修改。',
      projectId: '从获授权项目中选择本次填报项目。',
      location: '填写旁站的具体部位，如“2 号楼 3 层顶板梁板钢筋”。',
      process: '填写本次旁站的工序名称，如“梁板钢筋绑扎隐蔽验收”。',
      startTime: '点选日期与时间（整点 + 5 分钟一档），须早于结束时间。',
      endTime: '点选日期与时间（整点 + 5 分钟一档），须晚于开始时间。',
      manageCount: '填写现场施工单位管理人员实际人数，非负整数。',
      workerCount: '填写现场施工人员实际人数，非负整数。',
      result: '写明检查结论，是否同意进入下道工序。',
      docsText: '每行一项，可填资料编号或名称；提交至少需要一项。',
      issuesText: '记录旁站期间发现的问题及处理情况；无问题请填“无”。',
      content: '补充旁站过程、见证取样等需要说明的情况。'
    },
    placeholders: {
      location: '例：2 号楼 3 层顶板梁板钢筋隐蔽工程',
      process: '例：梁板钢筋绑扎隐蔽验收旁站',
      startTime: '例：2026-10-29 08:00:00',
      endTime: '例：2026-10-29 11:30:00',
      manageCount: '例：3',
      workerCount: '例：12',
      result: '例：钢筋规格、间距、锚固长度及保护层厚度符合设计要求，同意进入下道工序。',
      docsText: '例：钢筋进场复验报告 GJ-2026-031\n例：隐蔽工程验收记录 YS-2026-079',
      issuesText: '例：无异常；或写明问题、处理措施与复查结果。',
      content: '例：旁站期间无异常，见证取样混凝土试块 2 组。'
    }
  }
};
function today(date) { const d = date || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
// 巡检新建默认时间：当前系统时间精确到分钟，格式与后端 LocalDateTime 兼容
function nowMinute(date) {
  const d = date || new Date();
  return today(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function minuteOfToday() { return nowMinute(new Date()); }
const statuses = { draft: '草稿', submitted: '待审核', pending: '待审核', approved: '审核通过', rejected: '已退回', recorded: '已记录', fixed: '已整改' };
// 日常巡检作为现场备忘录：历史提交/审核状态统一按“已保存”使用，不再产生审核待办；不修改全局 statuses
const memoStatuses = ['recorded', 'submitted', 'pending', 'approved', 'rejected', 'fixed', 'active'];
function isSavedMemo(kind, status) { return kind === 'daily-inspections' && memoStatuses.includes(status); }
function statusText(kind, status) {
  status = status || 'draft';
  if (kind === 'daily-inspections') return status === 'draft' ? statuses.draft : isSavedMemo(kind, status) ? '已保存' : status;
  return ['submitted', 'pending'].includes(status) ? '已提交（待审核）' : statuses[status] || status;
}
// 已保存巡检允许本人继续更新同一条记录；其他记录仅草稿/退回可改
function canEditStatus(kind, status) {
  status = status || 'draft';
  if (kind === 'daily-inspections') return status === 'draft' || isSavedMemo(kind, status);
  if (['supervision-diaries', 'supervision-logs'].includes(kind)) return status === 'draft';
  return ['draft', 'rejected'].includes(status);
}
function canReviseStatus(kind, status) {
  return kind !== 'daily-inspections' && (status === 'approved'
    || ['supervision-diaries', 'supervision-logs'].includes(kind) && status === 'rejected');
}
function unpack(kind, input) {
  const body = Object.assign({}, input);
  if (kind === 'sideline-inspections') {
    try {
      const detail = JSON.parse(body.content);
      if (detail && typeof detail === 'object') {
        Object.assign(body, { process: detail.process || '', result: detail.result || '', manageCount: detail.manageCount,
          workerCount: detail.workerCount, docsText: (detail.docs || []).join('\n'),
          issuesText: typeof detail.issues === 'string' ? detail.issues : JSON.stringify(detail.issues || []), content: detail.text || '' });
      }
    } catch (e) { /* 旧文字记录原样保留，正式提交时补全旁站必填项。 */ }
  }
  return body;
}
function pack(kind, input) {
  if (kind === 'daily-inspections') return inspectionChecklist.pack(input, false);
  const body = Object.assign({}, input);
  if (kind === 'sideline-inspections') {
    body.content = JSON.stringify({ process: body.process || '', result: body.result || '',
      manageCount: body.manageCount === '' || body.manageCount == null ? null : Number(body.manageCount),
      workerCount: body.workerCount === '' || body.workerCount == null ? null : Number(body.workerCount),
      docs: (body.docsText || '').split('\n').map(s => s.trim()).filter(Boolean), issues: body.issuesText || '', text: body.content || '' });
    ['process', 'result', 'manageCount', 'workerCount', 'docsText', 'issuesText'].forEach(k => delete body[k]);
    ['startTime', 'endTime'].forEach(k => { if (body[k]) body[k] = body[k].replace(' ', 'T'); else body[k] = null; });
  }
  return body;
}
function diaryPeople(record, currentUser) {
  record = record || {}; currentUser = currentUser || {};
  const author = record.authorName || (record.authorId != null ? '用户#' + record.authorId
    : record.inspectorId != null ? '用户#' + record.inspectorId : record.id ? '原记录未记录人员' : currentUser.userName || '当前登录账号');
  const reviewed = record.reviewerId != null || !!record.reviewedAt;
  const reviewer = reviewed ? (record.reviewerName || (record.reviewerId != null ? '用户#' + record.reviewerId : '未记录姓名'))
    + ' · ' + (record.reviewedAt || '时间未记录')
    + ' · ' + (record.status === 'approved' ? '审核通过' : record.status === 'rejected' ? '退回修改' : '上次审核记录，本次尚未通过')
    : record.status === 'approved' ? '历史记录已审核，审核人员／时间缺失' : '尚未审核';
  return { author, reviewer };
}
function logPrefillPatch(body, source, excluded = []) {
  const patch = {};
  schemas['supervision-logs'].prefillFields.forEach(field => {
    const value = source && source[field];
    const limit = ['weather', 'wind', 'temperature'].includes(field) ? 30 : 60000;
    if (!excluded.includes(field) && !String(body[field] == null ? '' : body[field]).trim()
        && typeof value === 'string' && value.trim() && value.length <= limit) patch[field] = value;
  });
  return patch;
}
const fieldSchema = { schemas, today, nowMinute, minuteOfToday, statuses, memoStatuses, isSavedMemo, statusText, canEditStatus, canReviseStatus, pack, unpack, diaryPeople, logPrefillPatch, inspectionChecklist };
if (typeof module !== 'undefined') module.exports = fieldSchema;
else window.FieldSchema = fieldSchema;
