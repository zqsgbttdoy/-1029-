package com.supervision;

import com.supervision.entity.Project;
import com.supervision.entity.SafetyLog;
import com.supervision.entity.User;
import com.supervision.service.SafetyLogWordExporter;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.w3c.dom.Document;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 监理安全日志 Word 导出单元测试。
 *
 * <p>不依赖 Spring 容器：直接校验 docx 包结构、XML 合法性与关键业务板块文本，
 * 防止模板改版时出现“文件能下载但打不开”或板块丢失。
 */
@DisplayName("监理安全日志 Word 导出")
class SafetyLogWordExportTest {

    private final SafetyLogWordExporter exporter = new SafetyLogWordExporter();

    @Test
    @DisplayName("单份导出 - 生成结构完整且可解析的 docx，包含十大板块与审核留痕")
    void singleExportIsValidDocx() throws Exception {
        SafetyLog record = approvedRecord();
        byte[] bytes = exporter.buildSingle(record, project(), users(), "系统管理员");

        Map<String, String> parts = unzip(bytes);
        for (String required : List.of("[Content_Types].xml", "_rels/.rels", "word/document.xml",
                "word/_rels/document.xml.rels", "word/styles.xml", "word/header1.xml", "word/footer1.xml",
                "docProps/core.xml", "docProps/app.xml")) {
            assertTrue(parts.containsKey(required), "缺少 docx 部件：" + required);
        }
        for (Map.Entry<String, String> entry : parts.entrySet()) {
            if (entry.getKey().endsWith(".xml") || entry.getKey().endsWith(".rels")) {
                assertNotNull(parse(entry.getValue()), "XML 无法解析：" + entry.getKey());
            }
        }

        String xml = parts.get("word/document.xml");
        assertTrue(xml.contains("监 理 安 全 日 志"), "缺少文档主标题");
        assertTrue(xml.contains("工程基本信息"), "缺少工程基本信息板块");
        assertTrue(xml.contains("监理人员信息"), "缺少监理人员信息板块");
        assertTrue(xml.contains("施工部位及形象进度"), "缺少施工内容板块");
        assertTrue(xml.contains("巡视检查内容"), "缺少巡视检查板块");
        assertTrue(xml.contains("存在的安全问题及处理结果"), "缺少问题记录板块");
        assertTrue(xml.contains("整改闭环情况"), "缺少整改闭环板块");
        assertTrue(xml.contains("现场照片及附件清单"), "缺少附件清单板块");
        assertTrue(xml.contains("签署确认"), "缺少签署板块");
        assertTrue(xml.contains("滨江路综合管廊工程"), "工程名称未写入");
        assertTrue(xml.contains("李建国"), "记录人未写入");
        assertTrue(xml.contains("张审核"), "审核人未写入");
        assertTrue(xml.contains("2026-10-26"), "记录日期未写入");
        assertTrue(xml.contains("已闭环"), "审核通过记录应给出闭环结论");
        assertTrue(xml.contains("检查记录.pdf"), "附件清单未写入");
        String footer = parts.get("word/footer1.xml");
        assertTrue(footer.contains("PAGE") && footer.contains("NUMPAGES"), "页脚缺少页码域");
        assertTrue(footer.contains("第 "), "页脚缺少页码文字");
    }

    @Test
    @DisplayName("批量导出 - 首页为台账汇总，每份日志独立成页")
    void batchExportContainsSummaryAndSeparatePages() throws Exception {
        SafetyLog first = approvedRecord();
        SafetyLog second = approvedRecord();
        second.setId(2L);
        second.setCode("AQ-2026-0002");
        second.setLogDate(LocalDate.of(2026, 10, 27));
        second.setStatus("submitted");
        second.setSubmittedBy("李建国");
        second.setSubmittedAt(LocalDateTime.of(2026, 10, 27, 9, 30));

        byte[] bytes = exporter.buildBatch(List.of(first, second), Map.of(9L, project()), users(),
                "工程：滨江路综合管廊工程；全部状态", "系统管理员");
        String xml = unzip(bytes).get("word/document.xml");

        assertTrue(xml.contains("监 理 安 全 日 志 汇 编"), "缺少汇编标题");
        assertTrue(xml.contains("导出说明"), "缺少导出说明板块");
        assertTrue(xml.contains("日志台账"), "缺少台账汇总表");
        assertTrue(xml.contains("AQ-2026-0001") && xml.contains("AQ-2026-0002"), "台账缺少日志编号");
        assertTrue(xml.contains("附件 1 / 2") && xml.contains("附件 2 / 2"), "缺少逐份附件页");
        assertEquals(2, countOccurrences(xml, "<w:br w:type=\"page\"/>"), "每份日志前应各有一处分页");
    }

