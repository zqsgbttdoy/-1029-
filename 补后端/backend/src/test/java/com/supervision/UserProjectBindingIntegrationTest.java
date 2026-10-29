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
    @DisplayName("普通用户读项目绑定接口 -> 403")
    void testBindingsReadableOnlyByAdmin() throws Exception {
        call(normalToken, get("/users/project-map"), 403);
        call(normalToken, get("/users/" + NORMAL_USER_ID + "/projects"), 403);
    }
}
