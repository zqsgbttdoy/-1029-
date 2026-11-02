/* PC 与原生小程序共用的受限正文模型，不解析任意 HTML。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DiaryLinks = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  const fields = ['construction', 'management', 'inspection', 'otherWork', 'otherMatters', 'morningMeeting', 'newIssues', 'materialInspection', 'drawingReview'];
  const sources = [
    ['daily-inspections', '日常巡检'], ['sideline-inspections', '旁站检查'], ['supervision-notices', '监理通知单'],
    ['work-contacts', '工作联系单'], ['project-documents', '工程资料']
  ];
  const pattern = () => /\[((?:\\[\\\[\]()]|[^\]\\\r\n]){1,500})\]\((file-reference\.html\?[^\s()]{1,2000})\)/g;
  function normalize(file) {
    file = String(file || '').replace(/\\/g, '/').replace(/^uploads\//, '/api/uploads/').replace(/^\/uploads\//, '/api/uploads/');
    if (file.length > 500 || !/^\/api\/uploads\/(?:[0-9]{8}\/)?[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(file)) throw new Error('附件路径无效');
    return file;
  }
  function stable(item) {
    if (!sources.some(s => s[0] === item.sourceType) || !/^[1-9][0-9]{0,18}$/.test(String(item.sourceId))) throw new Error('文件来源无效');
    return 'file-reference.html?sourceType=' + item.sourceType + '&sourceId=' + item.sourceId + '&file=' + encodeURIComponent(normalize(item.file));
  }
  function target(raw, base) {
    let url = String(raw || '');
    // 绝对地址必须属于当前部署的精确目录，不能接受外站同名路由或任意重定向参数。
    if (base && url.startsWith(base.replace(/\/$/, '') + '/')) url = url.slice(base.replace(/\/$/, '').length + 1);
    if (!url.startsWith('file-reference.html?') || /[\s#()]/.test(url)) throw new Error('仅支持本站文件关联链接');
    const params = {};
    url.slice('file-reference.html?'.length).split('&').forEach(pair => {
      const i = pair.indexOf('=');
      if (i < 1) throw new Error('链接参数无效');
      const key = decodeURIComponent(pair.slice(0, i)), value = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      if (!['sourceType', 'sourceId', 'file'].includes(key) || Object.prototype.hasOwnProperty.call(params, key)) throw new Error('链接参数无效');
      params[key] = value;
    });
    if (Object.keys(params).length !== 3) throw new Error('链接参数不完整');
    params.file = normalize(params.file); stable(params);
    return Object.assign({ type: 'file', name: params.file.split('/').pop() }, params);
  }
  function parse(text) {
    text = String(text == null ? '' : text);
    const nodes = []; let last = 0, match; const re = pattern();
    while ((match = re.exec(text))) {
      let item; try { item = target(match[2]); } catch (e) { continue; }
      if (match.index > last) nodes.push({ type: 'text', text: text.slice(last, match.index) });
      item.name = match[1].replace(/\\([\\\[\]()])/g, '$1'); nodes.push(item); last = re.lastIndex;
    }
    if (last < text.length || !nodes.length) nodes.push({ type: 'text', text: text.slice(last) });
    return nodes;
  }
  function format(item) {
    if (item.type === 'text') return item.text || '';
    const name = String(item.name || item.file.split('/').pop()).replace(/[\r\n]/g, ' ');
    const escaped = name.replace(/[\\\[\]()]/g, '\\$&');
    if (escaped.length > 500) throw new Error('文件名过长，无法作为正文链接');
    return '[' + escaped + '](' + stable(item) + ')';
  }
  function serialize(nodes) { return nodes.map(format).join(''); }
  function editableNodes(text) {
    const result = [{ type: 'text', text: '' }];
    parse(text).forEach(node => {
      if (node.type === 'text') result[result.length - 1].text += node.text;
      else result.push(node, { type: 'text', text: '' });
    });
    return result;
  }
  // 只在用户粘贴／编辑时识别裸稳定地址，历史读取仍只使用 parse。
  function pasted(text, base) {
    const result = [];
    parse(text).forEach(node => {
      if (node.type === 'file') { result.push(node); return; }
      const re = /(?:https?:\/\/[^\s<>\u0080-\uffff]+|file-reference\.html\?[^\s<>\u0080-\uffff]+)/g; let match, last = 0;
      while ((match = re.exec(node.text))) {
        if (match.index && /[a-zA-Z0-9_./:@\\-]/.test(node.text[match.index - 1])) continue;
        let item; try { item = target(match[0], base); } catch (e) { continue; }
        if (match.index > last) result.push({ type: 'text', text: node.text.slice(last, match.index) });
        result.push(item); last = re.lastIndex;
      }
      if (last < node.text.length || !node.text.length) result.push({ type: 'text', text: node.text.slice(last) });
    });
    return result;
  }
  function identity(item) { return item.sourceType + ':' + item.sourceId + ':' + normalize(item.file); }
  function readable(text) { return parse(text).map(n => n.type === 'text' ? n.text : n.name + '（' + stable(n) + '）').join(''); }
  return { fields, sources, normalize, stable, target, parse, format, serialize, editableNodes, pasted, identity, readable };
});
