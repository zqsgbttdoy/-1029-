/**
 * extract-docx-text.js
 * 从 .docx 中提取纯文本（段落 + 表格单元格），用于内容核对。
 * 运行：node extract-docx-text.js <输入.docx>
 */
'use strict';

const fs = require('fs');
const JSZip = require('jszip');

const file = process.argv[2];
if (!file) { console.error('用法：node extract-docx-text.js <输入.docx>'); process.exit(1); }

JSZip.loadAsync(fs.readFileSync(file)).then(function (zip) {
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('不是有效的 docx（缺少 word/document.xml）');
  return entry.async('string');
}).then(function (xml) {
  // 段落结束换行；表格单元格用 | 分隔
  let text = xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  text = text.split('\n').map(function (l) { return l.replace(/[ \t]+$/g, ''); }).join('\n');
  console.log(text);
}).catch(function (e) { console.error('❌ 提取失败：', e.message); process.exit(1); });
