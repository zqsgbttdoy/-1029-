/**
 * generate-md-to-docx.js
 * 通用 Markdown -> Word(.docx) 轻量转换器，专为部署指南排版。
 * 支持：# / ## / ### 标题、表格、``` 代码块、> 引用、- / 1. 列表、--- 分隔、**粗体**。
 * 运行：node generate-md-to-docx.js <输入.md> <输出.docx>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType, VerticalAlign, HeadingLevel,
} = require('docx');

const src = process.argv[2];
const out = process.argv[3];
if (!src || !out) {
  console.error('用法：node generate-md-to-docx.js <输入.md> <输出.docx>');
  process.exit(1);
}
const mdLines = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n').split('\n');

const CN = '微软雅黑';
const MONO = 'Consolas';
const ACCENT = '1E3A5F';
const CODE_BG = 'F2F4F7';
const TABLE_BG = 'EAF1FF';
const BORDER = 'BFBFBF';

// 解析一行内的 **粗体**，返回 TextRun[]
function inlineRuns(text, base) {
  base = base || {};
  const runs = [];
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  for (const p of parts) {
    if (!p) continue;
    const m = /^\*\*(.+)\*\*$/.exec(p);
    if (m) {
      runs.push(new TextRun({ text: m[1], bold: true, font: base.font || CN, size: base.size, color: base.color }));
    } else {
      runs.push(new TextRun({ text: p, font: base.font || CN, size: base.size, color: base.color, bold: base.bold }));
    }
  }
  if (!runs.length) runs.push(new TextRun({ text: '', font: CN }));
  return runs;
}

function codeLine(line) {
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, fill: CODE_BG },
    spacing: { after: 0, before: 0 },
    children: [new TextRun({ text: line.length ? line : ' ', font: MONO, size: 19 })],
  });
}

function makeCell(txt, o) {
  o = o || {};
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    shading: o.bg ? { type: ShadingType.CLEAR, fill: o.bg } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    children: [new Paragraph({
      spacing: { after: 0 },
      alignment: o.align || AlignmentType.LEFT,
      children: inlineRuns(txt, { bold: o.bold, size: 19, color: o.color }),
    })],
  });
}

function splitRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
}

const children = [];
let i = 0;
while (i < mdLines.length) {
  const line = mdLines[i];

  // 代码块
  if (/^```/.test(line)) {
    i++;
    while (i < mdLines.length && !/^```/.test(mdLines[i])) { children.push(codeLine(mdLines[i])); i++; }
    i++; // 跳过结束 ```
    children.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: '' })] }));
    continue;
  }

  // 表格
  if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < mdLines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(mdLines[i + 1]) && mdLines[i + 1].indexOf('-') >= 0) {
    const header = splitRow(line);
    i += 2;
    const bodyRows = [];
    while (i < mdLines.length && /^\s*\|.*\|\s*$/.test(mdLines[i])) { bodyRows.push(splitRow(mdLines[i])); i++; }
    const rows = [new TableRow({
      tableHeader: true,
      children: header.map(function (h) { return makeCell(h, { bold: true, bg: TABLE_BG, align: AlignmentType.CENTER }); }),
    })].concat(bodyRows.map(function (r) {
      return new TableRow({ children: header.map(function (_, idx) { return makeCell(r[idx] == null ? '' : r[idx]); }) });
    }));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
        left: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
        right: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: BORDER },
        insideVertical: { style: BorderStyle.SINGLE, size: 2, color: BORDER },
      },
      rows: rows,
    }));
    children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: '' })] }));
    continue;
  }

  // 标题
  let m;
  if ((m = /^###\s+(.*)$/.exec(line))) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 120, after: 60 }, children: inlineRuns(m[1], { bold: true, size: 24, color: ACCENT }) }));
    i++; continue;
  }
  if ((m = /^##\s+(.*)$/.exec(line))) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 }, children: inlineRuns(m[1], { bold: true, size: 28, color: ACCENT }) }));
    i++; continue;
  }
  if ((m = /^#\s+(.*)$/.exec(line))) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { before: 0, after: 120 }, children: inlineRuns(m[1], { bold: true, size: 36, color: ACCENT }) }));
    i++; continue;
  }

  // 分隔线
  if (/^---+\s*$/.test(line)) { i++; continue; }

  // 引用
  if ((m = /^>\s?(.*)$/.exec(line))) {
    children.push(new Paragraph({
      shading: { type: ShadingType.CLEAR, fill: 'FFF8E1' },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'F5A623' } },
      spacing: { after: 60 }, indent: { left: 120 },
      children: inlineRuns(m[1], { size: 20, color: '5A4A00' }),
    }));
    i++; continue;
  }

  // 列表
  if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
    children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: inlineRuns(m[1], { size: 21 }) }));
    i++; continue;
  }
  if ((m = /^\s*(\d+)\.\s+(.*)$/.exec(line))) {
    children.push(new Paragraph({ spacing: { after: 40 }, children: inlineRuns(m[1] + '. ' + m[2], { size: 21 }) }));
    i++; continue;
  }

  // 空行
  if (/^\s*$/.test(line)) { i++; continue; }

  // 普通段落
  children.push(new Paragraph({ spacing: { after: 80 }, children: inlineRuns(line, { size: 21 }) }));
  i++;
}

const doc = new Document({
  styles: { default: { document: { run: { font: CN, size: 21 } } } },
  sections: [{
    properties: { page: { margin: { top: 720, bottom: 720, left: 800, right: 800 } } },
    children: children,
  }],
});

Packer.toBuffer(doc).then(function (buf) {
  fs.writeFileSync(out, buf);
  console.log('✅ Word 文档已生成：' + path.resolve(out));
}).catch(function (e) { console.error('❌ 生成失败：', e); process.exit(1); });
