package com.supervision;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.supervision.common.AuthContext;
import com.supervision.controller.UserController;
import com.supervision.interceptor.RoleCheckInterceptor;
import com.supervision.service.ProjectAccessService;
import com.supervision.service.RoleService;
import com.supervision.service.UserService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * UserController 接口级权限校验集成测试（standalone MockMvc + RoleCheckInterceptor）。
 * 验证 P0 越权修复：PUT /users/{id}/reset-password
 * - 普通角色 / 无角色用户 -> 403，且响应体为统一 ApiResponse 错误契约（与 401 可区分）；
 * - admin 角色 -> 200 正常执行业务。
 * 同步覆盖用户-角色绑定读写接口（GET/PUT /users/{id}/roles）的 admin 门禁。
 */
@DisplayName("UserController 角色管理接口越权防护集成测试")
class UserControllerRoleCheckTest {

    private MockMvc mockMvc;
    private UserService userService;
    private RoleService roleService;
    private ProjectAccessService projectAccess;

    @BeforeEach
    void setUp() {
        userService = Mockito.mock(UserService.class);
        roleService = Mockito.mock(RoleService.class);
        projectAccess = Mockito.mock(ProjectAccessService.class);
        mockMvc = MockMvcBuilders.standaloneSetup(new UserController(userService, roleService, projectAccess))
                .addInterceptors(new RoleCheckInterceptor())
                .build();
    }

    @AfterEach
    void tearDown() {
        AuthContext.clear();
    }

    private void login(List<String> roles) {
        AuthContext.set(new AuthContext.CurrentUser(9L, "测试用户", roles));
    }

    @Test
    @DisplayName("普通角色调用 reset-password -> 403 权限不足（非 401，不触发前端登出）")
    void testResetPasswordForbiddenForNormalRole() throws Exception {
        login(List.of("user"));
        MockHttpServletResponse response = mockMvc.perform(put("/users/1/reset-password"))
                .andReturn().getResponse();

        assertEquals(403, response.getStatus());
        JSONObject body = JSON.parseObject(response.getContentAsString(StandardCharsets.UTF_8));
        assertEquals(3, String.valueOf(body.getIntValue("code")).length());
        assertEquals(403, body.getIntValue("code"));
        assertEquals("权限不足", body.getString("message"));
        assertNull(body.get("data"));
        // 业务方法不得被执行
        Mockito.verify(userService, Mockito.never()).resetPassword(any(), any());
    }

    @Test
    @DisplayName("无角色用户调用 reset-password -> 403")
    void testResetPasswordForbiddenForNoRole() throws Exception {
        login(Collections.emptyList());
        MockHttpServletResponse response = mockMvc.perform(put("/users/1/reset-password"))
                .andReturn().getResponse();
        assertEquals(403, response.getStatus());
        Mockito.verify(userService, Mockito.never()).resetPassword(any(), any());
    }

    @Test
    @DisplayName("admin 角色调用 reset-password -> 200 正常返回新密码")
    void testResetPasswordAllowedForAdmin() throws Exception {
        login(List.of("admin"));
        Mockito.when(userService.resetPassword(eq(1L), any())).thenReturn("Ab@12345678");

        MockHttpServletResponse response = mockMvc.perform(put("/users/1/reset-password"))
                .andReturn().getResponse();

        assertEquals(200, response.getStatus());
        JSONObject body = JSON.parseObject(response.getContentAsString(StandardCharsets.UTF_8));
        assertEquals(200, body.getIntValue("code"));
        assertEquals("Ab@12345678", body.getString("data"));
        Mockito.verify(userService).resetPassword(eq(1L), any());
    }

    @Test
    @DisplayName("无注解的 GET /users/{id}：普通角色仍可访问（读接口不受影响）")
    void testGetUserStillOpenForNormalRole() throws Exception {
        login(List.of("user"));
        Mockito.when(userService.getById(1L)).thenReturn(null);

        MockHttpServletResponse response = mockMvc.perform(get("/users/1"))
                .andReturn().getResponse();
        assertEquals(200, response.getStatus());
    }

