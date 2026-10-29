package com.supervision;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.supervision.util.JwtUtil;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 权限、角色绑定、部门与登录/JWT 的独立 MVC + H2 集成验证。
 * 使用独立内存库 permissiontests，不与现场记录测试共享数据；不连接外部 MySQL/旧 HTTP 服务。
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:permissiontests;MODE=MySQL;DB_CLOSE_DELAY=-1",
        "app.upload.dir=target/permission-test-uploads"})
@ActiveProfiles("e2e")
@AutoConfigureMockMvc(print = org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@DisplayName("权限体系与认证集成测试")
class PermissionAuthorizationIntegrationTest {

    private static final long NORMAL_USER_ID = 9001L;
    private static final long NORMAL_ROLE_ID = 9001L;
    private static final String NORMAL_PASSWORD = "QaPassw0rd!";
    private static final AtomicLong SEQ = new AtomicLong(1000);

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate db;
    @Autowired JwtUtil jwt;
    @Autowired BCryptPasswordEncoder passwordEncoder;
    @Value("${app.jwt.secret}") String jwtSecret;

    String adminToken;
    String normalToken;

    @BeforeAll
    void seed() throws Exception {
        String encoded = passwordEncoder.encode(NORMAL_PASSWORD);
        db.update("insert into sys_role(id,name,code,description,status) values (?,?,?,?,?)",
                NORMAL_ROLE_ID, "QA只读角色", "qa_viewer", "集成测试普通角色", "active");
        db.update("insert into sys_user(id,name,phone,status,password) values (?,?,?,?,?)",
                NORMAL_USER_ID, "qa_normal", "13900009001", "active", encoded);
        db.update("insert into sys_user_role(id,user_id,role_id) values (?,?,?)",
                9001L, NORMAL_USER_ID, NORMAL_ROLE_ID);
        // e2e 由 Hibernate 建表，不包含 schema.sql 的业务唯一索引；显式补上生产等价的编码唯一约束，
        // 以便验证更新编码时的数据库兜底行为（服务层仅对新增做了预检查）。
        db.execute("create unique index if not exists uk_sys_permission_code on sys_permission(code)");
        adminToken = login("admin", "123456");
        normalToken = login("qa_normal", NORMAL_PASSWORD);
    }

    @AfterEach
    void clearTheme() {
        com.supervision.common.AuthContext.clear();
    }

    // ---------------- 辅助方法 ----------------

    String login(String username, String password) throws Exception {
        MvcResult result = mvc.perform(post("/auth/login").contentType(APPLICATION_JSON)
                        .content(json.writeValueAsString(Map.of("username", username, "password", password))))
                .andExpect(status().isOk()).andReturn();
        return data(result).path("token").asText();
    }

    JsonNode data(MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsByteArray()).path("data");
    }

    JsonNode body(MvcResult result) throws Exception {
        return json.readTree(result.getResponse().getContentAsByteArray());
    }

    MockHttpServletRequestBuilder auth(MockHttpServletRequestBuilder request, String token) {
        return request.header("Authorization", "Bearer " + token);
    }

    JsonNode call(String token, MockHttpServletRequestBuilder request, int status) throws Exception {
        MockHttpServletRequestBuilder prepared = token == null || token.isEmpty() ? request : auth(request, token);
        MvcResult result = mvc.perform(prepared).andExpect(status().is(status)).andReturn();
        return body(result);
    }

    MockHttpServletRequestBuilder jsonBody(MockHttpServletRequestBuilder request, Object value) throws Exception {
        return request.contentType(APPLICATION_JSON).content(json.writeValueAsString(value));
    }

    Map<String, Object> permissionBody(String name, String code, Long parentId, int sortOrder) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("code", code);
        body.put("module", "qa");
        body.put("description", "QA集成测试权限");
        body.put("parentId", parentId);
        body.put("sortOrder", sortOrder);
        return body;
    }

    long createPermission(String name, String code, Long parentId) throws Exception {
        JsonNode response = call(adminToken, jsonBody(post("/permissions"), permissionBody(name, code, parentId, 1)), 200);
        assertEquals(200, response.path("code").asInt());
        return response.path("data").path("id").asLong();
    }

    List<Long> rolePermissionIds(long roleId) throws Exception {
        JsonNode node = call(adminToken, get("/roles/" + roleId + "/permissions"), 200).path("data");
        List<Long> ids = new ArrayList<>();
        node.forEach(item -> ids.add(item.asLong()));
        return ids;
    }

    /** 把接口返回的角色ID数组转成 List<Long>，便于与预期绑定关系逐项比对 */
    List<Long> longList(JsonNode node) {
        List<Long> ids = new ArrayList<>();
        node.forEach(item -> ids.add(item.asLong()));
        return ids;
    }

    String expiredToken() {
        return Jwts.builder()
                .id(UUID.randomUUID().toString())
                .subject("1")
                .claim("userName", "admin")
                .issuedAt(Date.from(Instant.now().minusSeconds(7200)))
                .expiration(Date.from(Instant.now().minusSeconds(3600)))
                .signWith(Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8)))
                .compact();
    }

    // ---------------- 登录与 JWT ----------------

    @Test
    @DisplayName("管理员登录签发可用令牌，/auth/info 返回数据库当前角色")
    void adminLoginIssuesUsableToken() throws Exception {
        assertFalse(adminToken.isBlank());
        JsonNode info = call(adminToken, get("/auth/info"), 200).path("data");
        assertEquals(1L, info.path("userId").asLong());
        assertEquals("admin", info.path("userName").asText());
        assertTrue(info.path("roles").toString().contains("admin"));
    }

    @Test
    @DisplayName("错误密码与不存在账号统一拒绝，不泄露账号是否存在")
    void wrongCredentialsRejected() throws Exception {
        JsonNode wrong = call("", jsonBody(post("/auth/login"), Map.of("username", "admin", "password", "wrong-pass")), 400);
        assertEquals(400, wrong.path("code").asInt());
        assertEquals("用户名或密码错误", wrong.path("message").asText());

        JsonNode missing = call("", jsonBody(post("/auth/login"), Map.of("username", "nobody-qa", "password", "whatever")), 400);
        assertEquals("用户名或密码错误", missing.path("message").asText());
    }

    @Test
    @DisplayName("缺少令牌、签名篡改、已过期令牌均返回 401")
    void invalidTokensRejected() throws Exception {
        call("", get("/permissions"), 401);

        String[] parts = adminToken.split("\\.");
        char[] signature = parts[2].toCharArray();
        // 修改签名中段（不是末位）：末位 base64url 字符的低 4 位是填充位，改动后解码字节可能不变。
        signature[5] = signature[5] == 'A' ? 'B' : 'A';
        String tampered = parts[0] + "." + parts[1] + "." + new String(signature);
        call(tampered, get("/permissions"), 401);

        call(expiredToken(), get("/permissions"), 401);
    }

    @Test
    @DisplayName("退出只撤销当前令牌，另一独立登录会话仍有效")
    void logoutRevokesOnlyCurrentToken() throws Exception {
        String first = login("admin", "123456");
        String second = login("admin", "123456");
        call(first, get("/auth/info"), 200);

        call(first, post("/auth/logout"), 200);

        call(first, get("/auth/info"), 401);
        call(second, get("/auth/info"), 200);
    }

    @Test
    @DisplayName("停用账号的旧管理员令牌立即失效（401）")
    void disabledAdminTokenLosesAccess() throws Exception {
        db.update("insert into sys_user(id,name,phone,status,password) values (?,?,?,?,?)",
                9102L, "qa_disabled_admin", "13900009102", "active", passwordEncoder.encode(NORMAL_PASSWORD));
        db.update("insert into sys_user_role(id,user_id,role_id) values (?,?,?)", 9102L, 9102L, 1L);
        String token = login("qa_disabled_admin", NORMAL_PASSWORD);

        db.update("update sys_user set status='inactive' where id=?", 9102L);

        call(token, get("/permissions"), 401);
    }

    @Test
    @DisplayName("撤销管理员角色后旧令牌只能访问普通接口（403 而非 200）")
    void revokedAdminRoleTakesEffectImmediately() throws Exception {
        db.update("insert into sys_user(id,name,phone,status,password) values (?,?,?,?,?)",
                9103L, "qa_revoked_admin", "13900009103", "active", passwordEncoder.encode(NORMAL_PASSWORD));
        db.update("insert into sys_user_role(id,user_id,role_id) values (?,?,?)", 9103L, 9103L, 1L);
        String token = login("qa_revoked_admin", NORMAL_PASSWORD);
        call(token, get("/permissions"), 200);

        db.update("delete from sys_user_role where user_id=?", 9103L);

        call(token, get("/permissions"), 403);
        call(token, get("/users"), 200);
    }

    // ---------------- 管理接口权限控制 ----------------

    @Test
    @DisplayName("普通用户禁止访问 /roles、/permissions、/departments 及其写接口")
    void normalUserCannotAccessAdminEndpoints() throws Exception {
        call(normalToken, get("/roles"), 403);
        call(normalToken, get("/roles/" + NORMAL_ROLE_ID + "/users"), 403);
        call(normalToken, get("/permissions"), 403);
        call(normalToken, get("/permissions/tree"), 403);
        call(normalToken, get("/departments"), 403);
        call(normalToken, get("/departments/1"), 403);
        call(normalToken, jsonBody(post("/permissions"), permissionBody("越权新增", "qa:forbidden", null, 1)), 403);
        call(normalToken, jsonBody(post("/roles"), Map.of("name", "越权角色", "code", "qa_forbidden")), 403);
        call(normalToken, delete("/departments/1"), 403);
    }

    @Test
    @DisplayName("管理员可访问管理接口，普通用户可读取自身身份")
    void adminEndpointsAccessible() throws Exception {
        call(adminToken, get("/roles?pageSize=5"), 200);
        call(adminToken, get("/permissions?pageSize=5"), 200);
        call(adminToken, get("/permissions/tree"), 200);
        call(adminToken, get("/departments?pageSize=5"), 200);
        call(adminToken, get("/users?pageSize=5"), 200);

        JsonNode info = call(normalToken, get("/auth/info"), 200).path("data");
        assertTrue(info.path("roles").toString().contains("qa_viewer"));
    }

    // ---------------- 权限 CRUD 与树 ----------------

    @Test
    @DisplayName("权限新增、详情、分页过滤、更新与删除形成闭环")
    void permissionCrudClosedLoop() throws Exception {
        long rootId = createPermission("QA根权限", "qa:crud:root", null);
        long childId = createPermission("QA子权限", "qa:crud:child", rootId);

        JsonNode detail = call(adminToken, get("/permissions/" + childId), 200).path("data");
        assertEquals(rootId, detail.path("parentId").asLong());

        JsonNode filtered = call(adminToken, get("/permissions?name=QA根权限&module=qa&pageSize=100"), 200).path("data");
        assertTrue(filtered.path("total").asInt() >= 1);
        boolean containsRoot = false;
        for (JsonNode row : filtered.path("list")) {
            if (row.path("id").asLong() == rootId) containsRoot = true;
        }
        assertTrue(containsRoot);

        JsonNode updated = call(adminToken, jsonBody(put("/permissions/" + childId),
                permissionBody("QA子权限改名", "qa:crud:child", rootId, 7)), 200).path("data");
        assertEquals("QA子权限改名", updated.path("name").asText());
        assertEquals(7, updated.path("sortOrder").asInt());

        long otherId = createPermission("QA待删权限", "qa:crud:delete", null);
        call(adminToken, delete("/permissions/" + otherId), 200);
        call(adminToken, get("/permissions/" + otherId), 400);
    }

    @Test
    @DisplayName("权限树包含新建父子节点且层级正确")
    void permissionTreeContainsNewNodes() throws Exception {
        long rootId = createPermission("QA树根", "qa:tree:root", null);
        long childId = createPermission("QA树子", "qa:tree:child", rootId);

        JsonNode tree = call(adminToken, get("/permissions/tree"), 200).path("data");
        JsonNode root = null;
        for (JsonNode node : tree) {
            if (node.path("id").asLong() == rootId) root = node;
        }
        assertNotNull(root, "根节点应出现在权限树顶层");
        JsonNode child = null;
        for (JsonNode node : root.path("children")) {
            if (node.path("id").asLong() == childId) child = node;
        }
        assertNotNull(child, "子节点应挂到父节点 children 下");
        assertEquals(0, child.path("children").size());
    }

    @Test
    @DisplayName("权限编码唯一性由服务层与数据库唯一索引双重把关")
    void permissionCodeUniquenessEnforced() throws Exception {
        String code = "qa:unique:" + SEQ.incrementAndGet();
        createPermission("唯一编码", code, null);

        JsonNode duplicate = call(adminToken, jsonBody(post("/permissions"),
                permissionBody("重复编码", code, null, 1)), 400);
        assertEquals(400, duplicate.path("code").asInt());
        assertEquals("权限编码已存在", duplicate.path("message").asText());

        long first = createPermission("编码A", "qa:code:a:" + SEQ.incrementAndGet(), null);
        long second = createPermission("编码B", "qa:code:b:" + SEQ.incrementAndGet(), null);
        String secondCode = call(adminToken, get("/permissions/" + second), 200).path("data").path("code").asText();

        JsonNode conflict = call(adminToken, jsonBody(put("/permissions/" + first),
                permissionBody("编码A", secondCode, null, 1)), 400);
        assertEquals(400, conflict.path("code").asInt());
        assertEquals(secondCode, call(adminToken, get("/permissions/" + second), 200).path("data").path("code").asText());
    }

    @Test
    @DisplayName("新增权限自动授予 admin 角色，删除后绑定同步清理")
    void newPermissionAutoGrantedToAdmin() throws Exception {
        long id = createPermission("自动授权权限", "qa:auto:" + SEQ.incrementAndGet(), null);

        List<Long> adminPermissions = rolePermissionIds(1L);
        assertTrue(adminPermissions.contains(id), "新增权限应自动出现在 admin 角色权限中");

        call(adminToken, delete("/permissions/" + id), 200);

        assertFalse(rolePermissionIds(1L).contains(id), "删除权限后角色绑定应一并清理");
    }

    @Test
    @DisplayName("分页参数被钳制：pageNum<1 归 1，pageSize 超限归 200")
    void paginationClamped() throws Exception {
        JsonNode page = call(adminToken, get("/permissions?pageNum=0&pageSize=9999"), 200).path("data");
        assertEquals(1, page.path("pageNum").asInt());
        assertEquals(200, page.path("pageSize").asInt());
    }

    // ---------------- 角色-权限绑定 ----------------

    @Test
    @DisplayName("角色权限绑定支持新增、读取、替换与删除角色")
    void rolePermissionBindingLifecycle() throws Exception {
        long p1 = createPermission("绑定一", "qa:bind:1:" + SEQ.incrementAndGet(), null);
        long p2 = createPermission("绑定二", "qa:bind:2:" + SEQ.incrementAndGet(), null);

        JsonNode created = call(adminToken, jsonBody(post("/roles"), Map.of(
                "name", "QA绑定角色", "code", "qa_bind_" + SEQ.incrementAndGet(), "description", "集成测试")), 200);
        long roleId = created.path("data").path("id").asLong();

        call(adminToken, jsonBody(post("/roles/" + roleId + "/permissions"), List.of(p1, p2, p1)), 200);
        List<Long> assigned = rolePermissionIds(roleId);
        assertEquals(2, assigned.size());
        assertTrue(assigned.containsAll(List.of(p1, p2)));

        call(adminToken, jsonBody(post("/roles/" + roleId + "/permissions"), List.of(p2)), 200);
        assertEquals(List.of(p2), rolePermissionIds(roleId));

        call(adminToken, post("/roles/" + roleId + "/permissions").contentType(APPLICATION_JSON).content("[]"), 200);
        assertTrue(rolePermissionIds(roleId).isEmpty());

        call(adminToken, delete("/roles/" + roleId), 200);
        JsonNode page = call(adminToken, get("/roles?pageSize=200&status=active"), 200).path("data");
        boolean visible = false;
        for (JsonNode row : page.path("list")) {
            if (row.path("id").asLong() == roleId) visible = true;
        }
        assertFalse(visible, "软删除角色不应出现在默认/启用列表");
    }

    @Test
    @DisplayName("admin 角色忽略前端勾选，始终保存全部权限")
    void adminRoleAlwaysKeepsAllPermissions() throws Exception {
        int total = call(adminToken, get("/permissions?pageSize=200"), 200).path("data").path("total").asInt();

        call(adminToken, post("/roles/1/permissions").contentType(APPLICATION_JSON).content("[]"), 200);

        assertEquals(total, rolePermissionIds(1L).size());
    }

    @Test
    @DisplayName("内置 admin 角色不可删除")
    void adminRoleCannotBeDeleted() throws Exception {
        JsonNode response = call(adminToken, delete("/roles/1"), 400);
        assertEquals("系统管理员角色为内置角色，不可删除", response.path("message").asText());
    }

    @Test
    @DisplayName("角色列表回填成员数，成员名单接口返回绑定用户且不外泄密码")
    void roleMemberCountAndList() throws Exception {
        long userId = SEQ.incrementAndGet();
        db.update("insert into sys_user(id,name,position,phone,status) values (?,?,?,?,?)",
                userId, "qa_member", "监理员", "1390000" + (userId % 10000), "active");
        JsonNode created = call(adminToken, jsonBody(post("/roles"), Map.of(
                "name", "QA成员角色", "code", "qa_member_" + SEQ.incrementAndGet())), 200);
        long roleId = created.path("data").path("id").asLong();

        call(adminToken, jsonBody(post("/roles/" + roleId + "/users"), List.of(userId)), 200);

        JsonNode members = call(adminToken, get("/roles/" + roleId + "/users"), 200).path("data");
        assertEquals(1, members.size(), "成员名单应与绑定数量一致");
        assertEquals("qa_member", members.get(0).path("name").asText());
        assertEquals("监理员", members.get(0).path("position").asText());
        assertFalse(members.get(0).has("password"), "成员名单不得返回密码字段");

        long reported = -1;
        for (JsonNode row : call(adminToken, get("/roles?pageSize=200"), 200).path("data").path("list")) {
            if (row.path("id").asLong() == roleId) reported = row.path("userCount").asLong();
        }
        assertEquals(1, reported, "角色列表应回填该角色当前成员数");

        call(adminToken, delete("/roles/" + roleId), 200);
    }

    @Test
    @DisplayName("角色侧逐个绑定/解除成员幂等，且人员侧整体替换生效")
    void roleMemberBindUnbindAndUserSideAssign() throws Exception {
        long userId = SEQ.incrementAndGet();
        db.update("insert into sys_user(id,name,position,phone,status) values (?,?,?,?,?)",
                userId, "qa_bind_" + userId, "监理员", "1390000" + (userId % 10000), "active");
        JsonNode created = call(adminToken, jsonBody(post("/roles"), Map.of(
                "name", "QA绑定成员角色", "code", "qa_bindrole_" + SEQ.incrementAndGet())), 200);
        long roleId = created.path("data").path("id").asLong();

        // 重复绑定同一成员不得产生两条记录（前端多选/并发点击场景）
        call(adminToken, post("/roles/" + roleId + "/users/" + userId), 200);
        call(adminToken, post("/roles/" + roleId + "/users/" + userId), 200);
        assertEquals(1, call(adminToken, get("/roles/" + roleId + "/users"), 200).path("data").size());
        assertEquals(List.of(roleId), longList(call(adminToken, get("/users/" + userId + "/roles"), 200).path("data")));

        JsonNode map = call(adminToken, get("/roles/user-map"), 200).path("data");
        assertEquals(List.of(roleId), longList(map.path(String.valueOf(userId))), "人员页角色映射应包含新绑定");

        call(adminToken, delete("/roles/" + roleId + "/users/" + userId), 200);
        assertTrue(call(adminToken, get("/roles/" + roleId + "/users"), 200).path("data").isEmpty());
        // 解除未绑定的成员视为已完成，不报错
        call(adminToken, delete("/roles/" + roleId + "/users/" + userId), 200);

        // 人员侧整体替换：传入两个角色后以服务端返回为准
        JsonNode longIds = call(adminToken, jsonBody(put("/users/" + userId + "/roles"), List.of(roleId, 1L)), 200);
        List<Long> effective = longList(longIds.path("data"));
        Collections.sort(effective);
        assertEquals(2, effective.size());
        assertTrue(effective.contains(roleId) && effective.contains(1L));
        assertEquals(2, longList(call(adminToken, get("/users/" + userId + "/roles"), 200).path("data")).size());

        call(adminToken, jsonBody(put("/users/" + userId + "/roles"), List.of(roleId)), 200);
        assertEquals(List.of(roleId), longList(call(adminToken, get("/users/" + userId + "/roles"), 200).path("data")));

        call(adminToken, delete("/roles/" + roleId), 200);
        db.update("delete from sys_user_role where user_id=?", userId);
        db.update("delete from sys_user where id=?", userId);
    }

    @Test
    @DisplayName("内置 admin 账号不会被解除系统管理员角色")
    void builtInAdminKeepsAdminRole() throws Exception {
        JsonNode denied = call(adminToken, delete("/roles/1/users/1"), 400);
        assertEquals("内置管理员账号必须保留系统管理员角色", denied.path("message").asText());

        JsonNode effective = call(adminToken, jsonBody(put("/users/1/roles"), List.of()), 200).path("data");
        assertEquals(1, effective.size(), "清空内置 admin 账号角色时应自动补回系统管理员角色");
        assertEquals(1L, effective.get(0).asLong());

        // 反向验证：解除非内置账号的管理员角色应正常放行
        long userId = SEQ.incrementAndGet();
        db.update("insert into sys_user(id,name,position,phone,status) values (?,?,?,?,?)",
                userId, "qa_unbind_" + userId, "监理员", "1390000" + (userId % 10000), "active");
        call(adminToken, post("/roles/1/users/" + userId), 200);
        call(adminToken, delete("/roles/1/users/" + userId), 200);
        assertTrue(longList(call(adminToken, get("/users/" + userId + "/roles"), 200).path("data")).isEmpty());
        db.update("delete from sys_user where id=?", userId);
    }

    @Test
    @DisplayName("已软删除角色不再接受成员绑定")
    void inactiveRoleRejectsNewMember() throws Exception {
        JsonNode created = call(adminToken, jsonBody(post("/roles"), Map.of(
                "name", "QA已删角色", "code", "qa_gonerole_" + SEQ.incrementAndGet())), 200);
        long roleId = created.path("data").path("id").asLong();
        call(adminToken, delete("/roles/" + roleId), 200);

        JsonNode denied = call(adminToken, post("/roles/" + roleId + "/users/" + NORMAL_USER_ID), 400);
        assertEquals("角色已删除，请刷新后重试", denied.path("message").asText());
    }

    @Test
    @DisplayName("普通用户不得执行用户-角色绑定与解除")
    void normalUserCannotBindOrUnbind() throws Exception {
        call(normalToken, post("/roles/" + NORMAL_ROLE_ID + "/users/" + NORMAL_USER_ID), 403);
        call(normalToken, delete("/roles/" + NORMAL_ROLE_ID + "/users/" + NORMAL_USER_ID), 403);
        call(normalToken, get("/roles/user-map"), 403);
        call(normalToken, get("/users/" + NORMAL_USER_ID + "/roles"), 403);
        call(normalToken, jsonBody(put("/users/" + NORMAL_USER_ID + "/roles"), List.of(NORMAL_ROLE_ID)), 403);
    }

    @Test
    @DisplayName("删除人员同步清理角色绑定，仅改为离职则保留绑定")
    void deletedUserLeavesRoleMembership() throws Exception {
        long userId = SEQ.incrementAndGet();
        db.update("insert into sys_user(id,name,position,phone,status) values (?,?,?,?,?)",
                userId, "qa_deleted_" + userId, "监理员", "1390000" + (userId % 10000), "active");
        JsonNode created = call(adminToken, jsonBody(post("/roles"), Map.of(
                "name", "QA删除残留角色", "code", "qa_delrole_" + SEQ.incrementAndGet())), 200);
        long roleId = created.path("data").path("id").asLong();
        call(adminToken, post("/roles/" + roleId + "/users/" + userId), 200);
        assertEquals(1, call(adminToken, get("/roles/" + roleId + "/users"), 200).path("data").size());

        call(adminToken, delete("/users/" + userId), 200);

        assertTrue(call(adminToken, get("/roles/" + roleId + "/users"), 200).path("data").isEmpty(),
                "已删除人员不应留在成员名单中");
        assertFalse(call(adminToken, get("/roles/user-map"), 200).path("data").has(String.valueOf(userId)),
                "人员侧角色映射不应残留已删除用户");

        // 离职不等于删除：绑定应保留，名单中以离职标签展示，便于追溯历史权限
        long leaveId = SEQ.incrementAndGet();
        db.update("insert into sys_user(id,name,position,phone,status) values (?,?,?,?,?)",
                leaveId, "qa_leave_" + leaveId, "监理员", "1390000" + (leaveId % 10000), "active");
        call(adminToken, post("/roles/" + roleId + "/users/" + leaveId), 200);
        call(adminToken, put("/users/" + leaveId + "/status?status=inactive"), 200);

        JsonNode members = call(adminToken, get("/roles/" + roleId + "/users"), 200).path("data");
        assertEquals(1, members.size(), "离职人员应保留角色绑定");
        assertEquals("inactive", members.get(0).path("status").asText());

        call(adminToken, delete("/roles/" + roleId), 200);
        db.update("delete from sys_user_role where user_id=?", leaveId);
        db.update("delete from sys_user where id in (?,?)", userId, leaveId);
    }

    // ---------------- 部门管理 ----------------

    @Test
    @DisplayName("部门新增、改名、含子部门禁删、空部门可删")
    void departmentCrudWithGuards() throws Exception {
        JsonNode parent = call(adminToken, jsonBody(post("/departments"),
                Map.of("name", "QA测试部门", "description", "集成测试", "sortOrder", 90)), 200).path("data");
        long parentId = parent.path("id").asLong();
        assertEquals("active", parent.path("status").asText());

        JsonNode child = call(adminToken, jsonBody(post("/departments"),
                Map.of("name", "QA子部门", "parentId", parentId, "sortOrder", 1)), 200).path("data");
        long childId = child.path("id").asLong();

        JsonNode renamed = call(adminToken, jsonBody(put("/departments/" + childId),
                Map.of("name", "QA子部门改名", "parentId", parentId, "sortOrder", 2)), 200).path("data");
        assertEquals("QA子部门改名", renamed.path("name").asText());

        JsonNode blocked = call(adminToken, delete("/departments/" + parentId), 400);
        assertEquals("该部门下存在子部门，请先删除子部门", blocked.path("message").asText());

        call(adminToken, delete("/departments/" + childId), 200);
        call(adminToken, delete("/departments/" + parentId), 200);
        call(adminToken, get("/departments/" + parentId), 400);
    }
}
