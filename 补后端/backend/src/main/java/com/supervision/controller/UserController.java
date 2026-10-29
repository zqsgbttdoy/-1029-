package com.supervision.controller;

import com.supervision.annotation.RequireRole;
import com.supervision.common.ApiResponse;
import com.supervision.common.PageResult;
import com.supervision.dto.UserDTO;
import com.supervision.entity.User;
import com.supervision.service.ProjectAccessService;
import com.supervision.service.RoleService;
import com.supervision.service.UserService;
import jakarta.validation.Valid;
import lombok.AllArgsConstructor;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/users")
@AllArgsConstructor
public class UserController {

    private final UserService userService;
    private final RoleService roleService;
    private final ProjectAccessService projectAccess;

    @GetMapping
    public ApiResponse<PageResult<User>> list(
            @RequestParam(defaultValue = "1") int pageNum,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) String name,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) Long deptId,
            @RequestParam(required = false) Long projectId) {
        return ApiResponse.success(userService.list(pageNum, pageSize, name, status, deptId, projectId));
    }

    @GetMapping("/{id}")
    public ApiResponse<User> getById(@PathVariable Long id) {
        return ApiResponse.success(userService.getById(id));
    }

    @RequireRole("admin")
    @Transactional
    @PostMapping
    public ApiResponse<User> create(@Valid @RequestBody UserDTO dto) {
        applyPrimaryProject(dto);
        User user = userService.create(dto);
        // 人员与项目绑定同事务：非法项目 ID 整体回滚，避免“人已存、绑定半生效”
        projectAccess.syncUserProjects(user.getId(), dto.getProjectIds());
        return ApiResponse.success(user);
    }

    @RequireRole("admin")
    @Transactional
    @PutMapping("/{id}")
    public ApiResponse<User> update(@PathVariable Long id, @Valid @RequestBody UserDTO dto) {
        applyPrimaryProject(dto);
        User updated = userService.update(id, dto);
        projectAccess.syncUserProjects(id, dto.getProjectIds());
        return ApiResponse.success(updated);
    }

    /** 多项目列表保存时，“主归属”旧字段同步写入首个项目，保证仅读 User.projectId 的旧链路不与绑定列表脱节 */
    private void applyPrimaryProject(UserDTO dto) {
        if (dto.getProjectIds() == null) return;
        Long primary = null;
        for (Long pid : dto.getProjectIds()) {
            if (pid != null) { primary = pid; break; }
        }
        dto.setProjectId(primary);
    }

    @RequireRole("admin")
    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        userService.delete(id);
        return ApiResponse.success(null);
    }

    @RequireRole("admin")
    @PutMapping("/{id}/status")
    public ApiResponse<Void> updateStatus(@PathVariable Long id, @RequestParam String status) {
        userService.updateStatus(id, status);
        return ApiResponse.success(null);
    }

    @RequireRole("admin")
    @PutMapping("/{id}/reset-password")
    public ApiResponse<String> resetPassword(@PathVariable Long id,
                                             @RequestParam(required = false) String password) {
        String newPassword = userService.resetPassword(id, password);
        return ApiResponse.success("密码重置成功", newPassword);
    }

    /** 人员管理页“分配角色”弹窗：该用户已绑定的角色ID（以数据库为准回显） */
    @RequireRole("admin")
    @GetMapping("/{id}/roles")
    public ApiResponse<List<Long>> listRoleIds(@PathVariable Long id) {
        return ApiResponse.success(roleService.getRoleIdsByUser(id));
    }

    /** 人员管理页保存角色归属：整体替换，返回实际生效的角色ID */
    @RequireRole("admin")
    @PutMapping("/{id}/roles")
    public ApiResponse<List<Long>> assignRoles(@PathVariable Long id, @Valid @RequestBody List<Long> roleIds) {
        return ApiResponse.success(roleService.assignRoles(id, roleIds));
    }

    /** 人员管理页“分配项目”列：userId→项目ID列表映射（字面量路由优先于 /users/{id}，与 /roles/user-map 同法） */
    @RequireRole("admin")
    @GetMapping("/project-map")
    public ApiResponse<Map<Long, List<Long>>> projectMap() {
        return ApiResponse.success(projectAccess.userProjectMap());
    }

    /** 人员管理页编辑弹窗项目多选回显：以数据库为准的已绑定项目ID */
    @RequireRole("admin")
    @GetMapping("/{id}/projects")
    public ApiResponse<List<Long>> listProjectIds(@PathVariable Long id) {
        return ApiResponse.success(projectAccess.userProjectIds(id));
    }
}