    @Test
    @DisplayName("普通角色读写 /users/{id}/roles -> 403，且不触达业务方法")
    void testUserRolesForbiddenForNormalRole() throws Exception {
        login(List.of("user"));

        MockHttpServletResponse get = mockMvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/users/1/roles"))
                .andReturn().getResponse();
        assertEquals(403, get.getStatus());

        MockHttpServletResponse put = mockMvc.perform(put("/users/1/roles")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("[1,2]"))
                .andReturn().getResponse();
        assertEquals(403, put.getStatus());
        Mockito.verify(roleService, Mockito.never()).getRoleIdsByUser(any());
        Mockito.verify(roleService, Mockito.never()).assignRoles(any(), any());
    }

    @Test
    @DisplayName("admin 角色读写 /users/{id}/roles -> 200 正常返回")
    void testUserRolesAllowedForAdmin() throws Exception {
        login(List.of("admin"));
        Mockito.when(roleService.getRoleIdsByUser(1L)).thenReturn(List.of(7L));
        Mockito.when(roleService.assignRoles(eq(1L), any())).thenReturn(List.of(7L, 8L));

        MockHttpServletResponse get = mockMvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/users/1/roles"))
                .andReturn().getResponse();
        assertEquals(200, get.getStatus());
        assertEquals(7, JSON.parseObject(get.getContentAsString(StandardCharsets.UTF_8))
                .getJSONArray("data").getLongValue(0));

        MockHttpServletResponse put = mockMvc.perform(put("/users/1/roles")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("[7]"))
                .andReturn().getResponse();
        assertEquals(200, put.getStatus());
        assertEquals(2, JSON.parseObject(put.getContentAsString(StandardCharsets.UTF_8))
                .getJSONArray("data").size());
    }

    @Test
    @DisplayName("普通角色读项目绑定接口（/users/project-map、/users/{id}/projects）-> 403，不触达业务方法")
    void testUserProjectsForbiddenForNormalRole() throws Exception {
        login(List.of("user"));

        MockHttpServletResponse map = mockMvc.perform(get("/users/project-map"))
                .andReturn().getResponse();
        assertEquals(403, map.getStatus());

        MockHttpServletResponse one = mockMvc.perform(get("/users/1/projects"))
                .andReturn().getResponse();
        assertEquals(403, one.getStatus());
        Mockito.verify(projectAccess, Mockito.never()).userProjectMap();
        Mockito.verify(projectAccess, Mockito.never()).userProjectIds(any());
    }

    @Test
    @DisplayName("admin 读项目绑定接口 -> 200；字面量 /users/project-map 不被 /users/{id} 抢占")
    void testUserProjectsAllowedForAdmin() throws Exception {
        login(List.of("admin"));
        Mockito.when(projectAccess.userProjectMap()).thenReturn(java.util.Map.of(5L, List.of(1L, 2L, 3L)));
        Mockito.when(projectAccess.userProjectIds(5L)).thenReturn(List.of(1L, 2L, 3L));

        MockHttpServletResponse map = mockMvc.perform(get("/users/project-map"))
                .andReturn().getResponse();
        assertEquals(200, map.getStatus());
        assertEquals(3, JSON.parseObject(map.getContentAsString(StandardCharsets.UTF_8))
                .getJSONObject("data").getJSONArray("5").size());
        Mockito.verify(projectAccess, Mockito.never()).userProjectIds(99L);

        MockHttpServletResponse one = mockMvc.perform(get("/users/5/projects"))
                .andReturn().getResponse();
        assertEquals(200, one.getStatus());
        assertEquals(3, JSON.parseObject(one.getContentAsString(StandardCharsets.UTF_8))
                .getJSONArray("data").size());
    }
}
