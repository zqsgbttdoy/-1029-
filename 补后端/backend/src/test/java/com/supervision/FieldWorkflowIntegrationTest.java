package com.supervision;

import com.fasterxml.jackson.databind.*;
import com.supervision.common.*;
import com.supervision.entity.FieldRecord;
import com.supervision.service.FieldRecordService;
import com.supervision.service.AttachmentAccessService;
import org.springframework.boot.test.mock.mockito.SpyBean;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.reset;
import com.supervision.util.JwtUtil;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.*;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** 真实 H2、事务、MVC 与鉴权共同验证，不以旧服务的 Mock 测试替代入口验收。 */
@SpringBootTest(properties = {"spring.datasource.url=jdbc:h2:mem:fieldtests;MODE=MySQL;DB_CLOSE_DELAY=-1", "app.upload.dir=target/field-test-uploads", "app.cors.allowed-origins=https://qa22.example.invalid"})
@ActiveProfiles("e2e")
@AutoConfigureMockMvc(print = org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
class FieldWorkflowIntegrationTest {
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate db;
    @Autowired JwtUtil jwt;
    @Autowired com.supervision.config.AdminPermissionInitializer adminInitializer;
    @Autowired com.supervision.repository.TokenRevocationRepository revocations;
    @Autowired org.springframework.core.env.Environment environment;
    @Autowired FieldRecordService service;
    @SpyBean AttachmentAccessService attachmentService;
    static final AtomicLong sequence = new AtomicLong(10000);
    long author, reviewer, outsider, project, otherProject;
    String photo;

    @BeforeEach void prepare() throws Exception {
        author = sequence.incrementAndGet(); reviewer = sequence.incrementAndGet(); outsider = sequence.incrementAndGet();
        project = sequence.incrementAndGet(); otherProject = sequence.incrementAndGet();
        for (long uid : List.of(author, reviewer, outsider))
            db.update("insert into sys_user(id,name,status) values (?,?, 'active')", uid, "测试人员" + uid);
        db.update("insert into biz_project(id,name,code,status,manager_id) values (?,?,?,'active',?)", project, "测试项目", "P" + project, reviewer);
        db.update("insert into biz_project(id,name,code,status,manager_id) values (?,?,?,'active',?)", otherProject, "另一项目", "P" + otherProject, outsider);
        db.update("update sys_user set project_id=? where id=?", project, author);
        photo = upload(author);
    }
    @AfterEach void clearIdentity() { AuthContext.clear(); }
    String token(long uid) { return "Bearer " + jwt.generateToken(uid, "测试", List.of()); }
    JsonNode call(long uid, MockHttpServletRequestBuilder request, int status) throws Exception {
        MvcResult result = mvc.perform(request.header("Authorization", token(uid))).andExpect(status().is(status)).andReturn();
        return json.readTree(result.getResponse().getContentAsByteArray()).path("data");
    }
    MockHttpServletRequestBuilder body(MockHttpServletRequestBuilder request, Object body) throws Exception {
        return request.contentType("application/json").content(json.writeValueAsString(body));
    }
    String upload(long uid) throws Exception {
        var file = new MockMultipartFile("file", "site.jpg", "image/jpeg", new byte[]{1, 2, 3});
        MvcResult result = mvc.perform(multipart("/files/upload").file(file).header("Authorization", token(uid)))
                .andExpect(status().isOk()).andReturn();
        return json.readTree(result.getResponse().getContentAsByteArray()).path("data").path("url").asText();
    }
    Map<String, Object> diary() {
        return new LinkedHashMap<>(Map.of("projectId", project, "diaryDate", "2026-09-23", "weather", "晴",
                "construction", "检查钢筋绑扎", "photos", "[\"" + photo + "\"]", "attachments", "[]"));
    }
    JsonNode create(long uid, String kind, Map<String, Object> data, String key) throws Exception {
        return call(uid, body(post("/" + kind).header("Idempotency-Key", key), data), 200);
    }
    JsonNode submit(JsonNode record, String kind) throws Exception {
        return call(author, post("/" + kind + "/" + record.path("id").asLong() + "/submit").header("X-Record-Version", record.path("lockVersion").asLong()), 200);
    }
    JsonNode approve(JsonNode record, String kind, String status) throws Exception {
        return call(reviewer, body(post("/" + kind + "/" + record.path("id").asLong() + "/approve")
                .header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("status", status, "rejectReason", "请补充部位")), 200);
    }

    Map<String, Object> dailyChecklistBody(String result, String attachment) throws Exception {
        var problem = new LinkedHashMap<String, Object>(Map.of("id", "problem-1", "name", "防护缺失", "type", "安全问题", "description", "现场说明",
                "foundById", outsider, "foundByName", "伪造发现人", "attachments", attachment == null ? List.of() : List.of(Map.of("url", attachment, "name", "问题照片.jpg"))));
        var item = Map.of("id", "item-1", "category", "一般", "content", "检查临边防护", "method", "目测", "standard", "专项方案", "required", true, "result", result, "problems", List.of(problem));
        return new LinkedHashMap<>(Map.of("projectId", project, "inspectionDate", "2026-10-29", "location", "三层临边", "content", "巡视原文", "issues", "历史补充说明",
                "checklist", json.writeValueAsString(Map.of("version", 1, "items", List.of(item)))));
    }

    @Test void dailyChecklistRoundTripPermissionsSnapshotsAndLegacy() throws Exception {
        var input = dailyChecklistBody("noncompliant", photo);
        input.put("startTime", "2026-10-29T08:30:00"); input.put("endTime", "2026-10-29T09:30:00");
        input.put("workerCount", 0); input.put("manageCount", 3);
        String key = UUID.randomUUID().toString();
        JsonNode record = create(author, "daily-inspections", input, key);
        String path = "/daily-inspections/" + record.path("id").asLong();
        assertEquals(record.path("id"), create(author, "daily-inspections", input, key).path("id"));
        JsonNode details = json.readTree(record.path("checklist").asText());
        assertEquals(author, details.path("items").get(0).path("problems").get(0).path("foundById").asLong());
        assertEquals("测试人员" + author, record.path("authorName").asText());
        assertEquals(0, record.path("workerCount").asInt()); assertEquals(3, record.path("manageCount").asInt());
        call(reviewer, get(path), 403); call(outsider, get(path), 403);
        call(reviewer, get("/files/access").param("url", photo), 403);
        JsonNode old = record;
        record = call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("content", "旧客户端只修改正文")), 200);
        assertEquals(old.path("checklist"), record.path("checklist")); assertEquals(old.path("startTime"), record.path("startTime"));
        call(author, body(put(path).header("X-Record-Version", old.path("lockVersion").asLong()), input), 409);
        record = submit(record, "daily-inspections");
        assertEquals("recorded", record.path("status").asText());
        call(reviewer, get("/files/access").param("url", photo), 200);
        call(outsider, get("/files/access").param("url", photo), 403);
        // 免审核：旧审核接口对当日巡检明确拒绝，不能再走过“通过/退回”
        call(reviewer, body(post(path + "/approve").header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("status", "approved")), 400);
        // 已保存巡检本人可在同一条记录上继续修改，旧版本号仍拒绝覆盖
        call(author, body(put(path).header("X-Record-Version", old.path("lockVersion").asLong()), input), 409);
        record = call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("checklist", "{\"version\":1,\"items\":[]}")), 200);
        assertTrue(json.readTree(record.path("checklist").asText()).path("items").isEmpty());
        assertEquals("recorded", record.path("status").asText());
        call(author, get("/files/access").param("url", photo), 200);
        call(reviewer, get("/files/access").param("url", photo), 200);
        assertTrue(call(reviewer, get(path + "/history"), 200).toString().contains("防护缺失"));
        var legacy = new LinkedHashMap<>(input); legacy.remove("checklist"); legacy.remove("startTime"); legacy.remove("endTime");
        legacy.remove("workerCount"); legacy.remove("manageCount");
        JsonNode oldRecord = create(author, "daily-inspections", legacy, UUID.randomUUID().toString());
        assertFalse(oldRecord.hasNonNull("checklist")); assertFalse(oldRecord.hasNonNull("workerCount"));
        assertEquals("recorded", submit(oldRecord, "daily-inspections").path("status").asText());
    }

    @Test void dailyChecklistDraftAndSubmissionValidation() throws Exception {
        var input = dailyChecklistBody("unchecked", null);
        input.put("startTime", "2026-10-29T08:00:00");
        JsonNode record = create(author, "daily-inspections", input, UUID.randomUUID().toString());
        String path = "/daily-inspections/" + record.path("id").asLong();
        call(author, post(path + "/submit").header("X-Record-Version", record.path("lockVersion").asLong()), 400);
        record = call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("endTime", "2026-10-29T09:00:00")), 200);
        call(author, post(path + "/submit").header("X-Record-Version", record.path("lockVersion").asLong()), 400);
        var noProblems = json.readTree(input.get("checklist").toString());
        ((com.fasterxml.jackson.databind.node.ObjectNode) noProblems.path("items").get(0)).put("result", "noncompliant").putArray("problems");
        record = call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("checklist", noProblems.toString())), 200);
        assertEquals("recorded", submit(record, "daily-inspections").path("status").asText());
        for (Object number : List.of(-1, 1.5, "1.2", "abc", 2147483648L)) {
            var bad = dailyChecklistBody("compliant", null); bad.put("workerCount", number);
            call(author, body(post("/daily-inspections").header("Idempotency-Key", UUID.randomUUID().toString()), bad), 400);
        }
        for (String raw : List.of("{bad", "{\"version\":2,\"items\":[]}", input.get("checklist").toString().replace("unchecked", "invalid"))) {
            var bad = dailyChecklistBody("compliant", null); bad.put("checklist", raw);
            call(author, body(post("/daily-inspections").header("Idempotency-Key", UUID.randomUUID().toString()), bad), 400);
        }
        var reversed = dailyChecklistBody("compliant", null);
        reversed.put("startTime", "2026-10-29T10:00:00"); reversed.put("endTime", "2026-10-29T09:00:00");
        call(author, body(post("/daily-inspections").header("Idempotency-Key", UUID.randomUUID().toString()), reversed), 400);
    }

    @Test void sidelineMinutePrecisionTimesRoundTripAndRejectEqualOrReversed() throws Exception {
        // 电脑端与小程序都改为点选式时间面板，按 5 分钟一档写入 HH:mm:00，服务端需原样保留分钟
        var base = new LinkedHashMap<String, Object>(Map.of("projectId", project, "inspectionDate", "2026-10-29",
                "location", "三层顶板", "content", json.writeValueAsString(Map.of("process", "浇筑", "result", "合格",
                        "manageCount", 1, "workerCount", 2, "docs", List.of("图纸A")))));
        var input = new LinkedHashMap<>(base);
        input.put("startTime", "2026-10-29T08:30:00"); input.put("endTime", "2026-10-29T11:30:00");
        JsonNode record = create(author, "sideline-inspections", input, UUID.randomUUID().toString());
        assertEquals("2026-10-29T08:30:00", record.path("startTime").asText());
        assertEquals("2026-10-29T11:30:00", record.path("endTime").asText());
        assertEquals("submitted", submit(record, "sideline-inspections").path("status").asText());
        // 前端面板已拦先后关系，服务端仍需独立拦住相同起止时间与先后颠倒
        for (String[] pair : new String[][]{{"2026-10-29T10:00:00", "2026-10-29T10:00:00"},
                {"2026-10-29T11:30:00", "2026-10-29T08:30:00"}}) {
            var bad = new LinkedHashMap<>(base);
            bad.put("startTime", pair[0]); bad.put("endTime", pair[1]);
            JsonNode draft = create(author, "sideline-inspections", bad, UUID.randomUUID().toString());
            call(author, post("/sideline-inspections/" + draft.path("id").asLong() + "/submit")
                    .header("X-Record-Version", draft.path("lockVersion").asLong()), 400);
        }
    }

    @Test void dailyChecklistCannotBindOtherProjectFilesOrDuplicateIds() throws Exception {
        String otherFile = upload(outsider);
        var other = dailyChecklistBody("compliant", otherFile); other.put("projectId", otherProject);
        create(outsider, "daily-inspections", other, UUID.randomUUID().toString());
        call(author, body(post("/daily-inspections").header("Idempotency-Key", UUID.randomUUID().toString()), dailyChecklistBody("compliant", otherFile)), 403);
        var bad = dailyChecklistBody("compliant", null);
        var details = json.readTree(bad.get("checklist").toString());
        ((com.fasterxml.jackson.databind.node.ArrayNode) details.path("items")).add(details.path("items").get(0).deepCopy());
        bad.put("checklist", details.toString());
        call(author, body(post("/daily-inspections").header("Idempotency-Key", UUID.randomUUID().toString()), bad), 400);
        bad.put("checklist", "长".repeat(60001));
        call(author, body(post("/daily-inspections").header("Idempotency-Key", UUID.randomUUID().toString()), bad), 400);
    }

    @Test void dailyChecklistLimitsAndStableDiscoverer() throws Exception {
        var input = dailyChecklistBody("compliant", null);
        JsonNode record = create(author, "daily-inspections", input, UUID.randomUUID().toString());
        String path = "/daily-inspections/" + record.path("id").asLong();
        db.update("update sys_user set name=? where id=?", "改名后的检查人", author);
        record = call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), input), 200);
        JsonNode problem = json.readTree(record.path("checklist").asText()).path("items").get(0).path("problems").get(0);
        assertEquals(author, problem.path("foundById").asLong()); assertEquals("测试人员" + author, problem.path("foundByName").asText());
        var moved = json.readTree(input.get("checklist").toString());
        ((com.fasterxml.jackson.databind.node.ObjectNode) moved.path("items").get(0)).put("id", "another-item");
        input.put("checklist", moved.toString());
        record = call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), input), 200);
        problem = json.readTree(record.path("checklist").asText()).path("items").get(0).path("problems").get(0);
        assertEquals("测试人员" + author, problem.path("foundByName").asText());
        var many = json.createObjectNode().put("version", 1); var items = many.putArray("items");
        for (int i = 0; i < 100; i++) {
            var item = items.addObject().put("id", "i" + i).put("content", "检查").put("required", false).put("result", "unchecked");
            var problems = item.putArray("problems");
            if (i < 10) for (int p = 0; p < 20; p++) problems.addObject().put("id", "p" + i + "_" + p).put("name", "问题").put("type", "质量问题").putArray("attachments");
        }
        input.put("checklist", many.toString()); create(author, "daily-inspections", input, UUID.randomUUID().toString());
        var overflow = many.deepCopy(); overflow.withArray("items").add(items.get(99).deepCopy());
        input.put("checklist", overflow.toString()); call(author, body(post("/daily-inspections").header("Idempotency-Key", UUID.randomUUID().toString()), input), 400);
        overflow = many.deepCopy(); ((com.fasterxml.jackson.databind.node.ArrayNode) overflow.path("items").get(0).path("problems")).add(json.createObjectNode().put("id", "extra").put("name", "问题").put("type", "质量问题").set("attachments", json.createArrayNode()));
        input.put("checklist", overflow.toString()); call(author, body(post("/daily-inspections").header("Idempotency-Key", UUID.randomUUID().toString()), input), 400);
        overflow = many.deepCopy(); ((com.fasterxml.jackson.databind.node.ArrayNode) overflow.path("items").get(10).path("problems")).add(json.createObjectNode().put("id", "extra").put("name", "问题").put("type", "质量问题").set("attachments", json.createArrayNode()));
        input.put("checklist", overflow.toString()); call(author, body(post("/daily-inspections").header("Idempotency-Key", UUID.randomUUID().toString()), input), 400);
        var files = (com.fasterxml.jackson.databind.node.ArrayNode) many.path("items").get(0).path("problems").get(0).path("attachments");
        for (int i = 0; i < 50; i++) files.addObject().put("url", photo).put("name", "照片");
        input.put("checklist", many.toString()); create(author, "daily-inspections", input, UUID.randomUUID().toString());
        files.addObject().put("url", photo).put("name", "超限照片");
        input.put("checklist", many.toString()); call(author, body(post("/daily-inspections").header("Idempotency-Key", UUID.randomUUID().toString()), input), 400);
        for (String raw : List.of("{\"version\":4294967297,\"items\":[]}", "{\"version\":1,\"items\":[]} {}")) {
            input.put("checklist", raw); call(author, body(post("/daily-inspections").header("Idempotency-Key", UUID.randomUUID().toString()), input), 400);
        }
    }

    /** 日常巡检作为备忘录：提交即保存、本人可再编辑、历史审核状态按已保存兼容且读取不改库。 */
    @Test void dailyMemoSubmitEditLegacyStatusesAndAuditRejection() throws Exception {
        var input = dailyChecklistBody("compliant", null);
        String key = UUID.randomUUID().toString();
        JsonNode record = create(author, "daily-inspections", input, key);
        long id = record.path("id").asLong();
        String path = "/daily-inspections/" + id;
        // 草稿私有：同项目管理者也不能查看他人的巡检草稿
        call(reviewer, get(path), 403);
        JsonNode saved = submit(record, "daily-inspections");
        assertEquals("recorded", saved.path("status").asText());
        assertFalse(saved.hasNonNull("reviewerId"));
        assertFalse(saved.hasNonNull("reviewedAt"));
        // 幂等：同一请求标识重复提交返回同一条，内容不同则拒绝
        assertEquals(id, create(author, "daily-inspections", input, key).path("id").asLong());
        var changed = new LinkedHashMap<>(input); changed.put("content", "换了内容");
        call(author, body(post("/daily-inspections").header("Idempotency-Key", key), changed), 409);
        // 本人继续编辑同一条记录，版本递增且状态保持已保存
        var edit = new LinkedHashMap<>(input); edit.put("content", "补充后的巡视内容");
        JsonNode edited = call(author, body(put(path).header("X-Record-Version", saved.path("lockVersion").asLong()), edit), 200);
        assertEquals(id, edited.path("id").asLong());
        assertEquals("recorded", edited.path("status").asText());
        assertTrue(edited.path("lockVersion").asLong() > saved.path("lockVersion").asLong());
        // 旧客户端仍请求草稿也不能把已保存巡检退回草稿
        JsonNode downgraded = call(author, body(put(path).header("X-Record-Version", edited.path("lockVersion").asLong()),
                Map.of("content", "旧客户端保存草稿", "status", "draft")), 200);
        assertEquals("recorded", downgraded.path("status").asText());
        // 同项目成员可查看但只有本人可改；跨项目拒绝
        assertEquals("recorded", call(reviewer, get(path), 200).path("status").asText());
        call(reviewer, body(put(path).header("X-Record-Version", downgraded.path("lockVersion").asLong()), Map.of("content", "他人修改")), 403);
        call(outsider, get(path), 403);
        // 已保存巡检留痕先于删除验证：删除后列表不再展示，但操作历史保留
        assertTrue(call(reviewer, get(path + "/history"), 200).size() >= 3);
        // 过期版本删除被拒且记录保留；非本人无权删除；本人携当前版本可删除（软删除为 inactive）
        call(author, delete(path).header("X-Record-Version", edited.path("lockVersion").asLong()), 409);
        assertEquals("recorded", db.queryForObject("select status from biz_daily_inspection where id=?", String.class, id));
        call(reviewer, delete(path).header("X-Record-Version", downgraded.path("lockVersion").asLong()), 403);
        call(author, delete(path).header("X-Record-Version", downgraded.path("lockVersion").asLong()), 200);
        assertEquals("inactive", db.queryForObject("select status from biz_daily_inspection where id=?", String.class, id));
        call(author, get(path), 404);
    }

    @Test void dailyLegacyReviewerStatusesReadAsSavedWithoutRewrite() throws Exception {
        Map<String, Long> ids = new LinkedHashMap<>();
        for (String status : List.of("submitted", "pending", "approved", "rejected", "recorded", "fixed", "active", "draft")) {
            long legacyId = sequence.incrementAndGet();
            db.update("insert into biz_daily_inspection(id,code,project_id,inspection_date,inspector_id,location,content,status) values (?,?,?,DATE '2026-10-29',?,?,?,?)",
                    legacyId, "LEGACY-" + status, project, author, "A区", "历史巡检", status);
            ids.put(status, legacyId);
        }
        // 已保存聚合：历史审核态与 recorded 一并出现在「已保存」筛选中，待审核筛选不再产生巡检待办
        assertEquals(7, call(author, get("/records/daily-inspections").param("status", "recorded").param("pageSize", "50"), 200).path("total").asLong());
        assertEquals(0, call(author, get("/records/daily-inspections").param("status", "submitted"), 200).path("total").asLong());
        // 读取历史记录不改库状态
        long submittedId = ids.get("submitted");
        JsonNode legacy = call(reviewer, get("/daily-inspections/" + submittedId), 200);
        assertEquals("submitted", legacy.path("status").asText());
        assertEquals("submitted", db.queryForObject("select status from biz_daily_inspection where id=?", String.class, submittedId));
        // 历史待审核记录也不再进入审核接口
        call(reviewer, body(post("/daily-inspections/" + submittedId + "/approve").header("X-Record-Version", legacy.path("lockVersion").asLong()), Map.of("status", "approved")), 400);
        // 已审核通过的历史巡检不可删除；从未被审核的遗留待审核态（submitted/pending）等同已保存，本人可删
        JsonNode approvedLegacy = call(author, get("/daily-inspections/" + ids.get("approved")), 200);
        call(author, delete("/daily-inspections/" + ids.get("approved")).header("X-Record-Version", approvedLegacy.path("lockVersion").asLong()), 409);
        JsonNode pendingLegacy = call(author, get("/daily-inspections/" + ids.get("pending")), 200);
        assertEquals("pending", pendingLegacy.path("status").asText());
        call(author, delete("/daily-inspections/" + ids.get("pending")).header("X-Record-Version", pendingLegacy.path("lockVersion").asLong()), 200);
        assertEquals("inactive", db.queryForObject("select status from biz_daily_inspection where id=?", String.class, ids.get("pending")));
        // 本人实际更新后才写成 recorded，其他项目成员仍只读
        JsonNode rewritten = call(author, body(put("/daily-inspections/" + submittedId).header("X-Record-Version", legacy.path("lockVersion").asLong()), Map.of("content", "历史巡检补充")), 200);
        assertEquals("recorded", rewritten.path("status").asText());
        call(reviewer, body(put("/daily-inspections/" + submittedId).header("X-Record-Version", rewritten.path("lockVersion").asLong()), Map.of("content", "他人改写")), 403);
        call(outsider, get("/daily-inspections/" + submittedId), 403);
        // 草稿仍是私有草稿，不混入已保存
        assertEquals(1, call(author, get("/records/daily-inspections").param("status", "draft").param("pageSize", "50"), 200).path("total").asLong());
    }

    @Test void diarySpecificationFieldsRoundTripAndLegacyPartialUpdate() throws Exception {
        var input = diary();
        Map<String, String> additions = Map.of("otherWork", "参加质量专题会议", "newIssues", "二层进度滞后，待协调", "materialInspection", "砂浆试块送检，结果待出");
        input.putAll(additions);
        input.put("authorName", "伪造记录人"); input.put("reviewerName", "伪造审核人");
        input.put("reviewerId", outsider); input.put("reviewedAt", "2026-09-23T12:00:00");
        String key = UUID.randomUUID().toString();
        JsonNode record = create(author, "supervision-diaries", input, key);
        String path = "/supervision-diaries/" + record.path("id").asLong();
        assertEquals("测试人员" + author, record.path("authorName").asText());
        assertFalse(record.hasNonNull("reviewerId")); assertFalse(record.hasNonNull("reviewerName"));
        assertEquals(record.path("id"), create(author, "supervision-diaries", input, key).path("id"));
        additions.forEach((field, value) -> assertEquals(value, record.path(field).asText()));
        JsonNode updated = call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("construction", "旧客户端只修改施工情况")), 200);
        JsonNode loaded = call(author, get(path), 200);
        additions.forEach((field, value) -> assertEquals(value, loaded.path(field).asText()));
        assertEquals("旧客户端只修改施工情况", loaded.path("construction").asText());
        assertEquals("砂浆试块送检，结果待出", db.queryForObject("select material_inspection from biz_supervision_diary where id=?", String.class, record.path("id").asLong()));
        call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("newIssues", "过期版本")), 409);
        call(author, body(put(path).header("X-Record-Version", updated.path("lockVersion").asLong()), Map.of("newIssues", "长".repeat(60001))), 400);
        // 显式发送 null，避免全局 non_null 序列化把清空请求变成省略字段。
        JsonNode cleared = call(author, put(path).header("X-Record-Version", updated.path("lockVersion").asLong())
                .contentType("application/json").content("{\"newIssues\":null}"), 200);
        assertFalse(cleared.hasNonNull("newIssues"));
        assertNull(db.queryForObject("select new_issues from biz_supervision_diary where id=?", String.class, record.path("id").asLong()));
        assertEquals(additions.get("otherWork"), cleared.path("otherWork").asText());
        JsonNode legacy = create(author, "supervision-diaries", diary(), UUID.randomUUID().toString());
        assertFalse(legacy.hasNonNull("materialInspection"));
        assertEquals("检查钢筋绑扎", legacy.path("construction").asText());
    }

    @Test void diarySpecificationApprovalSnapshotNamesAndLogSource() throws Exception {
        var input = diary();
        input.put("otherWork", "配合设计单位现场核查"); input.put("newIssues", "发现质量新问题"); input.put("materialInspection", "钢筋焊接接头见证送检");
        JsonNode record = create(author, "supervision-diaries", input, UUID.randomUUID().toString());
        record = approve(submit(record, "supervision-diaries"), "supervision-diaries", "approved");
        String path = "/supervision-diaries/" + record.path("id").asLong();
        JsonNode viewed = call(reviewer, get(path), 200);
        assertEquals("测试人员" + author, viewed.path("authorName").asText());
        assertEquals("测试人员" + reviewer, viewed.path("reviewerName").asText());
        assertEquals(reviewer, viewed.path("reviewerId").asLong());
        assertTrue(viewed.hasNonNull("reviewedAt"));
        JsonNode listed = call(reviewer, get("/supervision-diaries").param("projectId", "" + project), 200).path("list").get(0);
        assertEquals(viewed.path("authorName"), listed.path("authorName"));
        JsonNode snapshot = json.readTree(call(reviewer, get(path + "/history"), 200).get(0).path("snapshot").asText());
        assertEquals(viewed.path("reviewerName"), snapshot.path("reviewerName"));
        for (String field : List.of("otherWork", "newIssues", "materialInspection")) assertEquals(input.get(field), snapshot.path(field).asText());
        call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("otherWork", "不可改写已审核正文")), 409);
        call(outsider, get(path), 403);
        JsonNode source = call(author, get("/field/diary-source").param("projectId", "" + project).param("date", "2026-09-23"), 200);
        assertTrue(source.path("content").asText().contains("【其他工作】\n配合设计单位现场核查"));
        assertTrue(source.path("content").asText().contains("【工作中的新问题】\n发现质量新问题"));
        assertTrue(source.path("content").asText().contains("【材料进场检查】\n钢筋焊接接头见证送检"));
        assertTrue(source.path("construction").asText().contains("检查钢筋绑扎"));
        assertFalse(source.path("construction").asText().contains("配合设计单位"));
        assertFalse(source.hasNonNull("safetyIssues"));
        assertEquals(record.path("id"), source.path("sources").get(0).path("id"));
    }

    @Test void logSpecificationRoundTripLegacyUpdateAndNullClear() throws Exception {
        var input = new LinkedHashMap<String, Object>(Map.of("projectId", project, "logDate", "2026-09-23",
                "construction", "A区二层脚手架搭设至顶板", "safetyIssues", "临边防护缺失，已通知并复查完成",
                "inspection", "安全员在岗，证件有效，用电及设备验收资料核查完成", "otherMatters", "主管部门检查",
                "content", "原工作内容保持", "management", "原管理情况", "weather", "晴"));
        input.put("authorId", outsider); input.put("authorName", "伪造姓名");
        input.put("reviewerId", outsider); input.put("reviewerName", "伪造审核人");
        String key = UUID.randomUUID().toString();
        JsonNode record = create(author, "supervision-logs", input, key);
        String path = "/supervision-logs/" + record.path("id").asLong();
        assertEquals(author, record.path("authorId").asLong());
        assertEquals("测试人员" + author, record.path("authorName").asText());
        assertFalse(record.hasNonNull("reviewerId")); assertFalse(record.hasNonNull("reviewerName"));
        assertEquals(record.path("id"), create(author, "supervision-logs", input, key).path("id"));
        JsonNode saved = call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("content", "旧客户端修改综合原文")), 200);
        JsonNode loaded = call(author, get(path), 200);
        for (String field : List.of("construction", "safetyIssues", "inspection", "otherMatters")) assertEquals(input.get(field), loaded.path(field).asText());
        assertEquals("原管理情况", loaded.path("management").asText());
        assertEquals(input.get("safetyIssues"), db.queryForObject("select safety_issues from biz_supervision_log where id=?", String.class, record.path("id").asLong()));
        assertEquals(input.get("construction"), db.queryForObject("select construction from biz_supervision_log where id=?", String.class, record.path("id").asLong()));
        call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("safetyIssues", "过期写入")), 409);
        call(author, body(put(path).header("X-Record-Version", saved.path("lockVersion").asLong()), Map.of("construction", "长".repeat(60001))), 400);
        JsonNode cleared = call(author, put(path).header("X-Record-Version", saved.path("lockVersion").asLong())
                .contentType("application/json").content("{\"safetyIssues\":null}"), 200);
        assertFalse(cleared.hasNonNull("safetyIssues"));
        assertNull(db.queryForObject("select safety_issues from biz_supervision_log where id=?", String.class, record.path("id").asLong()));
        assertEquals(input.get("construction"), cleared.path("construction").asText());
        JsonNode legacy = create(author, "supervision-logs", Map.of("projectId", project, "logDate", "2020-01-01", "content", "历史混合正文"), UUID.randomUUID().toString());
        assertFalse(legacy.hasNonNull("construction")); assertFalse(legacy.hasNonNull("safetyIssues"));
        assertEquals("历史混合正文", legacy.path("content").asText());
        assertEquals("submitted", submit(legacy, "supervision-logs").path("status").asText());
    }

    @Test void logSpecificationSubmitApprovalSnapshotsAndAttachments() throws Exception {
        var file = new MockMultipartFile("file", "第三方验收单.pdf", "application/pdf", "%PDF-1.4 test".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String attachment = json.readTree(mvc.perform(multipart("/files/upload").file(file).header("Authorization", token(author)))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray()).path("data").path("url").asText();
        var input = Map.<String, Object>of("projectId", project, "logDate", "2026-09-23", "construction", "脚手架验收",
                "safetyIssues", "防护缺失已整改", "attachments", json.writeValueAsString(List.of(Map.of("url", attachment, "name", "第三方验收单.pdf"))));
        JsonNode record = create(author, "supervision-logs", input, UUID.randomUUID().toString());
        String path = "/supervision-logs/" + record.path("id").asLong();
        call(reviewer, get(path), 403); call(outsider, get(path), 403);
        call(reviewer, get("/files/access").param("url", attachment), 403);
        record = submit(record, "supervision-logs");
        assertTrue(call(reviewer, get("/files/access").param("url", attachment), 200).hasNonNull("url"));
        record = approve(record, "supervision-logs", "rejected");
        call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("safetyIssues", "不得覆盖")), 409);
        record = call(author, post(path + "/new-version"), 200);
        path = "/supervision-logs/" + record.path("id").asLong();
        record = call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("safetyIssues", "复查合格，已闭环")), 200);
        record = approve(submit(record, "supervision-logs"), "supervision-logs", "approved");
        JsonNode viewed = call(reviewer, get(path), 200);
        assertEquals("测试人员" + author, viewed.path("authorName").asText());
        assertEquals("测试人员" + reviewer, viewed.path("reviewerName").asText());
        assertTrue(viewed.hasNonNull("reviewedAt"));
        assertEquals("复查合格，已闭环", viewed.path("safetyIssues").asText());
        JsonNode listed = call(reviewer, get("/supervision-logs").param("projectId", "" + project), 200).path("list").get(0);
        assertEquals(viewed.path("authorName"), listed.path("authorName"));
        JsonNode snapshot = json.readTree(call(reviewer, get(path + "/history"), 200).get(0).path("snapshot").asText());
        for (String field : List.of("construction", "safetyIssues", "attachments", "authorName", "reviewerName")) assertEquals(viewed.path(field), snapshot.path(field));
        call(author, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("safetyIssues", "不得覆盖")), 409);
        call(outsider, get("/files/access").param("url", attachment), 403);
        var revision = new LinkedHashMap<>(input); revision.put("sourceRecordId", record.path("id").asLong());
        JsonNode revised = create(author, "supervision-logs", revision, UUID.randomUUID().toString());
        assertEquals(3, revised.path("version").asInt());
        assertEquals("脚手架验收", revised.path("construction").asText());
    }

    @Test void logSpecificationAcceptsMainWorkAndRejectsEmptySubmission() throws Exception {
        JsonNode empty = create(author, "supervision-logs", Map.of("projectId", project, "logDate", "2026-09-23", "weather", "晴"), UUID.randomUUID().toString());
        call(author, post("/supervision-logs/" + empty.path("id").asLong() + "/submit").header("X-Record-Version", empty.path("lockVersion").asLong()), 400);
        for (String field : List.of("construction", "inspection", "safetyIssues", "otherMatters")) {
            JsonNode record = create(author, "supervision-logs", Map.of("projectId", project, "logDate", "2026-09-23", field, "当日实际工作记录"), UUID.randomUUID().toString());
            assertEquals("submitted", submit(record, "supervision-logs").path("status").asText());
        }
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"supervision-diaries", "supervision-logs", "daily-inspections", "sideline-inspections"})
    void unifiedDraftListKeepsStatusPaginationPermissionsAndEditRoundTrip(String kind) throws Exception {
        String dateField = FieldRecordKind.fromPath(kind).getDateField();
        var input = new LinkedHashMap<String, Object>(Map.of("projectId", project, dateField, "2026-10-29",
                "weather", "晴", "construction", "现场施工", "location", "A区", "content", "巡视正文", "photos", "[\"" + photo + "\"]"));
        if (kind.equals("sideline-inspections")) {
            input.put("startTime", "2026-10-29T08:00:00"); input.put("endTime", "2026-10-29T09:00:00");
            input.put("content", json.writeValueAsString(Map.of("process", "浇筑", "result", "合格", "manageCount", 1, "workerCount", 2, "docs", List.of("图纸A"))));
        }
        JsonNode draftRecord = create(author, kind, input, UUID.randomUUID().toString());
        JsonNode submitted = submit(create(author, kind, input, UUID.randomUUID().toString()), kind);
        JsonNode anotherDraft = create(author, kind, input, UUID.randomUUID().toString());
        String path = "/records/" + kind;
        JsonNode list = call(author, get(path).param("projectId", "" + project).param("status", "draft").param("pageSize", "1"), 200);
        assertEquals(2, list.path("total").asInt()); assertEquals(1, list.path("list").size());
        assertEquals("draft", list.path("list").get(0).path("status").asText());
        JsonNode next = call(author, get(path).param("projectId", "" + project).param("status", "draft").param("pageSize", "1").param("pageNum", "2"), 200);
        assertNotEquals(list.path("list").get(0).path("id"), next.path("list").get(0).path("id"));
        JsonNode legacy = call(author, get("/" + kind).param("projectId", "" + project).param("status", "draft").param("pageSize", "1"), 200);
        assertEquals(legacy, list);
        assertEquals(0, call(reviewer, get(path).param("projectId", "" + project).param("status", "draft"), 200).path("total").asInt());
        assertEquals(0, call(outsider, get(path).param("status", "draft"), 200).path("total").asInt());
        call(outsider, get(path).param("projectId", "" + project).param("status", "draft"), 403);
        mvc.perform(get(path).param("status", "draft")).andExpect(status().isUnauthorized());
        assertEquals(0, call(author, get(path).param("projectId", "" + project).param("status", "draft").param("dateFrom", "2026-10-30"), 200).path("total").asInt());
        assertEquals(0, call(author, get(path).param("projectId", "" + project).param("status", "draft").param("authorId", "" + reviewer), 200).path("total").asInt());
        JsonNode byCode = call(author, get(path).param("projectId", "" + project).param("status", "draft").param("code", draftRecord.path("code").asText()), 200);
        assertEquals(1, byCode.path("total").asInt());
        String detail = "/" + kind + "/" + draftRecord.path("id").asLong();
        JsonNode changed = call(author, body(put(detail).header("X-Record-Version", draftRecord.path("lockVersion").asLong()), Map.of(dateField, "2026-10-28")), 200);
        assertEquals("2026-10-28", call(author, get(detail), 200).path(dateField).asText());
        // 日常巡检提交即保存为 recorded，不再产生“已提交”待审核列表
        boolean memo = "daily-inspections".equals(kind);
        assertEquals(memo ? "recorded" : "submitted", submit(changed, kind).path("status").asText());
        assertEquals(1, call(author, get(path).param("projectId", "" + project).param("status", "draft"), 200).path("total").asInt());
        assertEquals(memo ? 0 : 2, call(author, get(path).param("projectId", "" + project).param("status", "submitted"), 200).path("total").asInt());
        call(author, body(put("/" + kind + "/" + submitted.path("id").asLong()).header("X-Record-Version", submitted.path("lockVersion").asLong()), Map.of(dateField, "2026-10-27")), memo ? 200 : 409);
        assertEquals("draft", call(author, get("/" + kind + "/" + anotherDraft.path("id").asLong()), 200).path("status").asText());
    }

    @Test void unifiedSafetyDraftListUsesExistingProjectScope() throws Exception {
        var input = new LinkedHashMap<String, Object>(Map.of("code", "SAFE-DRAFT-" + project, "projectId", project, "logDate", "2026-10-29", "content", "安全检查"));
        JsonNode draftRecord = call(author, body(post("/safety-logs"), input), 200);
        input.put("code", "SAFE-SUBMIT-" + project);
        JsonNode submitted = call(author, body(post("/safety-logs"), input), 200);
        input.put("status", "submitted");
        call(author, body(put("/safety-logs/" + submitted.path("id").asLong()), input), 200);
        JsonNode listed = call(author, get("/records/safety-logs").param("projectId", "" + project).param("status", "draft"), 200);
        assertEquals(1, listed.path("total").asInt()); assertEquals(draftRecord.path("id"), listed.path("list").get(0).path("id"));
        assertEquals(listed, call(author, get("/safety-logs").param("pageSize", "20").param("projectId", "" + project).param("status", "draft"), 200));
        assertEquals(0, call(outsider, get("/records/safety-logs").param("status", "draft"), 200).path("total").asInt());
        call(author, get("/records/unknown").param("status", "draft"), 404);
        mvc.perform(get("/records/safety-logs").param("status", "draft")).andExpect(status().isUnauthorized());
    }

    @Test void identityProjectScopeAndIdempotentReplay() throws Exception {
        var input = diary(); input.put("authorId", outsider);
        String key = UUID.randomUUID().toString();
        JsonNode first = create(author, "supervision-diaries", input, key);
        assertEquals(author, first.path("authorId").asLong());
        assertEquals(first.path("id"), create(author, "supervision-diaries", input, key).path("id"));
        input.put("construction", "不同请求内容");
        call(author, body(post("/supervision-diaries").header("Idempotency-Key", key), input), 409);
        call(outsider, get("/supervision-diaries/" + first.path("id").asLong()), 403);
        call(reviewer, get("/supervision-diaries/" + first.path("id").asLong()), 403);
        input.put("projectId", otherProject);
        call(author, body(post("/supervision-diaries").header("Idempotency-Key", UUID.randomUUID()), input), 403);
        assertEquals(0, call(outsider, get("/supervision-diaries"), 200).path("total").asInt());
    }

    @Test void rejectEditResubmitAndApprovedLock() throws Exception {
        JsonNode record = create(author, "supervision-diaries", diary(), UUID.randomUUID().toString());
        long id = record.path("id").asLong();
        call(author, body(put("/supervision-diaries/" + id), diary()), 428);
        record = submit(record, "supervision-diaries");
        call(author, body(post("/supervision-diaries/" + id + "/approve").header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("status", "approved")), 403);
        call(reviewer, body(post("/supervision-diaries/" + id + "/approve").header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("status", "rejected")), 400);
        record = approve(record, "supervision-diaries", "rejected");
        call(author, body(put("/supervision-diaries/" + id).header("X-Record-Version", record.path("lockVersion").asLong()), diary()), 409);
        record = call(author, post("/supervision-diaries/" + id + "/new-version"), 200);
        id = record.path("id").asLong();
        record = call(author, body(put("/supervision-diaries/" + id).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("construction", "补充后的内容")), 200);
        record = approve(submit(record, "supervision-diaries"), "supervision-diaries", "approved");
        call(author, body(put("/supervision-diaries/" + id).header("X-Record-Version", record.path("lockVersion").asLong()), diary()), 409);
        assertTrue(call(author, get("/supervision-diaries/" + id + "/history"), 200).size() >= 4);
        var revision = diary(); revision.put("sourceRecordId", id);
        JsonNode revised = create(author, "supervision-diaries", revision, UUID.randomUUID().toString());
        assertEquals(id, revised.path("sourceRecordId").asLong()); assertEquals(3, revised.path("version").asInt());
    }

    @Test void rejectedDiaryAndLogVersionsRemainImmutableThroughV3() throws Exception {
        for (String kind : List.of("supervision-diaries", "supervision-logs")) {
            String dateField = kind.equals("supervision-diaries") ? "diaryDate" : "logDate";
            var input = diary(); input.remove("diaryDate"); input.put(dateField, "2026-09-23");
            JsonNode original = create(author, kind, input, UUID.randomUUID().toString());
            String root = "/" + kind + "/" + original.path("id").asLong();
            call(author, post(root + "/new-version"), 409);
            original = submit(original, kind);
            call(author, post(root + "/new-version"), 409);
            original = approve(original, kind, "rejected");
            // 与后续 GET 使用同一时间精度，仍完整比较正文、照片、状态和审核元数据。
            original = call(author, get(root), 200);
            long lock = original.path("lockVersion").asLong();
            call(author, body(put(root).header("X-Record-Version", lock), Map.of("construction", "篡改", "photos", "[]")), 409);
            call(author, delete(root).header("X-Record-Version", lock), 409);
            call(author, post(root + "/submit").header("X-Record-Version", lock), 409);
            call(reviewer, post(root + "/new-version"), 403);
            call(outsider, get(root + "/versions"), 403);
            JsonNode second = call(author, post(root + "/new-version"), 200);
            assertEquals(2, second.path("version").asInt());
            assertEquals(original.path("id"), second.path("sourceRecordId"));
            assertEquals(original.path("photos"), second.path("photos"));
            assertFalse(second.hasNonNull("reviewerId")); assertFalse(second.hasNonNull("rejectReason"));
            assertFalse(second.hasNonNull("submittedAt"));
            assertEquals(second.path("id"), call(author, post(root + "/new-version"), 200).path("id"));
            String secondPath = "/" + kind + "/" + second.path("id").asLong();
            call(author, body(put(secondPath).header("X-Record-Version", second.path("lockVersion").asLong()), Map.of(dateField, "2026-09-24")), 400);
            var duplicate = new LinkedHashMap<>(input); duplicate.put("sourceRecordId", original.path("id").asLong());
            call(author, body(post("/" + kind).header("Idempotency-Key", UUID.randomUUID().toString()), duplicate), 409);
            second = call(author, body(put(secondPath).header("X-Record-Version", second.path("lockVersion").asLong()), Map.of("construction", "V2补充内容")), 200);
            second = approve(submit(second, kind), kind, "rejected");
            JsonNode third = call(author, post(secondPath + "/new-version"), 200);
            assertEquals(3, third.path("version").asInt());
            third = approve(submit(third, kind), kind, "approved");
            JsonNode versions = call(reviewer, get("/" + kind + "/" + third.path("id").asLong() + "/versions"), 200);
            assertEquals(3, versions.size());
            assertEquals("rejected", versions.get(0).path("status").asText());
            assertEquals("V2补充内容", versions.get(1).path("construction").asText());
            assertEquals(original, call(author, get(root), 200));
            call(reviewer, get("/files/access").param("url", photo), 200);
        }
    }

    @Test void safetyRejectedVersionsAreSeparateRowsAndKeepHistory() throws Exception {
        var input = new LinkedHashMap<String, Object>(Map.of("code", "AQ-" + UUID.randomUUID(), "projectId", project,
                "logDate", "2026-09-23", "content", "V1安全正文", "photos", "[\"" + photo + "\"]", "attachments", "[]"));
        JsonNode first = call(author, body(post("/safety-logs"), input), 200);
        String root = "/safety-logs/" + first.path("id").asLong();
        call(author, post(root + "/new-version"), 409);
        input.put("status", "submitted");
        first = call(author, body(put(root), input), 200);
        call(author, body(put(root), input), 409); call(author, delete(root), 409);
        first = call(reviewer, body(post(root + "/approve"), Map.of("status", "rejected", "rejectReason", "补充防护记录")), 200);
        // 数据库存储会规范化时间精度，使用驳回后的读取结果作为原件不可变基线。
        first = call(author, get(root), 200);
        call(author, body(put(root), input), 409); call(author, delete(root), 409);
        call(reviewer, post(root + "/new-version"), 403); call(outsider, get(root + "/versions"), 403);
        JsonNode second = call(author, post(root + "/new-version"), 200);
        assertEquals(2, second.path("version").asInt()); assertNotEquals(first.path("id"), second.path("id"));
        assertNotEquals(first.path("code"), second.path("code"));
        assertEquals(first.path("id"), second.path("sourceRecordId"));
        assertFalse(second.hasNonNull("submittedAt")); assertFalse(second.hasNonNull("reviewerId")); assertFalse(second.hasNonNull("rejectReason"));
        assertEquals(second.path("id"), call(author, post(root + "/new-version"), 200).path("id"));
        String secondPath = "/safety-logs/" + second.path("id").asLong();
        input.put("code", second.path("code").asText()); input.put("content", "V2安全正文"); input.put("photos", "[]");
        input.put("logDate", "2026-09-24"); call(author, body(put(secondPath), input), 400); input.put("logDate", "2026-09-23");
        call(author, body(put(secondPath), input), 200);
        call(reviewer, body(post(secondPath + "/approve"), Map.of("status", "rejected", "rejectReason", "再次补充")), 200);
        JsonNode third = call(author, post(secondPath + "/new-version"), 200);
        assertEquals(3, third.path("version").asInt());
        JsonNode versions = call(author, get("/safety-logs/" + third.path("id").asLong() + "/versions"), 200);
        assertEquals(3, versions.size());
        assertEquals("V1安全正文", versions.get(0).path("content").asText());
        assertEquals("V2安全正文", versions.get(1).path("content").asText());
        assertEquals("[]", versions.get(1).path("photos").asText());
        assertEquals(first, call(author, get(root), 200));
        call(reviewer, get("/files/access").param("url", photo), 200);
    }

    @Test void concurrentRevisionRequestsResumeOneChildForAllThreeKinds() throws Exception {
        for (String kind : List.of("supervision-diaries", "supervision-logs", "safety-logs")) {
            boolean safety = kind.equals("safety-logs");
            var input = diary();
            if (!kind.equals("supervision-diaries")) { input.remove("diaryDate"); input.put("logDate", "2026-09-23"); }
            input.put("code", "REV-" + UUID.randomUUID()); input.put("content", "现场记录");
            JsonNode first = safety ? call(author, body(post("/" + kind), input), 200) : create(author, kind, input, UUID.randomUUID().toString());
            String path = "/" + kind + "/" + first.path("id").asLong();
            if (safety) {
                input.put("status", "submitted"); call(author, body(put(path), input), 200);
                call(reviewer, body(post(path + "/approve"), Map.of("status", "rejected", "rejectReason", "补充")), 200);
            } else approve(submit(first, kind), kind, "rejected");
            ExecutorService pool = Executors.newFixedThreadPool(2);
            CountDownLatch start = new CountDownLatch(1);
            try {
                Callable<JsonNode> task = () -> { start.await(); return call(author, post(path + "/new-version"), 200); };
                Future<JsonNode> a = pool.submit(task), b = pool.submit(task); start.countDown();
                assertEquals(a.get(15, TimeUnit.SECONDS).path("id"), b.get(15, TimeUnit.SECONDS).path("id"));
            } finally { pool.shutdownNow(); }
        }
    }

    @Test void approvedGrandchildSupersedesApprovedAncestorAcrossRejection() throws Exception {
        JsonNode first = approve(submit(create(author, "supervision-diaries", diary(), UUID.randomUUID().toString()), "supervision-diaries"), "supervision-diaries", "approved");
        JsonNode second = call(author, post("/supervision-diaries/" + first.path("id").asLong() + "/new-version"), 200);
        second = approve(submit(second, "supervision-diaries"), "supervision-diaries", "rejected");
        JsonNode third = call(author, post("/supervision-diaries/" + second.path("id").asLong() + "/new-version"), 200);
        third = approve(submit(third, "supervision-diaries"), "supervision-diaries", "approved");
        JsonNode source = call(reviewer, get("/field/diary-source").param("projectId", "" + project).param("date", "2026-09-23"), 200);
        assertEquals(1, source.path("sources").size()); assertEquals(third.path("id"), source.path("sources").get(0).path("id"));
    }

    @Test void staleVersionNeverOverwritesPcOrMobile() throws Exception {
        JsonNode first = create(author, "supervision-diaries", diary(), UUID.randomUUID().toString());
        String path = "/supervision-diaries/" + first.path("id").asLong();
        call(author, body(put(path).header("X-Record-Version", 0), Map.of("construction", "PC更新")), 200);
        call(author, body(put(path).header("X-Record-Version", 0), Map.of("construction", "手机旧稿")), 409);
        assertEquals("PC更新", call(author, get(path), 200).path("construction").asText());
    }

    @Test void serverSideSingleDateSourceAndNoDraftCounting() throws Exception {
        JsonNode record = create(author, "supervision-diaries", diary(), UUID.randomUUID().toString());
        assertEquals(0, call(author, get("/field/diary-source").param("projectId", "" + project).param("date", "2026-09-23"), 200).path("sources").size());
        record = approve(submit(record, "supervision-diaries"), "supervision-diaries", "approved");
        JsonNode source = call(author, get("/field/diary-source").param("projectId", "" + project).param("date", "2026-09-23"), 200);
        assertEquals(1, source.path("sources").size());
        assertEquals(0, call(author, get("/field/diary-source").param("projectId", "" + project).param("date", "2026-09-24"), 200).path("sources").size());
        var log = new LinkedHashMap<String, Object>(Map.of("projectId", project, "logDate", "2026-09-23", "content", source.path("content").asText(), "diarySources", source.path("sources").toString()));
        JsonNode saved = create(author, "supervision-logs", log, UUID.randomUUID().toString());
        assertEquals(record.path("id").asLong(), json.readTree(saved.path("diarySources").asText()).get(0).path("id").asLong());
        log.put("logDate", "2026-09-24");
        call(author, body(post("/supervision-logs").header("Idempotency-Key", UUID.randomUUID()), log), 409);
        JsonNode summary = call(author, get("/field/summary").param("projectId", "" + project).param("date", "2026-09-23"), 200);
        assertEquals(1, summary.path("supervision-logs").path("draft").asInt());
        assertEquals(0, summary.path("supervision-logs").path("submitted").asInt());
    }

    @Test void diaryPrefillReturnsOnlySharedOriginalValuesWithoutWrites() throws Exception {
        var input = diary();
        Map<String, String> expected = Map.of("weather", "晴", "wind", "东北风3级", "temperature", "18℃～25℃",
                "construction", "A区二层施工\n完成60%", "inspection", "巡视临边防护，核查验收资料",
                "safetyIssues", "质量偏差及临边缺口，处理结果待核实", "otherMatters", "主管部门检查",
                "management", "管理人员在岗", "morningMeeting", "晨会安排巡视", "drawingReview", "核对变更图纸");
        expected.forEach((field, value) -> input.put(field.equals("safetyIssues") ? "newIssues" : field, value));
        input.put("otherWork", "不属于共享字段的其他工作"); input.put("materialInspection", "材料进场原文");
        JsonNode diaryRecord = approve(submit(create(author, "supervision-diaries", input, UUID.randomUUID().toString()), "supervision-diaries"), "supervision-diaries", "approved");
        JsonNode log = create(reviewer, "supervision-logs", Map.of("projectId", project, "logDate", "2026-09-23", "construction", "领导手写内容"), UUID.randomUUID().toString());
        // 数据库存储时间精度与创建响应可能不同，使用落库后的读取结果作只读基线。
        diaryRecord = call(author, get("/supervision-diaries/" + diaryRecord.path("id").asLong()), 200);
        int events = db.queryForObject("select count(*) from biz_field_record_event", Integer.class);
        JsonNode prefill = call(reviewer, get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-23"), 200);
        Set<String> keys = new HashSet<>(); prefill.fieldNames().forEachRemaining(keys::add);
        assertEquals(expected.keySet(), keys);
        expected.forEach((field, value) -> assertEquals(value, prefill.path(field).asText(), field));
        assertEquals(prefill, call(author, get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-23"), 200));
        JsonNode unchanged = call(reviewer, get("/supervision-logs/" + log.path("id").asLong()), 200);
        assertEquals("领导手写内容", unchanged.path("construction").asText());
        assertFalse(unchanged.hasNonNull("safetyIssues")); assertFalse(unchanged.hasNonNull("diarySources"));
        assertEquals(log.path("lockVersion"), unchanged.path("lockVersion"));
        assertEquals(diaryRecord, call(author, get("/supervision-diaries/" + diaryRecord.path("id").asLong()), 200));
        assertEquals(events, db.queryForObject("select count(*) from biz_field_record_event", Integer.class));
    }

    // 直接准备不同项目、日期和状态的历史记录，查询仍经过真实 MVC、权限及 JPA。
    void seedPrefillDiary(long pid, long uid, String date, String status, String text) {
        db.update("insert into biz_supervision_diary(code,project_id,author_id,diary_date,status,construction,weather) values (?,?,?,?,?,?,?)",
                "PREFILL-" + sequence.incrementAndGet(), pid, uid, date, status, text, "晴");
    }

    @Test void diaryPrefillFiltersDateProjectAndApprovalStatus() throws Exception {
        for (String status : List.of("draft", "submitted", "pending", "rejected", "inactive", "recorded"))
            seedPrefillDiary(project, author, "2026-09-23", status, "排除" + status);
        seedPrefillDiary(otherProject, outsider, "2026-09-23", "approved", "排除其他项目");
        seedPrefillDiary(project, author, "2026-09-24", "approved", "排除其他日期");
        seedPrefillDiary(project, author, "2026-09-23", "approved", "只取本项目本日已审核");
        JsonNode prefill = call(reviewer, get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-23"), 200);
        assertEquals("只取本项目本日已审核", prefill.path("construction").asText());
        JsonNode empty = call(reviewer, get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-25"), 200);
        assertEquals(10, empty.size()); empty.forEach(value -> assertEquals("", value.asText()));
    }

    @Test void diaryPrefillMergesMultipleAuthorsDeduplicatesAndLeavesWeatherConflictsBlank() throws Exception {
        long colleague = sequence.incrementAndGet();
        db.update("insert into sys_user(id,name,status,project_id) values (?,?,'active',?)", colleague, "另一普通员工", project);
        // 故意先插入较大作者 ID，验证合并顺序由作者及记录 ID 决定。
        seedPrefillDiary(project, colleague, "2026-09-23", "approved", "B区已完成");
        seedPrefillDiary(project, author, "2026-09-23", "approved", "A区施工\n原始换行");
        seedPrefillDiary(project, colleague, "2026-09-23", "approved", "A区施工\n原始换行");
        db.update("update biz_supervision_diary set inspection='共同检查',wind='3级',temperature='20℃' where project_id=?", project);
        db.update("update biz_supervision_diary set weather='阴',temperature='22℃',new_issues='临边防护待补齐' where project_id=? and author_id=?", project, colleague);
        JsonNode prefill = call(reviewer, get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-23"), 200);
        assertEquals("A区施工\n原始换行\n\nB区已完成", prefill.path("construction").asText());
        assertEquals("共同检查", prefill.path("inspection").asText());
        assertEquals("临边防护待补齐", prefill.path("safetyIssues").asText());
        assertEquals("", prefill.path("weather").asText()); assertEquals("", prefill.path("temperature").asText());
        assertEquals("3级", prefill.path("wind").asText());
    }

    @Test void diaryPrefillUsesApprovedRevisionOnlyAfterApproval() throws Exception {
        JsonNode original = approve(submit(create(author, "supervision-diaries", diary(), UUID.randomUUID().toString()), "supervision-diaries"), "supervision-diaries", "approved");
        var input = diary(); input.put("sourceRecordId", original.path("id").asLong()); input.put("construction", "修订后的施工进度");
        JsonNode revision = create(author, "supervision-diaries", input, UUID.randomUUID().toString());
        assertEquals("检查钢筋绑扎", call(reviewer, get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-23"), 200).path("construction").asText());
        approve(submit(revision, "supervision-diaries"), "supervision-diaries", "approved");
        assertEquals("修订后的施工进度", call(reviewer, get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-23"), 200).path("construction").asText());
    }

    @Test void diaryPrefillRequiresAuthenticationProjectAccessAndValidDate() throws Exception {
        seedPrefillDiary(project, author, "2026-09-23", "approved", "受保护正文");
        mvc.perform(get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-23")).andExpect(status().isUnauthorized());
        call(outsider, get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-23"), 403);
        call(reviewer, get("/field/diary-prefill").param("projectId", "" + project), 400);
        call(reviewer, get("/field/diary-prefill").param("projectId", "" + project).param("date", "非日期"), 400);
        db.update("insert into biz_project_member(project_id,user_id,enabled,can_review) values (?,?,false,false)", project, reviewer);
        call(reviewer, get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-23"), 403);
    }

    @Test void diaryPrefillRejectsOversizedMergedFieldWithoutTruncation() throws Exception {
        seedPrefillDiary(project, author, "2026-09-23", "approved", "甲".repeat(30000));
        seedPrefillDiary(project, author, "2026-09-23", "approved", "乙".repeat(30000));
        MvcResult result = mvc.perform(get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-23").header("Authorization", token(reviewer)))
                .andExpect(status().isBadRequest()).andReturn();
        assertTrue(json.readTree(result.getResponse().getContentAsByteArray()).path("message").asText().contains("不自动截断"));
    }

    @Test void diaryPrefillRejectsMoreThanFiveHundredSources() throws Exception {
        List<Object[]> rows = new ArrayList<>();
        for (int i = 0; i < 500; i++) rows.add(new Object[]{"LIMIT-" + sequence.incrementAndGet(), project, author});
        db.batchUpdate("insert into biz_supervision_diary(code,project_id,author_id,diary_date,status,construction) values (?,?,?,'2026-09-23','approved','相同原文')", rows);
        assertEquals("相同原文", call(reviewer, get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-23"), 200).path("construction").asText());
        seedPrefillDiary(project, author, "2026-09-23", "approved", "第501份");
        call(reviewer, get("/field/diary-prefill").param("projectId", "" + project).param("date", "2026-09-23"), 400);
    }

    @Test void protectedAttachmentsAndRevokedMembership() throws Exception {
        JsonNode record = create(author, "supervision-diaries", diary(), UUID.randomUUID().toString());
        call(outsider, get("/files/access").param("url", photo), 403);
        call(reviewer, get("/files/access").param("url", photo), 403);
        record = submit(record, "supervision-diaries");
        JsonNode link = call(reviewer, get("/files/access").param("url", photo), 200);
        String url = link.path("url").asText().substring(4);
        mvc.perform(get(java.net.URI.create(url))).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "private, no-store"));
        mvc.perform(get(photo.substring(4))).andExpect(status().isUnauthorized());
        mvc.perform(get(java.net.URI.create(url + "x"))).andExpect(status().isForbidden());
        db.update("insert into biz_project_member(project_id,user_id,enabled,can_review) values (?,?,false,false)", project, author);
        call(author, get("/supervision-diaries/" + record.path("id").asLong()), 403);
        call(author, get("/files/access").param("url", photo), 403);
    }

    @Test void formalValidationAndAllFourTypes() throws Exception {
        var noPhoto = diary(); noPhoto.put("photos", "[]");
        JsonNode diary = create(author, "supervision-diaries", noPhoto, UUID.randomUUID().toString());
        call(author, post("/supervision-diaries/" + diary.path("id").asLong() + "/submit").header("X-Record-Version", 0), 400);
        var daily = new LinkedHashMap<String, Object>(Map.of("projectId", project, "inspectionDate", "2026-09-23", "location", "A区", "content", "巡检记录"));
        JsonNode r = create(author, "daily-inspections", daily, UUID.randomUUID().toString());
        JsonNode memo = submit(r, "daily-inspections");
        assertEquals("recorded", memo.path("status").asText());
        call(reviewer, body(post("/daily-inspections/" + memo.path("id").asLong() + "/approve").header("X-Record-Version", memo.path("lockVersion").asLong()), Map.of("status", "approved")), 400);
        daily.put("startTime", "2026-09-23T08:00:00"); daily.put("endTime", "2026-09-23T09:00:00");
        daily.put("content", json.writeValueAsString(Map.of("process", "浇筑", "result", "合格", "manageCount", 1, "workerCount", 2, "docs", List.of("图纸A"))));
        r = create(author, "sideline-inspections", daily, UUID.randomUUID().toString());
        approve(submit(r, "sideline-inspections"), "sideline-inspections", "approved");
        daily.put("status", "recorded");
        call(author, body(post("/sideline-inspections").header("Idempotency-Key", UUID.randomUUID()), daily), 400);
    }

    @Test void legacyReferencesCannotLaunderProtectedPhotos() throws Exception {
        create(author, "supervision-diaries", diary(), UUID.randomUUID().toString());
        for (var endpoint : Map.of("supervision-notices", "noticeDate", "work-contacts", "contactDate", "safety-logs", "logDate", "meeting-minutes", "meetingDate", "supervision-monthly-reports", "reportMonth").entrySet()) {
            var input = new LinkedHashMap<String, Object>();
            input.put("code", "LEG-" + UUID.randomUUID()); input.put("title", "测试"); input.put("content", "测试");
            input.put("projectId", otherProject); input.put(endpoint.getValue(), endpoint.getValue().equals("reportMonth") ? "2026-09" : "2026-09-23");
            input.put("photos", "[\"" + photo + "\"]");
            call(outsider, body(post("/" + endpoint.getKey()), input), 403);
            input.put("projectId", project);
            call(reviewer, body(post("/" + endpoint.getKey()), input), 403);
        }
        call(outsider, get("/files/access").param("url", photo), 403);
        call(outsider, body(post("/project-documents"), Map.of("projectId", otherProject, "name", "冒用", "filePath", photo)), 403);
        // 即使历史脏数据有伪造引用，已登记的文件仍以原项目约束为准。
        db.update("insert into biz_supervision_notice(code,project_id,notice_date,title,status,photos) values (?,?,CURRENT_DATE,'伪造','draft',?)", "BAD-" + project, otherProject, "[\"" + photo + "\"]");
        call(outsider, get("/files/access").param("url", photo), 403);
    }

    @Test void projectDocumentsAndManagerRevocation() throws Exception {
        long subItem = sequence.incrementAndGet();
        db.update("insert into biz_sub_item_database(id,project_id,name,status) values (?,?,'资料目录','active')", subItem, project);
        call(author, body(post("/project-documents"), Map.of("projectId", project, "name", "资料", "filePath", photo)), 400);
        JsonNode doc = call(author, body(post("/project-documents"), Map.of("projectId", project, "subItemId", subItem, "name", "资料", "filePath", photo)), 200);
        long otherItem = sequence.incrementAndGet();
        db.update("insert into biz_sub_item_database(id,project_id,name,status) values (?,?,'其他项目目录','active')", otherItem, otherProject);
        call(author, body(post("/project-documents"), Map.of("projectId", project, "subItemId", otherItem, "name", "资料", "filePath", photo)), 400);
        assertEquals(author, doc.path("uploaderId").asLong());
        call(reviewer, get("/files/access").param("url", photo), 200);
        call(outsider, get("/project-documents/" + doc.path("id").asLong()), 403);
        db.update("insert into biz_project_member(project_id,user_id,enabled,can_review) values (?,?,false,false)", project, reviewer);
        call(reviewer, get("/files/access").param("url", photo), 403);
        call(reviewer, get("/field/summary").param("projectId", "" + project).param("date", "2026-09-23"), 403);
    }

    @Test void approvedRevisionDoesNotDuplicateDiarySource() throws Exception {
        JsonNode first = approve(submit(create(author, "supervision-diaries", diary(), UUID.randomUUID().toString()), "supervision-diaries"), "supervision-diaries", "approved");
        var input = diary(); input.put("sourceRecordId", first.path("id").asLong());
        JsonNode revision = approve(submit(create(author, "supervision-diaries", input, UUID.randomUUID().toString()), "supervision-diaries"), "supervision-diaries", "approved");
        JsonNode source = call(author, get("/field/diary-source").param("projectId", "" + project).param("date", "2026-09-23"), 200);
        assertEquals(1, source.path("sources").size());
        assertEquals(revision.path("id"), source.path("sources").get(0).path("id"));
    }

    @Test void emptyCodeUpdateKeepsAssignedNumber() throws Exception {
        JsonNode first = create(author, "supervision-diaries", diary(), UUID.randomUUID().toString());
        JsonNode updated = call(author, body(put("/supervision-diaries/" + first.path("id").asLong())
                .header("X-Record-Version", first.path("lockVersion").asLong()), Map.of("code", "", "construction", "补充")), 200);
        assertEquals(first.path("code"), updated.path("code"));
    }

    @Test void legacyPhotoPathsRemainScopedAndExact() throws Exception {
        JsonNode record = create(author, "supervision-diaries", diary(), UUID.randomUUID().toString());
        long id = record.path("id").asLong();
        String name = "legacy_" + project + ".jpg";
        String canonical = "/api/uploads/20260923/" + name;
        for (String prefix : List.of("/api/uploads/20260923/", "/uploads/20260923/", "uploads/20260923/", "uploads\\20260923\\")) {
            db.update("update biz_supervision_diary set photos=? where id=?", json.writeValueAsString(List.of(prefix + name)), id);
            call(author, get("/files/access").param("url", canonical), 200);
            call(reviewer, get("/files/access").param("url", canonical), 403);
            call(outsider, get("/files/access").param("url", canonical), 403);
            call(author, get("/files/access").param("url", "/api/uploads/20260924/" + name), 403);
        }
        db.update("update biz_supervision_diary set status='submitted' where id=?", id);
        call(reviewer, get("/files/access").param("url", canonical), 200);
        db.update("update biz_supervision_diary set status='inactive' where id=?", id);
        call(author, get("/files/access").param("url", canonical), 403);
    }

    @Test void legacyNonFieldReferencesSkipMalformedRows() throws Exception {
        String name = "notice_" + project + ".jpg", canonical = "/api/uploads/" + name;
        db.update("insert into biz_supervision_notice(code,project_id,notice_date,title,status,photos) values (?,?,CURRENT_DATE,'旧资料','draft',?)",
                "BROKEN-" + project, project, "broken " + name);
        db.update("insert into biz_supervision_notice(code,project_id,notice_date,title,status,photos) values (?,?,CURRENT_DATE,'旧资料','draft',?)",
                "OLD-" + project, project, json.writeValueAsString(List.of(Map.of("url", "uploads\\" + name))));
        call(author, get("/files/access").param("url", canonical), 200);
        call(outsider, get("/files/access").param("url", canonical), 403);
        call(author, get("/files/access").param("url", "/api/uploads/20260923/" + name), 403);
    }

    @Test void legacySnapshotAttachmentRequiresCurrentRecordVisibility() throws Exception {
        JsonNode record = create(author, "supervision-diaries", diary(), UUID.randomUUID().toString());
        long id = record.path("id").asLong();
        String name = "history_" + project + ".jpg", canonical = "/api/uploads/" + name;
        String snapshot = json.writeValueAsString(Map.of("photos", json.writeValueAsString(List.of("uploads\\" + name))));
        db.update("insert into biz_field_record_event(record_type,record_id,actor_id,action,snapshot) values ('supervision-diaries',?,?,'save',?)", id, author, snapshot);
        call(author, get("/files/access").param("url", canonical), 200);
        call(reviewer, get("/files/access").param("url", canonical), 403);
        call(outsider, get("/files/access").param("url", canonical), 403);
        db.update("update biz_supervision_diary set status='submitted' where id=?", id);
        call(reviewer, get("/files/access").param("url", canonical), 200);
    }

    @Test void qa22ConcurrentExplicitAndAutomaticCodes() throws Exception {
        for (int round = 0; round < 4; round++) {
            var input = diary();
            if (round < 3) input.put("code", "QA22C-" + UUID.randomUUID());
            String key = UUID.randomUUID().toString();
            var barrier = new CyclicBarrier(4);
            // 保证四个请求均已完成首次查重，再进入真实附件锁和数据库事务。
            doAnswer(invocation -> {
                barrier.await(15, TimeUnit.SECONDS);
                return invocation.callRealMethod();
            }).when(attachmentService).bind(any(FieldRecord.class));
            var pool = Executors.newFixedThreadPool(4);
            List<Future<JsonNode>> futures = new ArrayList<>();
            JsonNode first;
            try {
                for (int i = 0; i < 4; i++) futures.add(pool.submit(() -> create(author, "supervision-diaries", input, key)));
                first = futures.get(0).get(30, TimeUnit.SECONDS);
                for (var future : futures) assertEquals(first.path("id"), future.get(30, TimeUnit.SECONDS).path("id"));
            } finally {
                pool.shutdownNow();
                assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS));
                reset(attachmentService);
            }
            assertEquals(first.path("id"), create(author, "supervision-diaries", input, key).path("id"));
            assertEquals(1, db.queryForObject("select count(*) from biz_supervision_diary where code=?", Integer.class, first.path("code").asText()));
            assertEquals(1, db.queryForObject("select count(*) from biz_field_record_event where record_type='supervision-diaries' and record_id=? and action='create'", Integer.class, first.path("id").asLong()));
            if (round < 3) call(author, body(post("/supervision-diaries").header("Idempotency-Key", UUID.randomUUID()), input), 409);
            input.put("construction", "同键不同内容必须拒绝");
            call(author, body(post("/supervision-diaries").header("Idempotency-Key", key), input), 409);
            JsonNode submitted = submit(first, "supervision-diaries");
            assertEquals("submitted", submitted.path("status").asText());
        }
    }

    @Test void qa22MessagesArePrivateToRecipient() throws Exception {
        long id = sequence.incrementAndGet();
        db.update("insert into sys_message(id,sender_id,receiver_id,title,content,is_read) values (?,?,?,'QA22消息','隔离测试','0')", id, reviewer, author);
        assertEquals(1, call(author, get("/messages"), 200).path("total").asInt());
        assertEquals(0, call(outsider, get("/messages"), 200).path("total").asInt());
        call(outsider, get("/messages").param("receiverId", "" + author), 403);
        call(outsider, get("/messages/" + id), 403);
        call(outsider, get("/messages/unread-count").param("receiverId", "" + author), 403);
        call(outsider, put("/messages/" + id + "/read"), 403);
        call(outsider, delete("/messages/" + id), 403);
        assertEquals("0", db.queryForObject("select is_read from sys_message where id=?", String.class, id));
        assertEquals(1, call(author, get("/messages/unread-count").param("receiverId", "" + author), 200).asInt());
        call(author, put("/messages/" + id + "/read"), 200);
        assertEquals(0, call(author, get("/messages/unread-count").param("receiverId", "" + author), 200).asInt());
        call(author, delete("/messages/" + id), 200);
        assertEquals(0, db.queryForObject("select count(*) from sys_message where id=?", Integer.class, id));
    }

    @Test void qa22MessageSenderAndAccountStatusAreServerControlled() throws Exception {
        JsonNode message = call(reviewer, body(post("/messages"), Map.of("senderId", outsider,
                "receiverId", author, "title", "QA22隔离消息", "content", "发送人不能冒用")), 200);
        assertEquals(reviewer, message.path("senderId").asLong());
        long id = message.path("id").asLong();
        assertEquals(id, call(author, get("/messages/" + id), 200).path("id").asLong());
        call(reviewer, get("/messages/" + id), 403);
        mvc.perform(get("/messages/" + id).header("Authorization", "Bearer " + jwt.generateToken(outsider, "测试", List.of("admin"))))
                .andExpect(status().isForbidden());
        db.update("update sys_user set status='inactive' where id=?", author);
        call(author, get("/messages"), 401);
        call(author, put("/messages/" + id + "/read"), 401);
        assertEquals("0", db.queryForObject("select is_read from sys_message where id=?", String.class, id));
    }

    @Test void qa22WorkStandardsRequireCurrentAdministrator() throws Exception {
        long role = sequence.incrementAndGet();
        db.update("insert into sys_role(id,name,code,status) values (?,'QA22管理员','admin','active')", role);
        db.update("insert into sys_user_role(user_id,role_id) values (?,?)", reviewer, role);
        var config = new LinkedHashMap<String, Object>(Map.of("name", "diaryDeadline", "module", "work-standard", "standard", "17:30", "description", "QA22隔离配置"));
        JsonNode saved = call(reviewer, body(post("/work-standard-configs"), config), 200);
        long id = saved.path("id").asLong();
        assertEquals("17:30", call(author, get("/work-standard-configs/" + id), 200).path("standard").asText());
        config.put("standard", "16:00");
        call(author, body(post("/work-standard-configs"), config), 403);
        call(author, body(put("/work-standard-configs/" + id), config), 403);
        call(author, delete("/work-standard-configs/" + id), 403);
        assertEquals("17:30", call(reviewer, get("/work-standard-configs/" + id), 200).path("standard").asText());
        config.put("standard", "18:30");
        assertEquals("18:30", call(reviewer, body(put("/work-standard-configs/" + id), config), 200).path("standard").asText());
        db.update("delete from sys_user_role where user_id=? and role_id=?", reviewer, role);
        // 旧令牌携带管理员声明也不能绕过数据库中的撤权。
        mvc.perform(body(put("/work-standard-configs/" + id), config)
                .header("Authorization", "Bearer " + jwt.generateToken(reviewer, "测试", List.of("admin"))))
                .andExpect(status().isForbidden());
        db.update("insert into sys_user_role(user_id,role_id) values (?,?)", reviewer, role);
        call(reviewer, delete("/work-standard-configs/" + id), 200);
        assertEquals("inactive", db.queryForObject("select status from sys_work_standard_config where id=?", String.class, id));
    }

    // 上线验收按安全契约断言；失败保留为阻塞证据，不能改成接受漏洞的断言。
    @Test void qaAcceptanceDraftIsPersistedAndApprovalIsScoped() throws Exception {
        JsonNode record = create(author, "supervision-diaries", diary(), UUID.randomUUID().toString());
        long id = record.path("id").asLong();
        assertEquals("draft", db.queryForObject("select status from biz_supervision_diary where id=?", String.class, id));
        assertEquals("检查钢筋绑扎", call(author, get("/supervision-diaries/" + id), 200).path("construction").asText());
        call(reviewer, body(post("/supervision-diaries/" + id + "/approve").header("X-Record-Version", 0), Map.of("status", "approved")), 403);
        record = submit(record, "supervision-diaries");
        long version = record.path("lockVersion").asLong();
        call(outsider, body(post("/supervision-diaries/" + id + "/approve").header("X-Record-Version", version), Map.of("status", "approved")), 403);
        call(author, delete("/supervision-diaries/" + id).header("X-Record-Version", version), 409);
        assertEquals("submitted", db.queryForObject("select status from biz_supervision_diary where id=?", String.class, id));
    }

    @Test void qaAcceptanceExplicitCorsPolicy() throws Exception {
        mvc.perform(options("/messages").header("Origin", "https://qa22.example.invalid")
                .header("Access-Control-Request-Method", "GET").header("Access-Control-Request-Headers", "Authorization"))
                .andExpect(status().isOk()).andExpect(header().string("Access-Control-Allow-Origin", "https://qa22.example.invalid"));
        mvc.perform(options("/messages").header("Origin", "https://untrusted.example.invalid")
                .header("Access-Control-Request-Method", "GET"))
                .andExpect(status().isForbidden()).andExpect(header().doesNotExist("Access-Control-Allow-Origin"));
        mvc.perform(get("/messages").header("Origin", "https://qa22.example.invalid"))
                .andExpect(status().isUnauthorized());
        mvc.perform(get("/messages").header("Origin", "https://untrusted.example.invalid").header("Authorization", token(author)))
                .andExpect(status().isForbidden());
    }

    @Test void qaAcceptanceExpiredAndTamperedJwt() throws Exception {
        var expired = new JwtUtil(revocations);
        org.springframework.test.util.ReflectionTestUtils.setField(expired, "key", org.springframework.test.util.ReflectionTestUtils.getField(jwt, "key"));
        org.springframework.test.util.ReflectionTestUtils.setField(expired, "expiration", -60000L);
        mvc.perform(get("/messages").header("Authorization", "Bearer " + expired.generateToken(author, "隔离测试", List.of())))
                .andExpect(status().isUnauthorized());
        String valid = token(author);
        int signature = valid.lastIndexOf('.') + 1;
        String tampered = valid.substring(0, signature) + (valid.charAt(signature) == 'A' ? 'B' : 'A') + valid.substring(signature + 1);
        mvc.perform(get("/messages").header("Authorization", tampered)).andExpect(status().isUnauthorized());
        call(author, get("/messages"), 200);
    }

    @Test void qaAcceptanceUploadExtensionAndEmptyGuards() throws Exception {
        for (String name : List.of("probe.exe", "probe.html", "probe.svg", "photo.jpg.exe", "noextension", "a..jpg")) {
            mvc.perform(multipart("/files/upload").file(new MockMultipartFile("file", name, "image/jpeg", new byte[]{1}))
                    .header("Authorization", token(author))).andExpect(status().isBadRequest());
        }
        mvc.perform(multipart("/files/upload").file(new MockMultipartFile("file", "empty.jpg", "image/jpeg", new byte[0]))
                .header("Authorization", token(author))).andExpect(status().isBadRequest());
        mvc.perform(multipart("/files/upload").file(new MockMultipartFile("file", "probe.jpg", "image/jpeg", new byte[]{1})))
                .andExpect(status().isUnauthorized());
    }

    @Test void qaAcceptanceDirectoryRejectsOtherProject() throws Exception {
        long id = sequence.incrementAndGet();
        db.update("insert into biz_sub_item_database(id,project_id,name,status) values (?,?,'QA验收目录','active')", id, project);
        call(author, get("/sub-item-databases/" + id), 200);
        call(outsider, get("/sub-item-databases/" + id), 403);
    }

    String acceptanceAdminToken() {
        var roles = db.queryForList("select id from sys_role where code='admin'", Long.class);
        long role = roles.isEmpty() ? sequence.incrementAndGet() : roles.get(0);
        if (roles.isEmpty()) db.update("insert into sys_role(id,name,code,status) values (?,'验收管理员','admin','active')", role);
        db.update("insert into sys_user_role(user_id,role_id) values (?,?)", reviewer, role);
        return "Bearer " + jwt.generateToken(reviewer, "隔离管理员", List.of("admin"));
    }

    @Test void qaAcceptanceDisabledAdminCannotReactivateSelf() throws Exception {
        String oldToken = acceptanceAdminToken();
        db.update("update sys_user set status='inactive' where id=?", reviewer);
        int actual = mvc.perform(put("/users/" + reviewer + "/status").param("status", "active").header("Authorization", oldToken))
                .andReturn().getResponse().getStatus();
        assertAll(() -> assertEquals(401, actual, "停用账号不得使用旧令牌重新启用自己"),
                () -> assertEquals("inactive", db.queryForObject("select status from sys_user where id=?", String.class, reviewer)));
    }

    @Test void qaAcceptanceRevokedAdminCannotManageUsers() throws Exception {
        String oldToken = acceptanceAdminToken();
        db.update("delete from sys_user_role where user_id=?", reviewer);
        int actual = mvc.perform(put("/users/" + outsider + "/status").param("status", "inactive").header("Authorization", oldToken))
                .andReturn().getResponse().getStatus();
        assertAll(() -> assertEquals(403, actual, "撤权后的旧角色不得管理账号"),
                () -> assertEquals("active", db.queryForObject("select status from sys_user where id=?", String.class, outsider)));
    }

    Map<String, Object> acceptanceLegacyBody(String dateField) {
        return new LinkedHashMap<>(Map.of("code", "QA26-" + UUID.randomUUID(), "projectId", project,
                dateField, "2026-09-23", "title", "验收隔离记录", "content", "验收原始正文"));
    }

    @Test void qaAcceptanceSafetySubmissionPersists() throws Exception {
        var input = acceptanceLegacyBody("logDate");
        long id = call(author, body(post("/safety-logs"), input), 200).path("id").asLong();
        input.put("status", "submitted");
        call(author, body(put("/safety-logs/" + id), input), 200);
        assertEquals("submitted", call(author, get("/safety-logs/" + id), 200).path("status").asText());
    }

    @Test void qaAcceptanceSafetyDraftCannotBeApproved() throws Exception {
        String admin = acceptanceAdminToken();
        long id = call(author, body(post("/safety-logs"), acceptanceLegacyBody("logDate")), 200).path("id").asLong();
        mvc.perform(body(post("/safety-logs/" + id + "/approve"), Map.of("status", "approved")).header("Authorization", admin))
                .andExpect(status().isConflict());
    }

    @Test void qaAcceptanceSafetySubmittedManagerCanReview() throws Exception {
        long id = call(author, body(post("/safety-logs"), acceptanceLegacyBody("logDate")), 200).path("id").asLong();
        // 仅为隔离审批权限测试准备前置状态，不能算作提交闭环通过。
        db.update("update biz_safety_log set status='submitted' where id=?", id);
        call(reviewer, body(post("/safety-logs/" + id + "/approve"), Map.of("status", "approved")), 200);
    }

    @Test void qaAcceptanceSafetyApprovedBodyIsImmutable() throws Exception {
        var input = acceptanceLegacyBody("logDate");
        long id = call(author, body(post("/safety-logs"), input), 200).path("id").asLong();
        db.update("update biz_safety_log set status='approved' where id=?", id);
        input.put("content", "不应覆盖已批准正文");
        call(author, body(put("/safety-logs/" + id), input), 409);
    }

    @Test void qaAcceptanceNoticesAndContactsCannotSkipWorkflow() throws Exception {
        assertAll(Map.of("supervision-notices", "noticeDate", "work-contacts", "contactDate").entrySet().stream().map(entry ->
                (org.junit.jupiter.api.function.Executable) () -> {
                    var input = acceptanceLegacyBody(entry.getValue());
                    input.put("status", "verified");
                    int actual = mvc.perform(body(post("/" + entry.getKey()), input).header("Authorization", token(author)))
                            .andReturn().getResponse().getStatus();
                    assertTrue(actual == 400 || actual == 409, entry.getKey() + "创建即verified必须拒绝，实际HTTP=" + actual);
                }));
    }

    @Test void noticeRelatedDiaryValidationAndDetailRoundTrip() throws Exception {
        JsonNode diary = create(author, "supervision-diaries", diary(), UUID.randomUUID().toString());
        long diaryId = diary.path("id").asLong();
        var notice = new LinkedHashMap<String, Object>();
        notice.put("code", "NOTICE-DIARY-" + project);
        notice.put("projectId", project);
        notice.put("noticeDate", "2026-09-24");
        notice.put("title", "关联监理日记的通知单");
        notice.put("content", "请按日记记录的现场问题完成整改");
        notice.put("relatedDiaryId", diaryId);
        call(author, body(post("/supervision-notices"), notice), 400);

        diary = approve(submit(diary, "supervision-diaries"), "supervision-diaries", "approved");
        JsonNode created = call(author, body(post("/supervision-notices"), notice), 200);
        long noticeId = created.path("id").asLong();
        assertEquals(diaryId, created.path("relatedDiaryId").asLong());
        JsonNode detail = call(author, get("/supervision-notices/" + noticeId), 200);
        assertEquals(diaryId, detail.path("relatedDiary").path("id").asLong());
        assertEquals(diary.path("code").asText(), detail.path("relatedDiary").path("code").asText());
        assertEquals("2026-09-23", detail.path("relatedDiary").path("diaryDate").asText());
        assertEquals("测试人员" + author, detail.path("relatedDiary").path("authorName").asText());
        assertEquals("检查钢筋绑扎", detail.path("relatedDiary").path("construction").asText());

        notice.remove("relatedDiaryId");
        JsonNode cleared = call(author, body(put("/supervision-notices/" + noticeId), notice), 200);
        assertFalse(cleared.hasNonNull("relatedDiaryId"));

        var crossProject = new LinkedHashMap<String, Object>(notice);
        crossProject.put("code", "NOTICE-DIARY-OTHER-" + project);
        crossProject.put("projectId", otherProject);
        crossProject.put("relatedDiaryId", diaryId);
        call(outsider, body(post("/supervision-notices"), crossProject), 400);
        notice.put("code", "NOTICE-DIARY-MISSING-" + project);
        notice.put("relatedDiaryId", 99999999L);
        call(author, body(post("/supervision-notices"), notice), 400);
    }

    @Test void noticeDocumentDirectoryValidationAndRoundTrip() throws Exception {
        long root = sequence.incrementAndGet();
        long leaf = sequence.incrementAndGet();
        long inactive = sequence.incrementAndGet();
        long other = sequence.incrementAndGet();
        db.update("insert into biz_sub_item_database(id,project_id,name,status) values (?,?,'单位工程','active')", root, project);
        db.update("insert into biz_sub_item_database(id,project_id,parent_id,name,status) values (?,?,?,'分项工程','active')", leaf, project, root);
        db.update("insert into biz_sub_item_database(id,project_id,name,status) values (?,?,'已禁用目录','inactive')", inactive, project);
        db.update("insert into biz_sub_item_database(id,project_id,name,status) values (?,?,'其他项目目录','active')", other, otherProject);

        JsonNode tree = call(author, get("/sub-item-databases/tree").param("projectId", String.valueOf(project)), 200);
        assertTrue(tree.size() > 0);
        assertEquals(leaf, tree.get(0).path("children").get(0).path("id").asLong());
        assertFalse(tree.toString().contains("其他项目目录"));

        var notice = new LinkedHashMap<String, Object>();
        notice.put("code", "NOTICE-DIRECTORY-" + project);
        notice.put("projectId", project);
        notice.put("noticeDate", "2026-11-03");
        notice.put("title", "绑定工程资料目录的通知单");
        notice.put("content", "请按目录归档整改资料");
        notice.put("documentDirectoryIds", List.of(leaf));
        JsonNode created = call(author, body(post("/supervision-notices"), notice), 200);
        long noticeId = created.path("id").asLong();
        assertEquals(leaf, created.path("documentDirectoryIds").get(0).asLong());
        assertEquals("[" + leaf + "]", db.queryForObject(
                "select document_directory_ids from biz_supervision_notice where id=?", String.class, noticeId));

        JsonNode detail = call(author, get("/supervision-notices/" + noticeId), 200);
        assertEquals("单位工程 / 分项工程", detail.path("documentDirectories").get(0).path("path").asText());
        notice.put("status", "issued");
        JsonNode issued = call(author, body(put("/supervision-notices/" + noticeId), notice), 200);
        assertEquals(leaf, issued.path("documentDirectoryIds").get(0).asLong());

        for (long invalid : List.of(inactive, other, root, 99999999L)) {
            var bad = new LinkedHashMap<String, Object>(notice);
            bad.put("code", "NOTICE-DIRECTORY-BAD-" + invalid + "-" + project);
            bad.put("status", "draft");
            bad.put("documentDirectoryIds", List.of(invalid));
            call(author, body(post("/supervision-notices"), bad), 400);
        }
    }

    @Test void independentTokensAndLogoutRevocation() throws Exception {
        String first = token(author), second = token(author), other = token(outsider);
        assertNotEquals(first, second, "同一账号同时登录也必须签发不同的会话标识");
        mvc.perform(post("/auth/logout").header("Authorization", first)).andExpect(status().isOk());
        mvc.perform(get("/auth/info").header("Authorization", first)).andExpect(status().isUnauthorized());
        mvc.perform(get("/auth/info").header("Authorization", second)).andExpect(status().isOk())
                .andExpect(jsonPath("$.data.userId").value(author));
        mvc.perform(get("/auth/info").header("Authorization", other)).andExpect(status().isOk())
                .andExpect(jsonPath("$.data.userId").value(outsider));
        mvc.perform(get("/roles").header("Authorization", other)).andExpect(status().isForbidden());
        mvc.perform(get("/auth/info")).andExpect(status().isUnauthorized());
        assertNull(AuthContext.get(), "线程复用不得残留身份");
    }

    @Test void demoRestartRejectsOldTokens() {
        String oldToken = jwt.generateToken(author, "测试", List.of());
        JwtUtil restarted = new JwtUtil(revocations);
        org.springframework.test.util.ReflectionTestUtils.setField(restarted, "secret", environment.getProperty("app.jwt.secret"));
        org.springframework.test.util.ReflectionTestUtils.setField(restarted, "expiration", 86400000L);
        org.springframework.test.util.ReflectionTestUtils.setField(restarted, "invalidateOnRestart", true);
        restarted.init();
        assertFalse(restarted.isValid(oldToken), "H2 重置后旧用户 ID 的令牌不可复用");
        assertTrue(restarted.isValid(restarted.generateToken(author, "测试", List.of())));
    }

    @Test void startupRepairsEveryAdminBindingWithoutChangingOtherRoles() {
        long role = sequence.incrementAndGet();
        db.update("insert into sys_role(id,name,code,status) values (?,'普通角色',?,'active')", role, "normal" + role);
        long permission = db.queryForObject("select min(id) from sys_permission", Long.class);
        db.update("insert into sys_role_permission(role_id,permission_id) values (?,?)", role, permission);
        long adminRole = db.queryForObject("select min(id) from sys_role where code='admin'", Long.class);
        db.update("delete from sys_role_permission where role_id=?", adminRole);
        adminInitializer.run(null);
        adminInitializer.run(null);
        assertEquals(db.queryForObject("select count(*) from sys_permission", Long.class),
                db.queryForObject("select count(*) from sys_role_permission where role_id=?", Long.class, adminRole));
        assertEquals(List.of(permission), db.queryForList("select permission_id from sys_role_permission where role_id=?", Long.class, role));
    }

    @Test void adminRoleAlwaysHoldsEveryPermission() throws Exception {
        String admin = acceptanceAdminToken();
        String bound = "select count(distinct rp.permission_id) from sys_role_permission rp join sys_role r on r.id=rp.role_id where r.code='admin'";
        long total = db.queryForObject("select count(*) from sys_permission", Long.class);
        // 启动自检 AdminPermissionInitializer 在任何 profile 下都补齐菜单/页面权限并全部绑定 admin
        assertTrue(total >= 31, "启动自检应补齐 31 个菜单/页面权限，实际=" + total);
        assertEquals(total, db.queryForObject(bound, Long.class));
        mvc.perform(body(post("/permissions"), Map.of("name", "QA新增权限", "code", "qa:perm:" + UUID.randomUUID(), "module", "qa"))
                .header("Authorization", admin)).andExpect(status().isOk());
        assertEquals(total + 1, db.queryForObject(bound, Long.class));
        // 权限设置页取消勾选保存、删除角色均不能削弱 admin
        long roleId = db.queryForList("select id from sys_role where code='admin' order by id", Long.class).get(0);
        mvc.perform(body(post("/roles/" + roleId + "/permissions"), List.of()).header("Authorization", admin)).andExpect(status().isOk());
        assertEquals(total + 1, db.queryForObject("select count(distinct permission_id) from sys_role_permission where role_id=?", Long.class, roleId));
        mvc.perform(delete("/roles/" + roleId).header("Authorization", admin)).andExpect(status().isBadRequest());
        assertEquals("active", db.queryForObject("select status from sys_role where id=?", String.class, roleId));
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"supervision-diaries", "supervision-logs", "daily-inspections", "sideline-inspections"})
    void builtInAdminCanConfirmOwnSubmittedRecordWithoutSkippingWorkflow(String kind) throws Exception {
        photo = upload(1);
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("projectId", project);
        input.put("photos", "[\"" + photo + "\"]");
        if (kind.equals("supervision-diaries")) input.putAll(diary());
        else {
            input.put(kind.equals("supervision-logs") ? "logDate" : "inspectionDate", "2026-10-22");
            input.put("location", "一层现场");
            input.put("content", "管理员实际检查内容");
        }
        if (kind.equals("sideline-inspections")) {
            input.put("startTime", "2026-10-22T08:00:00");
            input.put("endTime", "2026-10-22T09:00:00");
            input.put("content", json.writeValueAsString(Map.of("process", "浇筑", "result", "合格", "manageCount", 1, "workerCount", 2, "docs", List.of("图纸A"))));
        }
        JsonNode record = create(1, kind, input, UUID.randomUUID().toString());
        String path = "/" + kind + "/" + record.path("id").asLong();
        boolean memo = "daily-inspections".equals(kind);
        assertEquals("draft", record.path("status").asText());
        // 巡检无需审核：草稿不能确认，提交也不进入待审核；其他三类保持原审核流程
        call(1, body(post(path + "/approve").header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("status", "approved")), memo ? 400 : 409);
        record = call(1, post(path + "/submit").header("X-Record-Version", record.path("lockVersion").asLong()), 200);
        assertEquals(memo ? "recorded" : "submitted", record.path("status").asText());
        assertEquals(memo ? "recorded" : "submitted", call(1, get(path), 200).path("status").asText());
        if (memo) {
            call(1, body(post(path + "/approve").header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("status", "approved")), 400);
            call(author, body(post(path + "/approve").header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("status", "approved")), 400);
            assertTrue(call(1, get(path + "/history"), 200).toString().contains("submit"));
            return;
        }
        call(author, body(post(path + "/approve").header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("status", "approved")), 403);
        record = call(1, body(post(path + "/approve").header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("status", "approved")), 200);
        assertEquals("approved", record.path("status").asText());
        call(1, body(put(path).header("X-Record-Version", record.path("lockVersion").asLong()), input), 409);
        JsonNode history = call(1, get(path + "/history"), 200);
        assertTrue(java.util.stream.StreamSupport.stream(history.spliterator(), false)
                .anyMatch(event -> event.path("actorId").asLong() == 1 && event.path("action").asText().equals("approved")));
    }

    @Test void builtInAdminSafetyApprovalStillRequiresExplicitConfirmation() throws Exception {
        var input = acceptanceLegacyBody("logDate");
        JsonNode record = call(1, body(post("/safety-logs"), input), 200);
        String path = "/safety-logs/" + record.path("id").asLong();
        assertEquals("draft", record.path("status").asText());
        call(1, body(post(path + "/approve"), Map.of("status", "approved")), 409);
        input.put("status", "submitted");
        assertEquals("submitted", call(1, body(put(path), input), 200).path("status").asText());
        call(author, body(post(path + "/approve"), Map.of("status", "approved")), 403);
        assertEquals("approved", call(1, body(post(path + "/approve"), Map.of("status", "approved")), 200).path("status").asText());
        call(1, body(put(path), input), 409);
    }

    @Test void concurrentCreateUsesDatabaseUniqueKey() throws Exception {
        var input = diary(); String requestId = UUID.randomUUID().toString();
        var pool = Executors.newFixedThreadPool(2); var start = new CountDownLatch(1);
        Callable<Long> create = () -> {
            AuthContext.set(new AuthContext.CurrentUser(author, "测试", List.of()));
            try { start.await(); FieldRecord r = service.create(FieldRecordKind.DIARY, input, requestId); return r.getId(); }
            finally { AuthContext.clear(); }
        };
        try {
            Future<Long> first = pool.submit(create), second = pool.submit(create); start.countDown();
            assertEquals(first.get(20, TimeUnit.SECONDS), second.get(20, TimeUnit.SECONDS));
        } finally { pool.shutdownNow(); }
    }
}
