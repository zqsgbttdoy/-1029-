// 只初始化固定独立验收端口；不连接既有服务，不写业务数据库。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const base = process.env.E2E_BASE || 'http://127.0.0.1:18131';
const L = require('../../补后端/miniprogram/utils/diary-links');
let token;
async function api(url, method = 'GET', body, headers = {}) {
  const response = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}), ...headers }, body: body == null ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error(url + ': ' + JSON.stringify(result));
  return result.data;
}
async function upload(name, contents, type = 'text/plain') {
  const form = new FormData(); form.append('file', new Blob([contents], { type }), name);
  const response = await fetch(base + '/api/files/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error(JSON.stringify(result));
  return result.data;
}
(async () => {
  token = (await api('/auth/login', 'POST', { username: 'admin', password: '123456' })).token;
  const run = randomUUID(), date = new Date().toLocaleDateString('sv-SE');
  const project = await api('/projects', 'POST', { name: '日记双向关联独立验收工程', code: 'LINK-' + run, buildUnit: '独立验收建设单位', status: 'active', managerId: 1 });
  const folder = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '质量证明资料', status: 'active' });
  const second = await api('/sub-item-databases', 'POST', { projectId: project.id, name: '其他资料', status: 'active' });
  const spare = await upload('分页占位原件.txt', '只用于独立验收分页，不是伪造的来源文件。');
  for (let i = 0; i < 22; i++) await api('/project-documents', 'POST', { projectId: project.id, subItemId: folder.id, name: '分页资料-' + (i + 1) + '.txt', filePath: spare.url, fileSize: spare.size });
  const name = '中文(原件)[A]复核-地下室主体结构混凝土材料进场验收质量证明长文件名.txt';
  const file = await upload(name, '监理日记双向关联验收原件\n该文本为实际上传文件，用于受权原件访问测试。');
  const document = await api('/project-documents', 'POST', { projectId: project.id, subItemId: folder.id, name, filePath: file.url, fileSize: file.size });

  const daily = await api('/daily-inspections', 'POST', { projectId: project.id, inspectionDate: date, location: '地下室一层', content: '当天已保存巡检内容', issues: '现场问题已记录', photos: '[]', attachments: JSON.stringify([{ url: file.url, name: '巡检真实附件.txt', dirs: [folder.name] }]) });
  await api('/daily-inspections/' + daily.id + '/submit', 'POST', undefined, { 'X-Record-Version': daily.lockVersion });
  await api('/daily-inspections', 'POST', { projectId: project.id, inspectionDate: date, location: '不应显示', content: '草稿巡检不应显示', photos: '[]', attachments: '[]' });

  const noticeInput = { projectId: project.id, noticeDate: date, code: 'NOTICE-' + run.slice(0, 8), title: '当天已发出通知', content: '通知单关键内容', photos: '[]', attachments: '[]' };
  const notice = await api('/supervision-notices', 'POST', noticeInput);
  await api('/supervision-notices/' + notice.id, 'PUT', { ...noticeInput, status: 'issued' });
  await api('/supervision-notices', 'POST', { ...noticeInput, code: 'NOTICE-DRAFT-' + run.slice(0, 8), title: '草稿通知不应显示' });

  const contactInput = { projectId: project.id, contactDate: date, code: 'CONTACT-' + run.slice(0, 8), title: '当天已发送联系单', content: '联系单关键内容', photos: '[]', attachments: JSON.stringify([{ url: file.url, name: '联系单目录附件.txt', dirs: [folder.name] }]) };
  const contact = await api('/work-contacts', 'POST', contactInput);
  await api('/work-contacts/' + contact.id, 'PUT', { ...contactInput, status: 'sent' });

  const manifest = { run, base, projectId: project.id, folderId: folder.id, secondFolderId: second.id, date, documentId: document.id, name, file: file.url,
    dailyText: '当天已保存巡检内容', noticeText: '当天已发出通知', contactText: '当天已发送联系单',
    stableUrl: base + '/' + L.stable({ sourceType: 'project-documents', sourceId: document.id, file: file.url }) };
  fs.writeFileSync(path.join(__dirname, 'fixture.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
