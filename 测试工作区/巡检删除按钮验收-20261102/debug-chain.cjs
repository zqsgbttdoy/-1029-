// 链路调试：login → 巡检 create → submit → 输出各步响应
const BASE = 'http://127.0.0.1:18130/api';
async function req(path, { method = 'GET', body, token, headers } = {}) {
  const h = Object.assign({}, headers);
  if (token) h.Authorization = 'Bearer ' + token;
  const opts = { method, headers: h };
  if (body !== undefined) { opts.body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + path, opts);
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}
(async () => {
  const login = await req('/auth/login', { method: 'POST', body: { username: 'admin', password: '123456' } });
  const token = login.json.data.token;
  const today = new Date().toISOString().slice(0, 10);
  const checklist = JSON.stringify({ version: 1, items: [{ id: 'i1', category: '一般', content: '检查临边防护', method: '目测', standard: '专项方案', required: true, result: 'compliant', problems: [] }] });
  const body = { projectId: 2, inspectionDate: today, location: '验收A区', content: '调试记录', checklist, photos: '[]', attachments: '[]' };
  const created = await req('/daily-inspections', { method: 'POST', body, token, headers: { 'Idempotency-Key': require('crypto').randomUUID().replace(/-/g, '') } });
  console.log('CREATE', created.status, JSON.stringify(created.json).slice(0, 300));
  if (created.status === 200) {
    const rec = created.json.data;
    const sub = await req('/daily-inspections/' + rec.id + '/submit', { method: 'POST', token, headers: { 'X-Record-Version': rec.lockVersion } });
    console.log('SUBMIT', sub.status, JSON.stringify(sub.json).slice(0, 300));
  }
})();