    @Test
    @DisplayName("特殊字符与非法控制符 - 转义后 XML 仍合法，脚本内容不当成标签")
    void specialCharactersAreEscaped() throws Exception {
        SafetyLog record = approvedRecord();
        record.setContent("现场发现 <script>alert(1)</script> 标记\u0001\u0002");
        record.setSafety("A & B 单位交叉作业，防护栏杆 1.2m 高");

        String xml = unzip(exporter.buildSingle(record, project(), users(), "系统管理员")).get("word/document.xml");

        parse(xml);
        assertTrue(xml.contains("&lt;script&gt;"), "尖括号未转义");
        assertTrue(xml.contains("A &amp; B"), "& 未转义");
        assertFalse(xml.contains("<script>"), "原始脚本标签被写入文档");
    }

    @Test
    @DisplayName("驳回记录 - 输出驳回原因且闭环结论为未闭环")
    void rejectedRecordShowsOpenLoop() throws Exception {
        SafetyLog record = approvedRecord();
        record.setStatus("rejected");
        record.setRejectReason("安全问题描述过于笼统，请补充整改责任人与复查时间");
        record.setRejectedBy("张审核");
        record.setRejectedAt(LocalDateTime.of(2026, 10, 26, 18, 0));

        String xml = unzip(exporter.buildSingle(record, project(), users(), "系统管理员")).get("word/document.xml");

        assertTrue(xml.contains("未闭环"), "驳回记录应给出未闭环结论");
        assertTrue(xml.contains("整改反馈"), "驳回记录缺少整改反馈环节");
        assertTrue(xml.contains("安全问题描述过于笼统"), "驳回原因未写入");
    }

    // ==================== 测试数据 ====================

    private static SafetyLog approvedRecord() {
        SafetyLog record = new SafetyLog();
        record.setId(1L);
        record.setCode("AQ-2026-0001");
        record.setProjectId(9L);
        record.setLogDate(LocalDate.of(2026, 10, 26));
        record.setAuthorId(100L);
        record.setReviewerId(200L);
        record.setWeather("晴");
        record.setWind("3-4级");
        record.setTemperature("18℃~26℃");
        record.setContent("A区主体结构15层施工；B区地下室防水施工完成。");
        record.setInspection("①专职安全员在岗履职；②特种作业人员持证上岗；③临时用电系统安全。");
        record.setSafety("B区临边防护栏杆松动，已要求施工单位立即加固，下午复查已整改到位。");
        record.setMajorIssue("无重大事项。");
        record.setStatus("approved");
        record.setVersion(1);
        record.setCreateTime(LocalDateTime.of(2026, 10, 26, 17, 20));
        record.setSubmittedBy("李建国");
        record.setSubmittedAt(LocalDateTime.of(2026, 10, 26, 17, 30));
        record.setReviewedAt(LocalDateTime.of(2026, 10, 26, 18, 10));
        record.setPhotos("[{\"url\":\"/api/uploads/20261026/a.jpg\",\"name\":\"现场照片1.jpg\"}]");
        record.setAttachments("[{\"url\":\"/api/uploads/20261026/b.pdf\",\"name\":\"检查记录.pdf\"}]");
        return record;
    }

    private static Project project() {
        Project project = new Project();
        project.setId(9L);
        project.setName("滨江路综合管廊工程");
        project.setCode("XM-2026-009");
        project.setBuildUnit("滨江市城市建设投资有限公司");
        project.setAddress("滨江市江北区滨江路 88 号");
        project.setType("市政工程");
        project.setStartDate(LocalDate.of(2025, 12, 1));
        project.setEndDate(LocalDate.of(2027, 6, 30));
        project.setManagerId(300L);
        project.setDescription("综合管廊全长 3.2 公里，含给排水、电力、通信舱室。");
        return project;
    }

    private static Map<Long, User> users() {
        Map<Long, User> users = new LinkedHashMap<>();
        users.put(100L, user(100L, "李建国", "专业监理工程师", "JL-2020-0091"));
        users.put(200L, user(200L, "张审核", "总监理工程师", "JL-2015-0007"));
        users.put(300L, user(300L, "王总监", "项目总监", "JL-2012-0001"));
        return users;
    }

    private static User user(Long id, String name, String position, String certNo) {
        User user = new User();
        user.setId(id);
        user.setName(name);
        user.setPosition(position);
        user.setCertNo(certNo);
        return user;
    }

    // ==================== 工具方法 ====================

    private static Map<String, String> unzip(byte[] bytes) throws Exception {
        Map<String, String> parts = new LinkedHashMap<>();
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                zip.transferTo(out);
                parts.put(entry.getName(), out.toString(StandardCharsets.UTF_8));
            }
        }
        return parts;
    }

    private static Document parse(String xml) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        DocumentBuilder builder = factory.newDocumentBuilder();
        return builder.parse(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)));
    }

    private static int countOccurrences(String text, String token) {
        int count = 0;
        int index = text.indexOf(token);
        while (index >= 0) {
            count++;
            index = text.indexOf(token, index + token.length());
        }
        return count;
    }
}
