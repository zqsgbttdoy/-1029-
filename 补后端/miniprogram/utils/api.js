const config = require('../config');
function namespace() { return 'field:' + config.baseUrl; }
function session() { return wx.getStorageSync(namespace() + ':session') || null; }
function saveSession(value) { wx.setStorageSync(namespace() + ':session', value); }
function logout() { wx.removeStorageSync(namespace() + ':session'); }
function userId() { const s = session(); return s && s.token ? String(s.userId) : null; }
function isAdmin() { const s = session(); return !!(s && Array.isArray(s.roles) && s.roles.indexOf('admin') >= 0); }
function assertUser(uid) { if (!uid || userId() !== String(uid)) throw new Error('登录身份已变化，请重新打开草稿'); }
function baseUrl() {
  if (/^https:\/\/[^/]+$/.test(config.baseUrl)) return config.baseUrl;
  // 本机调试专用：开发者工具勾选「不校验合法域名」后允许 http://127.0.0.1|localhost(:端口)；线上仍强制 HTTPS。
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(config.baseUrl)) return config.baseUrl;
  throw new Error('请先在 config.js 配置 HTTPS 服务域名（仅本机调试可用 127.0.0.1/localhost 的 http 地址）');
}
function response(res, uid) {
  if (uid) assertUser(uid);
  let body = res.data;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { throw new Error('服务器响应无法解析'); } }
  if (res.statusCode === 401 || body && body.code === 401) {
    if (!uid || userId() === uid) logout();
    const error = new Error('登录已过期，草稿仍在本机，请重新登录'); error.code = 401; throw error;
  }
  if (res.statusCode < 200 || res.statusCode >= 300 || !body || body.code !== 200) {
    const error = new Error(body && body.message || '请求失败，请重试'); error.code = body && body.code || res.statusCode; throw error;
  }
  return body.data;
}
// wx.request 的 GET 会把 undefined/null 拼成字符串 "undefined"/"null"，导致后端按该值过滤（列表为空）或类型转换 400；统一剔除。
function query(data) {
  if (!data || typeof data !== 'object') return data;
  const out = {};
  Object.keys(data).forEach(k => { if (data[k] !== undefined && data[k] !== null) out[k] = data[k]; });
  return out;
}
function request(path, method = 'GET', data, headers = {}) {
  return new Promise((resolve, reject) => {
    let url; try { url = baseUrl() + '/api' + path; } catch (e) { reject(e); return; }
    const s = session(); const uid = userId();
    if (method === 'GET') data = query(data);
    wx.request({ url, method, data, timeout: 30000,
      header: Object.assign({ 'Content-Type': 'application/json' }, s && s.token ? { Authorization: 'Bearer ' + s.token } : {}, headers),
      success: res => { try { resolve(response(res, uid)); } catch (e) { reject(e); } },
      fail: () => reject(new Error('网络不可用，已保存的本机草稿不会丢失')) });
  });
}
function upload(filePath) {
  return new Promise((resolve, reject) => {
    const uid = userId();
    try { assertUser(uid); baseUrl(); } catch (e) { reject(e); return; }
    wx.uploadFile({ url: baseUrl() + '/api/files/upload', filePath, name: 'file', timeout: 120000,
      header: { Authorization: 'Bearer ' + session().token },
      success: res => { try { resolve(response(res, uid)); } catch (e) { reject(e); } },
      fail: () => reject(new Error('照片上传失败，可联网后重试')) });
  });
}
async function fileUrl(url) { const data = await request('/files/access', 'GET', { url }); return baseUrl() + data.url; }
function referenceUrl(item) { return baseUrl() + '/' + require('./diary-links').stable(item); }
async function referenceAccess(item, projectId) {
  const data = await request('/files/reference-access', 'GET', { sourceType: item.sourceType, sourceId: item.sourceId, file: item.file });
  if (projectId && String(data.projectId) !== String(projectId)) throw new Error('不可关联其他项目文件，粘贴文字已保留');
  return data;
}
async function openReference(item) {
  const uid = userId(), data = await referenceAccess(item);
  assertUser(uid);
  const type = String(data.type || '').toLowerCase(), image = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(type);
  if (!image && !['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(type)) throw new Error('小程序不支持此格式，请复制稳定链接到浏览器下载原件');
  const result = await new Promise((resolve, reject) => wx.downloadFile({ url: baseUrl() + data.url, success: resolve, fail: () => reject(new Error('无法下载原件，请检查网络后重试')) }));
  assertUser(uid);
  if (result.statusCode !== 200) throw new Error('资料已删除／不可用，请刷新后重试');
  await new Promise((resolve, reject) => {
    const common = { success: resolve, fail: () => reject(new Error('此文件无法在小程序打开，请复制稳定链接到浏览器下载原件')) };
    if (image) wx.previewImage(Object.assign({ current: result.tempFilePath, urls: [result.tempFilePath] }, common));
    else wx.openDocument(Object.assign({ filePath: result.tempFilePath, fileType: type, showMenu: true }, common));
  });
}
async function allProjects() {
  const list = []; let page = 1;
  while (true) {
    const data = await request('/projects', 'GET', { pageNum: page++, pageSize: 100 });
    list.push(...data.list);
    if (list.length >= data.total || !data.list.length) return list;
  }
}
module.exports = { namespace, session, saveSession, logout, userId, isAdmin, assertUser, request, upload, fileUrl, allProjects, referenceUrl, referenceAccess, openReference };
