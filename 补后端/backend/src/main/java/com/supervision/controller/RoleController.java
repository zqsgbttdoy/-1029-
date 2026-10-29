package com.supervision.controller;

import com.supervision.annotation.RequireRole;
import com.supervision.common.ApiResponse;
import com.supervision.common.PageResult;
import com.supervision.dto.RoleMemberDTO;
import com.supervision.entity.Role;
import com.supervision.service.RoleService;
import jakarta.validation.Valid;
import lombok.AllArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

// 角色接口仅被管理页面（permission-settings.html、personnel-management.html）使用，整类要求 admin 角色
@RequireRole("admin")
@RestController
@RequestMapping("/roles")
@AllArgsConstructor
public class RoleController {

    private final RoleService roleService;

    @GetMapping
    public ApiResponse<PageResult<Role>> list(
            @RequestParam(defaultValue = "1") int pageNum,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) String name,
            @RequestParam(required = false) String status) {
        return ApiResponse.success(roleService.list(pageNum, pageSize, name, status));
    }

    @GetMapping("/{id}")
    public ApiResponse<Role> getById(@PathVariable Long id) {
        return ApiResponse.success(roleService.getById(id));
    }

    @PostMapping
    public ApiResponse<Role> create(@Valid @RequestBody Role role) {
        return ApiResponse.success(roleService.create(role));
    }

    @PutMapping("/{id}")
    public ApiResponse<Role> update(@PathVariable Long id, @Valid @RequestBody Role role) {
        return ApiResponse.success(roleService.update(id, role));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        roleService.delete(id);
        return ApiResponse.success(null);
    }

    @GetMapping("/{id}/permissions")
    public ApiResponse<List<Long>> getPermissionIds(@PathVariable Long id) {
        return ApiResponse.success(roleService.getPermissionIds(id));
    }

    @PostMapping("/{id}/permissions")
    public ApiResponse<Void> assignPermissions(@PathVariable Long id, @Valid @RequestBody List<Long> permissionIds) {
        roleService.assignPermissions(id, permissionIds);
        return ApiResponse.success(null);
    }

    @PostMapping("/{id}/users")
    public ApiResponse<Void> assignUsers(@PathVariable Long id, @Valid @RequestBody List<Long> userIds) {
        roleService.assignUsers(id, userIds);
        return ApiResponse.success(null);
    }

    /** 权限设置页右侧成员面板：查看该角色当前绑定的成员名单 */
    @GetMapping("/{id}/users")
    public ApiResponse<List<RoleMemberDTO>> listUsers(@PathVariable Long id) {
        return ApiResponse.success(roleService.listMembers(id));
    }

    /** 权限设置页“添加成员”：将单个用户绑定到当前角色 */
    @PostMapping("/{id}/users/{userId}")
    public ApiResponse<Void> bindUser(@PathVariable Long id, @PathVariable Long userId) {
        roleService.bindUser(id, userId);
        return ApiResponse.success(null);
    }

    /** 权限设置页成员行“移除”：解除该用户与当前角色的绑定 */
    @DeleteMapping("/{id}/users/{userId}")
    public ApiResponse<Void> unbindUser(@PathVariable Long id, @PathVariable Long userId) {
        roleService.unbindUser(id, userId);
        return ApiResponse.success(null);
    }

    /** 人员管理页角色列：一次返回全部“用户→已绑角色ID”，避免逐行查询 */
    @GetMapping("/user-map")
    public ApiResponse<Map<Long, List<Long>>> userRoleMap() {
        return ApiResponse.success(roleService.getUserRoleMap());
    }
}
