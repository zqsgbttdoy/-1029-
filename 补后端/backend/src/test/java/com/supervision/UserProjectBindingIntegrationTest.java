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

import java.util.*;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 人员管理“一人多项目”集成验证（独立 H2 库 userprojecttests）：
 * 1. POST/PUT /users 携带 projectIds 时按“整体替换”落 biz_project_member，projectId 回写为首个；
 * 2. GET /users/{id}/projects 与 GET /users/project-map 回显含显式成员 + 旧字段回退；
 * 3. 已授权项目的 canReview 在多项目保存后保留，新增项目默认无审核权；
 * 4. 非法项目 ID 整事务回滚（人员基本资料不被修改）；
 * 5. 项目绑定读接口仅 admin 可访问。
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:userprojecttests;MODE=MySQL;DB_CLOSE_DELAY=-1",
        "app.upload.dir=target/user-project-test-uploads"})
@ActiveProfiles("e2e")
@AutoConfigureMockMvc(print = org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@DisplayName("人员多项目绑定集成测试")
class UserProjectBindingIntegrationTest {

    private static final long NORMAL_USER_ID = 9201L;
    private static final String NORMAL_PASSWORD = "QaPassw0rd!";
    private static final AtomicLong SEQ = new AtomicLong(1000);

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate db;
    @Autowired JwtUtil jwt;
    @Autowired BCryptPasswordEncoder passwordEncoder;

    String adminToken;
    String normalToken;

    @BeforeAll
    void seed() throws Exception {
        db.update("insert into sys_user(id,name,phone,status,password) values (?,?,?,?,?)",
                NORMAL_USER_ID, "qa_multi_project", "13900009201", "active", passwordEncoder.encode(NORMAL_PASSWORD));
        adminToken = login("admin", "123456");
        normalToken = login("qa_multi_project", NORMAL_PASSWORD);
    }

    @AfterEach
    void clearContext() {
        com.supervision.common.AuthContext.clear();
    }

    // ---------------- 辅助方法 ----------------

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
        MockHttpServletRequestBuilder prepared = token == null ? request : request.header("Authorization", "Bearer " + token);
        MvcResult result = mvc.perform(prepared).andExpect(status().is(expectStatus)).andReturn();
        return data(result);
    }

    JsonNode postJson(String token, String path, Object body, int expectStatus) throws Exception {
        return call(token, post(path).contentType(APPLICATION_JSON).content(json.writeValueAsString(body)), expectStatus);
    }

    JsonNode putJson(String token, String path, Object body, int expectStatus) throws Exception {
        return call(token, put(path).contentType(APPLICATION_JSON).content(json.writeValueAsString(body)), expectStatus);
    }

    List<Long> ids(JsonNode array) {
        List<Long> result = new ArrayList<>();
        array.forEach(n -> result.add(n.asLong()));
        Collections.sort(result);
        return result;
    }

    long createProject(String name) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("code", name + "-" + SEQ.incrementAndGet());
        body.put("buildUnit", "QA 建设单位");
        return postJson(adminToken, "/projects", body, 200).path("id").asLong();
    }

    Map<String, Object> userBody(String name, String phone, List<Long> projectIds) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("phone", phone);
        if (projectIds != null) body.put("projectIds", projectIds);
        return body;
    }

    /** biz_project_member 当前用户启用中的项目集合（测试侧独立口径，验证落库事实） */
    List<Long> memberRows(long userId) {
        List<Long> rows = db.queryForList("select project_id from biz_project_member where user_id=" + userId
                + " and enabled=true", Long.class);
        Collections.sort(rows);
        return rows;
    }

    // ---------------- 用例 ----------------

    @Test
    @DisplayName("新建人员传 3 个项目：关系表 3 行、projectId 取首个、回显接口与映射接口一致")
    void testCreateWithThreeProjects() throws Exception {
        long p1 = createProject("QA多项目A");
        long p2 = createProject("QA多项目B");
        long p3 = createProject("QA多项目C");

        JsonNode created = postJson(adminToken, "/users", userBody("qa_多项目1", "13910009201", List.of(p1, p2, p3)), 200);
        long userId = created.path("id").asLong();
        assertEquals(p1, created.path("projectId").asLong(), "主归属旧字段应写入首个项目");

        assertEquals(List.of(p1, p2, p3), ids(call(adminToken, get("/users/" + userId + "/projects"), 200)), "回显应为全部 3 个项目");
        assertEquals(List.of(p1, p2, p3), ids(call(adminToken, get("/users/project-map"), 200).path(String.valueOf(userId))), "映射接口应包含同一集合");
        assertEquals(List.of(p1, p2, p3), memberRows(userId), "关系表应恰好落 3 行启用成员");
    }

    @Test
    @DisplayName("编辑收缩为 1 个项目：未勾选的关系行删除，回显与 projectId 同步更新")
    void testUpdateShrinksBindings() throws Exception {
        long p1 = createProject("QA收缩A");
        long p2 = createProject("QA收缩B");
        long p3 = createProject("QA收缩C");
        JsonNode created = postJson(adminToken, "/users", userBody("qa_多项目2", "13910009202", List.of(p1, p2, p3)), 200);
        long userId = created.path("id").asLong();

        JsonNode updated = putJson(adminToken, "/users/" + userId,
                userBody("qa_多项目2改名", "13910009202", List.of(p2)), 200);
        assertEquals(p2, updated.path("projectId").asLong());
        assertEquals(List.of(p2), ids(call(adminToken, get("/users/" + userId + "/projects"), 200)));
        assertEquals(List.of(p2), memberRows(userId), "取消勾选的项目关系行必须被删除");
    }

    @Test
    @DisplayName("多项目保存保留既有 canReview，新增项目默认无审核权")
    void testCanReviewPreservedOnResave() throws Exception {
        long p1 = createProject("QA审核A");
        long p2 = createProject("QA审核B");
        JsonNode created = postJson(adminToken, "/users", userBody("qa_多项目3", "13910009203", List.of(p1)), 200);
        long userId = created.path("id").asLong();

        // 项目成员面板显式授予 p1 审核权
        putJson(adminToken, "/projects/" + p1 + "/members",
                Map.of("userId", userId, "enabled", true, "canReview", true), 200);

        putJson(adminToken, "/users/" + userId, userBody("qa_多项目3", "13910009203", List.of(p1, p2)), 200);

        Boolean reviewP1 = db.queryForObject("select can_review from biz_project_member where user_id=? and project_id=?",
                Boolean.class, userId, p1);
        Boolean reviewP2 = db.queryForObject("select can_review from biz_project_member where user_id=? and project_id=?",
                Boolean.class, userId, p2);
        assertTrue(reviewP1, "重存不得吞掉已授予的审核权");
        assertFalse(reviewP2, "人员页新增绑定默认仅成员、无审核权");
    }

    @Test
    @DisplayName("非法项目 ID 整事务回滚：人员基本资料不被修改，绑定保持原状")
    void testInvalidProjectIdRollsBackWholeTransaction() throws Exception {
        long p1 = createProject("QA回滚A");
        JsonNode created = postJson(adminToken, "/users", userBody("qa_多项目4", "13910009204", List.of(p1)), 200);
        long userId = created.path("id").asLong();

        putJson(adminToken, "/users/" + userId, userBody("qa_改名应回滚", "13910009204", List.of(9999999L)), 400);

        JsonNode user = call(adminToken, get("/users/" + userId), 200);
        assertEquals("qa_多项目4", user.path("name").asText(), "同事务内的姓名修改必须一并回滚");
        assertEquals(List.of(p1), memberRows(userId), "非法请求不得动关系表");
    }

    @Test
    @DisplayName("旧口径兼容：不传 projectIds 仅传 projectId 时按旧字段回显，且不动显式绑定")
    void testLegacySingleProjectStillWorks() throws Exception {
        long p1 = createProject("QA旧口径A");
        Map<String, Object> body = userBody("qa_旧口径", "13910009205", null);
        body.put("projectId", p1);
        JsonNode created = postJson(adminToken, "/users", body, 200);
        long userId = created.path("id").asLong();

        assertEquals(List.of(p1), ids(call(adminToken, get("/users/" + userId + "/projects"), 200)), "无成员行时应回退旧单字段");
        assertEquals(0, db.queryForObject("select count(*) from biz_project_member where user_id=?", Integer.class, userId),
                "未传 projectIds 不得生成显式成员行");
    }

    @Test
    @DisplayName("项目台账通用 PUT 保存状态后：响应、数据库、详情和状态筛选一致")
    void testProjectStatusUpdateRoundTrip() throws Exception {
        long id = createProject("QA项目状态回显");
        JsonNode original = call(adminToken, get("/projects/" + id), 200);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", original.path("name").asText());
        body.put("code", original.path("code").asText());
        body.put("buildUnit", original.path("buildUnit").asText());
        String previous = "active";
        for (String next : List.of("paused", "completed", "planning", "active")) {
            body.put("status", next);
            if ("completed".equals(next)) body.put("name", "QA项目状态与名称同时修改");
            JsonNode saved = putJson(adminToken, "/projects/" + id, body, 200);
            assertEquals(next, saved.path("status").asText(), "成功响应必须反映本次选择的状态");
            // 测试不套外层事务：独立 JDBC 读取验证提交结果，不依赖实体一级缓存。
            assertEquals(next, db.queryForObject("select status from biz_project where id=?", String.class, id));
            JsonNode detail = call(adminToken, get("/projects/" + id), 200);
            assertEquals(next, detail.path("status").asText());
            assertEquals(body.get("name"), detail.path("name").asText());
            JsonNode list = call(adminToken, get("/projects").param("code", body.get("code").toString()), 200);
            assertEquals(1, list.path("total").asInt());
            assertEquals(next, list.path("list").get(0).path("status").asText());
            JsonNode filtered = call(adminToken, get("/projects").param("code", body.get("code").toString()).param("status", next), 200);
            assertEquals(id, filtered.path("list").get(0).path("id").asLong());
            JsonNode oldFilter = call(adminToken, get("/projects").param("code", body.get("code").toString()).param("status", previous), 200);
            assertEquals(0, oldFilter.path("total").asInt(), "不再属于旧状态筛选结果");
            previous = next;
        }
    }

    @Test
    @DisplayName("旧客户端省略或传 null 状态时保留原状态，重复保存不回退")
    void testProjectStatusOmittedPreserved() throws Exception {
        long id = createProject("QA项目状态兼容");
        call(adminToken, put("/projects/" + id + "/status").param("status", "paused"), 200);
        JsonNode original = call(adminToken, get("/projects/" + id), 200);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "QA只修改项目名称");
        body.put("code", original.path("code").asText());
        body.put("buildUnit", original.path("buildUnit").asText());
        assertEquals("paused", putJson(adminToken, "/projects/" + id, body, 200).path("status").asText());
        body.put("status", null);
        assertEquals("paused", putJson(adminToken, "/projects/" + id, body, 200).path("status").asText());
        body.put("status", "paused");
        assertEquals("paused", putJson(adminToken, "/projects/" + id, body, 200).path("status").asText());
        assertEquals("paused", db.queryForObject("select status from biz_project where id=?", String.class, id));
        assertEquals(body.get("name"), call(adminToken, get("/projects/" + id), 200).path("name").asText());
    }

    @Test
    @DisplayName("项目非法状态明确返回400且不能部分修改名称或绕过删除入口")
    void testProjectInvalidStatusRejected() throws Exception {
        long id = createProject("QA非法项目状态");
        JsonNode original = call(adminToken, get("/projects/" + id), 200);
        for (String invalid : List.of("", " ", "unknown", "inactive", "已暂停")) {
            putJson(adminToken, "/projects/" + id, Map.of("name", "不应保存的新名称",
                    "code", original.path("code").asText(), "buildUnit", "不应保存的新单位", "status", invalid), 400);
            assertEquals("active", db.queryForObject("select status from biz_project where id=?", String.class, id));
            JsonNode after = call(adminToken, get("/projects/" + id), 200);
            assertEquals(original.path("name"), after.path("name"));
            assertEquals(original.path("buildUnit"), after.path("buildUnit"));
        }
    }

    @Test
    @DisplayName("项目状态更新权限及数据库提交失败不得伪报成功或部分写入")
    void testProjectStatusUpdateFailureIsAtomic() throws Exception {
        long id = createProject("QA项目状态失败保护");
        JsonNode original = call(adminToken, get("/projects/" + id), 200);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "不应保存的新名称");
        body.put("code", original.path("code").asText());
        body.put("buildUnit", "QA建设单位");
        body.put("status", "paused");
        putJson(normalToken, "/projects/" + id, body, 403);
        putJson(null, "/projects/" + id, body, 401);
        // 越过 DTO 未限制的地址长度，触发真正的数据库写入失败。
        body.put("address", "x".repeat(501));
        putJson(adminToken, "/projects/" + id, body, 400);
        assertEquals("active", db.queryForObject("select status from biz_project where id=?", String.class, id));
        assertEquals(original.path("name"), call(adminToken, get("/projects/" + id), 200).path("name"));
    }

    @Test
    @DisplayName("同一项目表单新建时采用所选状态，未提供则兼容默认为进行中")
    void testProjectCreateSelectedStatus() throws Exception {
        for (String selected : List.of("planning", "paused", "completed", "active")) {
            JsonNode created = postJson(adminToken, "/projects", Map.of("name", "QA新建状态" + selected,
                    "code", "QA-CREATE-STATUS-" + SEQ.incrementAndGet(), "buildUnit", "QA建设单位", "status", selected), 200);
            assertEquals(selected, created.path("status").asText());
            assertEquals(selected, db.queryForObject("select status from biz_project where id=?", String.class, created.path("id").asLong()));
        }
        long id = createProject("QA旧客户端新建状态");
        assertEquals("active", call(adminToken, get("/projects/" + id), 200).path("status").asText());
        String code = "QA-CREATE-INVALID-" + SEQ.incrementAndGet();
        postJson(adminToken, "/projects", Map.of("name", "QA无效新建", "code", code,
                "buildUnit", "QA建设单位", "status", "inactive"), 400);
        assertEquals(0, db.queryForObject("select count(*) from biz_project where code=?", Integer.class, code));
    }

    @Test
    @DisplayName("普通用户读项目绑定接口 -> 403")
    void testBindingsReadableOnlyByAdmin() throws Exception {
        call(normalToken, get("/users/project-map"), 403);
        call(normalToken, get("/users/" + NORMAL_USER_ID + "/projects"), 403);
    }
}
