package com.supervision;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.supervision.util.JwtUtil;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 监理安全日志 Word 导出接口集成验证（独立 H2 库 safetylogexporttests）：
 * 1. GET /safety-logs/{id}/export 返回可直接下载的 docx（正确的 Content-Type 与中文文件名）；
 * 2. 提交 → 审核通过后导出，整改闭环板块体现完整留痕；
 * 3. GET /safety-logs/export 按筛选条件输出台账 + 逐份日志；
 * 4. 导出与列表同权限：未登录 401、跨项目 403、无可见记录时 400 提示。
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:safetylogexporttests;MODE=MySQL;DB_CLOSE_DELAY=-1",
        "app.upload.dir=target/safety-log-export-test-uploads"})
@ActiveProfiles("e2e")
@AutoConfigureMockMvc(print = org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@DisplayName("监理安全日志 Word 导出接口")
class SafetyLogExportIntegrationTest {

    private static final long OUTSIDER_ID = 9301L;
    private static final String OUTSIDER_PASSWORD = "QaPassw0rd!";
    private static final AtomicLong SEQ = new AtomicLong(2000);

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate db;
    @Autowired JwtUtil jwt;
    @Autowired BCryptPasswordEncoder passwordEncoder;

    String adminToken;
    String outsiderToken;

    @BeforeAll
    void seed() throws Exception {
        db.update("insert into sys_user(id,name,phone,status,password) values (?,?,?,?,?)",
                OUTSIDER_ID, "qa_导出无权限", "13900009301", "active", passwordEncoder.encode(OUTSIDER_PASSWORD));
        adminToken = login("admin", "123456");
        outsiderToken = login("qa_导出无权限", OUTSIDER_PASSWORD);
    }

    @AfterEach
    void clearContext() {
        com.supervision.common.AuthContext.clear();
    }

    // ==================== 用例 ====================

    @Test
    @DisplayName("单份导出：返回 docx 字节流、正确的 MIME 与中文文件名，正文含全部核心板块")
    void singleExportIsDownloadableDocx() throws Exception {
        long projectId = createProject("QA导出工程");
        long logId = createLog(projectId, "AQ-QA-0001", "draft");

        MvcResult result = mvc.perform(get("/safety-logs/" + logId + "/export")
                        .header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk()).andReturn();

        assertEquals("application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                result.getResponse().getContentType(), "Content-Type 必须是 docx MIME");
        String disposition = result.getResponse().getHeader("Content-Disposition");
        assertNotNull(disposition, "缺少 Content-Disposition");
        assertTrue(disposition.startsWith("attachment"), "必须是附件下载：" + disposition);
        assertTrue(disposition.contains("filename*=UTF-8''"), "中文文件名需按 RFC 5987 编码：" + disposition);

        byte[] bytes = result.getResponse().getContentAsByteArray();
        assertTrue(bytes.length > 2000, "导出文件过小，可能未写入正文");
        assertEquals('P', (char) bytes[0]);
        assertEquals('K', (char) bytes[1]);

        Map<String, String> parts = unzip(bytes);
        assertTrue(parts.containsKey("word/document.xml"), "缺少正文部件");
        String xml = parts.get("word/document.xml");
        for (String section : new String[]{"工程基本信息", "监理人员信息", "施工部位及形象进度",
                "巡视检查内容", "存在的安全问题及处理结果", "整改闭环情况", "现场照片及附件清单", "签署确认"}) {
            assertTrue(xml.contains(section), "缺少板块：" + section);
        }
        assertTrue(xml.contains("QA导出工程"), "工程名称未写入导出件");
        assertTrue(xml.contains("AQ-QA-0001"), "日志编号未写入导出件");
        assertTrue(xml.contains("未闭环"), "草稿记录应给出未闭环结论");
        assertTrue(parts.get("word/footer1.xml").contains("NUMPAGES"), "页脚缺少总页数域");
    }

    @Test
    @DisplayName("提交并审核通过后导出：闭环板块含提交与审核留痕，库内 reviewerId/reviewedAt 已落库")
    void approvedRecordExportsClosedLoop() throws Exception {
        long projectId = createProject("QA闭环工程");
        long logId = createLog(projectId, "AQ-QA-0002", "draft");

        updateLog(logId, projectId, "AQ-QA-0002", "submitted");
        postJson(adminToken, "/safety-logs/" + logId + "/approve", Map.of("status", "approved"), 200);

        assertNotNull(db.queryForObject("select submitted_at from biz_safety_log where id=?", Object.class, logId),
                "提交时间未落库，导出件无法还原闭环链路");
        assertNotNull(db.queryForObject("select reviewed_at from biz_safety_log where id=?", Object.class, logId),
                "审核时间未落库");
        assertNotNull(db.queryForObject("select reviewer_id from biz_safety_log where id=?", Object.class, logId),
                "审核人未落库");

        String xml = unzip(exportSingle(logId)).get("word/document.xml");
        assertTrue(xml.contains("已闭环"), "审核通过的记录应给出已闭环结论");
        assertTrue(xml.contains("提交审核") && xml.contains("审核结论"), "闭环表缺少提交/审核环节");
        assertTrue(xml.contains("审核通过"), "缺少审核通过结论");
    }

    @Test
    @DisplayName("批量导出：按工程筛选输出台账汇总与逐份日志页")
    void batchExportContainsLedgerAndPages() throws Exception {
        long projectId = createProject("QA汇编工程");
        createLog(projectId, "AQ-QA-0003", "draft");
        createLog(projectId, "AQ-QA-0004", "draft");

        MvcResult result = mvc.perform(get("/safety-logs/export").param("projectId", String.valueOf(projectId))
                        .header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk()).andReturn();
        assertTrue(result.getResponse().getHeader("Content-Disposition").contains("filename*=UTF-8''"),
                "汇编文件名需支持中文");

        String xml = unzip(result.getResponse().getContentAsByteArray()).get("word/document.xml");
        assertTrue(xml.contains("监 理 安 全 日 志 汇 编"), "缺少汇编标题");
        assertTrue(xml.contains("日志台账"), "缺少台账汇总表");
        assertTrue(xml.contains("AQ-QA-0003") && xml.contains("AQ-QA-0004"), "台账缺少记录编号");
        assertTrue(xml.contains("附件 1 / 2") && xml.contains("附件 2 / 2"), "每份日志应独立成页");
    }

    @Test
    @DisplayName("权限边界：未登录 401、跨项目导出 403、无可见记录时 400 明确提示")
    void exportRespectsProjectScope() throws Exception {
        long projectId = createProject("QA越权工程");
        long logId = createLog(projectId, "AQ-QA-0005", "draft");

        mvc.perform(get("/safety-logs/" + logId + "/export")).andExpect(status().isUnauthorized());

        call(outsiderToken, get("/safety-logs/" + logId + "/export"), 403);
        call(outsiderToken, get("/safety-logs/export").param("projectId", String.valueOf(projectId)), 403);

        MvcResult empty = mvc.perform(get("/safety-logs/export").header("Authorization", "Bearer " + outsiderToken))
                .andExpect(status().isBadRequest()).andReturn();
        assertTrue(empty.getResponse().getContentAsString(StandardCharsets.UTF_8).contains("没有可导出"),
                "无可见记录时应提示可读原因");
    }

    // ==================== 辅助方法 ====================

    String login(String phone, String password) throws Exception {
        MvcResult result = mvc.perform(post("/auth/login").contentType(APPLICATION_JSON)
                        .content(json.writeValueAsString(Map.of("username", phone, "password", password))))
                .andExpect(status().isOk()).andReturn();
        return data(result).path("token").asText();
    }

    JsonNode data(MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsByteArray()).path("data");
    }

    JsonNode call(String token, MockHttpServletRequestBuilder request, int expectStatus) throws Exception {
        MvcResult result = mvc.perform(request.header("Authorization", "Bearer " + token))
                .andExpect(status().is(expectStatus)).andReturn();
        return data(result);
    }

    JsonNode postJson(String token, String path, Object body, int expectStatus) throws Exception {
        return call(token, post(path).contentType(APPLICATION_JSON).content(json.writeValueAsString(body)), expectStatus);
    }

    long createProject(String name) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("code", name + "-" + SEQ.incrementAndGet());
        body.put("buildUnit", "QA 建设单位");
        body.put("address", "QA 市 QA 路 1 号");
        body.put("type", "市政工程");
        return postJson(adminToken, "/projects", body, 200).path("id").asLong();
    }

    long createLog(long projectId, String code, String status) throws Exception {
        JsonNode created = postJson(adminToken, "/safety-logs", logBody(projectId, code, status), 200);
        return created.path("id").asLong();
    }

    void updateLog(long logId, long projectId, String code, String status) throws Exception {
        call(adminToken, put("/safety-logs/" + logId).contentType(APPLICATION_JSON)
                .content(json.writeValueAsString(logBody(projectId, code, status))), 200);
    }

    Map<String, Object> logBody(long projectId, String code, String status) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("projectId", projectId);
        body.put("logDate", "2026-10-26");
        body.put("weather", "晴");
        body.put("wind", "3-4 级");
        body.put("temperature", "18℃~26℃");
        body.put("content", "A 区主体结构 15 层钢筋绑扎，B 区地下室防水施工。");
        body.put("inspection", "专职安全员在岗；特种作业人员持证；临时用电系统安全。");
        body.put("safety", "B 区临边防护栏杆松动，已要求施工单位立即加固，下午复查已整改到位。");
        body.put("majorIssue", "无重大事项。");
        body.put("status", status);
        return body;
    }

    byte[] exportSingle(long logId) throws Exception {
        return mvc.perform(get("/safety-logs/" + logId + "/export")
                        .header("Authorization", "Bearer " + adminToken))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray();
    }

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
}
