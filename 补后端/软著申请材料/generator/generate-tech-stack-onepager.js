/**
 * generate-tech-stack-onepager.js
 * 生成《监理现场管理系统 · 技术架构一页纸汇报》Word 文档。
 * 运行：node generate-tech-stack-onepager.js
 * 输出：../技术栈一页纸汇报.docx
 */
'use strict';

const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType, VerticalAlign,
} = require('docx');
const fs = require('fs');

const OUT = path.resolve(__dirname, '..', '技术栈一页纸汇报.docx');

const CN_FONT = '微软雅黑';
const ACCENT = '2563EB';
const HEADER_BG = 'EAF1FF';
const BORDER = 'BFBFBF';

// 通用：生成一段文字
function text(runs, opts) {
  opts = opts || {};
  return new Paragraph({
    alignment: opts.align,
    spacing: { before: opts.before || 0, after: opts.after == null ? 120 : opts.after },
    children: runs,
  });
}

function run(str, o) {
  o = o || {};
  return new TextRun({
    text: str,
    bold: o.bold,
    color: o.color,
    size: o.size,
    font: CN_FONT,
  });
}

// 单元格
function cell(str, o) {
  o = o || {};
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    shading: o.bg ? { type: ShadingType.CLEAR, fill: o.bg } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    width: o.width ? { size: o.width, type: WidthType.PERCENTAGE } : undefined,
    children: [new Paragraph({
      alignment: o.align || AlignmentType.LEFT,
      spacing: { after: 0 },
      children: [run(str, { bold: o.bold, color: o.color, size: 20 })],
    })],
  });
}

// 技术栈总览表
function overviewTable() {
  const header = new TableRow({
    tableHeader: true,
    children: [
      cell('层次', { bold: true, bg: HEADER_BG, align: AlignmentType.CENTER, width: 16 }),
      cell('技术选型', { bold: true, bg: HEADER_BG, align: AlignmentType.CENTER, width: 34 }),
      cell('版本', { bold: true, bg: HEADER_BG, align: AlignmentType.CENTER, width: 24 }),
      cell('通俗说明', { bold: true, bg: HEADER_BG, align: AlignmentType.CENTER, width: 26 }),
    ],
  });
  const rows = [
    ['前端', '原生 HTML / CSS / JavaScript', '无框架', '浏览器直接运行，简单可靠'],
    ['后端', 'Java + Spring Boot', 'Java 17 / SB 3.2.5', '系统"大脑"，处理业务逻辑'],
    ['数据库', 'MySQL', '8.0', '存放业务数据'],
    ['服务器', 'Nginx + 阿里云 ECS', 'Nginx≥1.20 / Ubuntu 22.04', '访问入口与请求转发'],
    ['移动端', '微信小程序', '—', '现场人员手机扫码即用'],
  ].map(function (r) {
    return new TableRow({
      children: [
        cell(r[0], { bold: true, color: ACCENT, align: AlignmentType.CENTER }),
        cell(r[1]),
        cell(r[2]),
        cell(r[3]),
      ],
    });
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      left: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      right: { style: BorderStyle.SINGLE, size: 4, color: BORDER },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: BORDER },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: BORDER },
    },
    rows: [header].concat(rows),
  });
}

function sectionTitle(str) {
  return new Paragraph({
    spacing: { before: 200, after: 100 },
    children: [run('■ ', { bold: true, color: ACCENT, size: 24 }), run(str, { bold: true, color: ACCENT, size: 24 })],
  });
}

function bullet(label, desc) {
  return new Paragraph({
    spacing: { after: 60 },
    children: [run('• ', { color: ACCENT }), run(label, { bold: true }), run('：' + desc)],
  });
}

const doc = new Document({
  styles: { default: { document: { run: { font: CN_FONT, size: 21 } } } },
  sections: [{
    properties: { page: { margin: { top: 720, bottom: 720, left: 860, right: 860 } } },
    children: [
      // 标题
      text([run('监理现场管理系统 · 技术架构一页纸', { bold: true, size: 34, color: '1E3A5F' })],
        { align: AlignmentType.CENTER, after: 40 }),
      text([run('汇报材料 ｜ 版本信息均取自 pom.xml / application.yml 实测识别', { size: 18, color: '7A7A7A' })],
        { align: AlignmentType.CENTER, after: 160 }),

      sectionTitle('一、技术栈总览'),
      overviewTable(),
      text([run('架构定性：', { bold: true }), run('前后端分离的 Web 应用，单机全栈部署（后端+数据库+Nginx+前端同处一台服务器），配套微信小程序。')],
        { before: 120, after: 60 }),

      sectionTitle('二、核心三问答复'),
      bullet('前端', '原生 HTML/CSS/JavaScript，未使用 React / Vue / Angular 等框架；26 个页面 + 自研统一基座 app.js（登录、请求、安全、提示）。'),
      bullet('后端', 'Java 17 + Spring Boot 3.2.5，经典四层架构，RESTful API（前缀 /api，端口 8080）。'),
      bullet('数据库', 'MySQL 8.0（连接池 Druid 1.2.22，字符集 utf8mb4，核心 21 张表）。'),

      sectionTitle('三、安全与质量保障（领导关注）'),
      text([run('✅ BCrypt 密码加密存储    ✅ JWT 身份认证    ✅ HTTPS 强制加密传输', { size: 20 })], { after: 40 }),
      text([run('✅ 登录防暴力破解    ✅ XSS / 文件上传防护    ✅ 生产密钥环境变量隔离', { size: 20 })], { after: 60 }),

      sectionTitle('四、一句话总结'),
      text([run('采用业界主流成熟的 Java Spring Boot + MySQL 后端 + 轻量纯静态前端，配套微信小程序，单机部署即可稳定支撑监理业务。选型以"稳定、易维护、低运维成本"为核心，适合单位内部长期使用。', { color: '1E3A5F' })]),
    ],
  }],
});

Packer.toBuffer(doc).then(function (buf) {
  fs.writeFileSync(OUT, buf);
  console.log('✅ Word 文档已生成：' + OUT);
}).catch(function (e) {
  console.error('❌ 生成失败：', e);
  process.exit(1);
});
