/**
 * generate-aliyun-onepager.js
 * 生成《监理系统上阿里云 · 可行性与预算决策一页纸》Word 文档。
 * 数据来源：操作单-阿里云正式上线.md、补后端/ALIYUN_DEPLOYMENT.md、
 *           补后端/生产环境部署指南.md、补后端/DEPLOYMENT.md
 * 运行：node generate-aliyun-onepager.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, BorderStyle, ShadingType, VerticalAlign,
} = require('docx');

const OUT = path.resolve(__dirname, '..', '..', '..', '阿里云上线可行性与预算一页纸.docx');
const CN = '微软雅黑';
const ACCENT = '1E3A5F';
const HEAD_BG = 'EAF1FF';
const WARN_BG = 'FFF4E5';
const BORDER = 'BFBFBF';

function run(t, o) {
  o = o || {};
  return new TextRun({ text: t, bold: o.bold, color: o.color, size: o.size || 17, font: CN });
}
function para(runs, o) {
  o = o || {};
  return new Paragraph({
    alignment: o.align,
    spacing: { before: o.before || 0, after: o.after == null ? 40 : o.after },
    children: Array.isArray(runs) ? runs : [run(runs)],
  });
}
function cell(t, o) {
  o = o || {};
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    shading: o.bg ? { type: ShadingType.CLEAR, fill: o.bg } : undefined,
    margins: { top: 25, bottom: 25, left: 70, right: 70 },
    children: [new Paragraph({
      alignment: o.align || AlignmentType.LEFT,
      spacing: { after: 0 },
      children: [run(t, { bold: o.bold, color: o.color, size: 16 })],
    })],
  });
}
function table(header, rows, widths) {
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
    rows: [
      new TableRow({
        tableHeader: true,
        children: header.map(function (h, i) {
          return cell(h, { bold: true, bg: HEAD_BG, align: AlignmentType.CENTER, width: widths && widths[i] });
        }),
      }),
    ].concat(rows.map(function (r) {
      return new TableRow({
        children: r.map(function (v, i) {
          return cell(v, { bold: i === 0, width: widths && widths[i] });
        }),
      });
    })),
  });
}
function sec(t) {
  return new Paragraph({
    spacing: { before: 90, after: 35 },
    children: [run('■ ', { bold: true, color: ACCENT, size: 20 }), run(t, { bold: true, color: ACCENT, size: 20 })],
  });
}

const doc = new Document({
  styles: { default: { document: { run: { font: CN, size: 17 } } } },
  sections: [{
    properties: { page: { margin: { top: 480, bottom: 420, left: 620, right: 620 } } },
    children: [
      para([run('监理系统上阿里云 · 可行性与预算决策一页纸', { bold: true, size: 28, color: ACCENT })],
        { align: AlignmentType.CENTER, after: 20 }),
      para([run('依据项目实际部署文档与脚本整理 ｜ 金额均为文档记载口径，未记载项已明确标注', { size: 15, color: '7A7A7A' })],
        { align: AlignmentType.CENTER, after: 70 }),

      sec('一、结论：可行，唯一长周期前置是 ICP 备案'),
      para([run('项目已具备完整的阿里云部署资产：', { bold: true }),
        run('aliyun-init.sh、supervision.service、nginx-supervision.conf、supervision.env.example、backup.sh、restore.sh 及打包脚本。技术部署约 1 天可完成；ICP 备案需 1~3 周，是决定上线日期的关键路径。')]),

      sec('二、前置条件（缺一不可）'),
      table(
        ['前置项', '要求与说明'],
        [
          ['域名', '已完成实名认证（1~3 天生效）；便宜后缀即可'],
          ['服务器', '中国内地阿里云 ECS/轻量；购买时长 ≥3 个月（备案硬要求）；Ubuntu 22.04 LTS 64 位（脚本按此编写）'],
          ['ICP 备案', '阿里云代备案免费；提交后 24 小时内完成工信部短信核验；管局审核 1~20 个工作日'],
          ['SSL 证书', '免费 DV 即可：Let\'s Encrypt（certbot，90 天自动续期）或阿里云免费 DV（0 元 / 20 张额度）'],
          ['网络端口', '开放 80 / 443；22 仅限运维固定 IP；3306 与 8080 绝不对公网开放'],
          ['域名解析', '备案通过后添加 A 记录：@ 与 www → 服务器公网 IP'],
        ], [16, 84]
      ),

      sec('三、年度费用明细（3 人规模 · 项目文档口径）'),
      table(
        ['费用项目', '文档金额', '说明'],
        [
          ['域名注册', '¥40~80 / 年', '便宜后缀即可；实名认证 1~3 天'],
          ['云服务器（ECS/轻量 2核4G + 40G盘 + 带宽）', '¥800~1300 / 年', '已含固定带宽；新用户/活动价常 2~4 折，续费按原价'],
          ['SSL 证书', '¥0', 'certbot 自动续期，或阿里云免费 DV'],
          ['ICP 备案', '¥0', '阿里云代备案系统免费'],
          ['数据库 MySQL', '¥0', '与应用同机自建；3~5 人无需 RDS'],
          ['小程序认证（可选）', '¥30 / 年', '仅当发布微信小程序时需要'],
          ['合计（不含小程序）', '约 ¥900~1400 / 年', '项目文档《操作单-阿里云正式上线》预算表'],
        ], [34, 22, 44]
      ),
      para([run('带宽说明：', { bold: true }), run('文档最低配置为固定 3Mbps（推荐 5Mbps 或按量），费用已包含在上述服务器套餐内；若改按流量计费，单价随官网与用量变化，文档未给出金额。')],
        { before: 40, after: 30 }),

      sec('四、两档预算方案'),
      table(
        ['档次', '配置（文档依据）', '年费'],
        [
          ['最低可用方案', '轻量/ECS 2核4G + 40G系统盘 + 3Mbps固定带宽 + 自建 MySQL + 免费 SSL + 域名', '约 ¥900~1400 / 年（文档明确）'],
          ['推荐舒适方案', 'ECS 4核8G + 60G系统盘 + 100GB数据盘 + 5Mbps或按量 + 每日快照 + 自建 MySQL + 免费 SSL + 域名', '文档未给出金额，需以阿里云实时报价为准'],
        ], [16, 56, 28]
      ),
      para([run('其他潜在费用（文档提及但未给金额，需控制台/官网核算）：', { bold: true }),
        run('云盘自动快照（文档要求每日一次、保留 7 天）；独立数据盘；RDS MySQL 可选升级；OSS 异地备份（推荐配置提及）。')],
        { before: 40, after: 30 }),

      sec('五、上线流程（顺序不可颠倒）'),
      para([run('买域名 → 买服务器（≥3个月）→ 提交 ICP 备案 → 等待管局审核（1~20 工作日）→ 域名解析 → 配置安全组 → 本地打包上传 → 服务器初始化（JDK/Nginx/MySQL）→ 建库（3 个 SQL，24 张表）→ 配置密钥并启动 → Nginx + 免费 HTTPS → 安全加固与验收 → 备份与安全三件事。', { size: 16 })],
        { after: 30 }),

      new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: WARN_BG },
        spacing: { before: 30, after: 0 },
        children: [run('三条红线：① 备案未通过不要急着部署（80/443 会被拦截）；② 安全组绝不开 3306/8080 到公网；③ 上线首日必须改 admin 默认密码、停用演示账号、建真实项目。', { bold: true, size: 16, color: '8A4B00' })],
      }),
      para([run('依据文档：操作单-阿里云正式上线.md（预算表、11 步流程）；补后端/ALIYUN_DEPLOYMENT.md（1.1 配置、1.2 数据盘、2.1 安全组、3.1 备案、3.2 免费 DV、6 RDS 可选）；补后端/生产环境部署指南.md（2.2 配置对比、备份与快照）；补后端/DEPLOYMENT.md（4.1 资源要求）。', { size: 14, color: '7A7A7A' })],
        { before: 50, after: 0 }),
    ],
  }],
});

Packer.toBuffer(doc).then(function (buf) {
  fs.writeFileSync(OUT, buf);
  console.log('✅ Word 文档已生成：' + OUT);
}).catch(function (e) { console.error('❌ 生成失败：', e); process.exit(1); });
