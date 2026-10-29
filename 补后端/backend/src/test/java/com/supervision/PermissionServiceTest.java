package com.supervision;

import com.supervision.entity.Permission;
import com.supervision.entity.Role;
import com.supervision.entity.RolePermission;
import com.supervision.exception.BusinessException;
import com.supervision.repository.PermissionRepository;
import com.supervision.repository.RolePermissionRepository;
import com.supervision.repository.RoleRepository;
import com.supervision.service.PermissionService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@DisplayName("PermissionService 权限树与角色绑定单元测试")
class PermissionServiceTest {

    @Mock private PermissionRepository permissionRepository;
    @Mock private RoleRepository roleRepository;
    @Mock private RolePermissionRepository rolePermissionRepository;

    @InjectMocks
    private PermissionService permissionService;

    private Permission permission(long id, String name, String code, Long parentId, int sortOrder) {
        Permission p = new Permission();
        p.setId(id);
        p.setName(name);
        p.setCode(code);
        p.setModule("qa");
        p.setDescription(code + " 说明");
        p.setParentId(parentId);
        p.setSortOrder(sortOrder);
        return p;
    }

    private Role role(long id, String code) {
        Role r = new Role();
        r.setId(id);
        r.setCode(code);
        r.setStatus("active");
        return r;
    }

    @Test
    @DisplayName("权限树按 parentId 组装三级层次，叶子 children 为空数组")
    @SuppressWarnings("unchecked")
    void treeBuildsThreeLevelHierarchy() {
        when(permissionRepository.findAll()).thenReturn(List.of(
                permission(1L, "菜单", "menu:qa", null, 1),
                permission(2L, "页面", "page:qa", 1L, 1),
                permission(3L, "按钮", "action:qa", 2L, 1),
                permission(4L, "另一菜单", "menu:other", null, 2)));

        List<Map<String, Object>> tree = permissionService.getTree();

        assertEquals(2, tree.size());
        Map<String, Object> root = tree.stream().filter(n -> Long.valueOf(1L).equals(n.get("id"))).findFirst().orElseThrow();
        assertEquals("menu:qa", root.get("code"));
        assertEquals(1, root.get("sortOrder"));
        List<Map<String, Object>> children = (List<Map<String, Object>>) root.get("children");
        assertEquals(1, children.size());
        assertEquals(2L, children.get(0).get("id"));
        List<Map<String, Object>> grandchildren = (List<Map<String, Object>>) children.get(0).get("children");
        assertEquals(1, grandchildren.size());
        assertEquals(3L, grandchildren.get(0).get("id"));
        assertEquals(List.of(), grandchildren.get(0).get("children"));
    }

    @Test
    @DisplayName("父子关系成环的脏数据不会无限递归，也不会挂到根节点")
    void treeToleratesParentCycle() {
        when(permissionRepository.findAll()).thenReturn(List.of(
                permission(1L, "A", "cycle:a", 2L, 1),
                permission(2L, "B", "cycle:b", 1L, 1)));

        List<Map<String, Object>> tree = permissionService.getTree();

        assertTrue(tree.isEmpty());
    }

    @Test
    @DisplayName("新增权限时编码重复直接拒绝且不落库")
    void createRejectsDuplicateCode() {
        Permission input = permission(0L, "重复", "dup:code", null, 1);
        when(permissionRepository.findByCode("dup:code")).thenReturn(Optional.of(permission(9L, "已存在", "dup:code", null, 1)));

        BusinessException error = assertThrows(BusinessException.class, () -> permissionService.create(input));

        assertEquals("权限编码已存在", error.getMessage());
        verify(permissionRepository, never()).save(any());
        verifyNoInteractions(rolePermissionRepository);
    }

    @Test
    @DisplayName("新增权限自动授予所有 admin 编码角色")
    void createGrantsNewPermissionToEveryAdminRole() {
        Permission input = permission(0L, "新权限", "qa:new", null, 5);
        Permission saved = permission(21L, "新权限", "qa:new", null, 5);
        when(permissionRepository.findByCode("qa:new")).thenReturn(Optional.empty());
        when(permissionRepository.save(input)).thenReturn(saved);
        when(roleRepository.findAllByCode("admin")).thenReturn(List.of(role(1L, "admin"), role(8L, "admin")));

        Permission result = permissionService.create(input);

        assertEquals(21L, result.getId());
        ArgumentCaptor<RolePermission> captor = ArgumentCaptor.forClass(RolePermission.class);
        verify(rolePermissionRepository, times(2)).save(captor.capture());
        List<Long> roleIds = captor.getAllValues().stream().map(RolePermission::getRoleId).toList();
        assertEquals(List.of(1L, 8L), roleIds);
        assertTrue(captor.getAllValues().stream().allMatch(rp -> rp.getPermissionId().equals(21L)));
    }

    @Test
    @DisplayName("系统尚无 admin 角色时新增权限仍成功，只是没有自动绑定")
    void createWithoutAdminRoleSkipsBinding() {
        Permission input = permission(0L, "孤儿权限", "qa:orphan", null, 1);
        when(permissionRepository.findByCode("qa:orphan")).thenReturn(Optional.empty());
        when(permissionRepository.save(input)).thenReturn(permission(22L, "孤儿权限", "qa:orphan", null, 1));
        when(roleRepository.findAllByCode("admin")).thenReturn(List.of());

        Permission result = permissionService.create(input);

        assertEquals(22L, result.getId());
        verifyNoInteractions(rolePermissionRepository);
    }

    @Test
    @DisplayName("更新权限会覆盖名称、编码、模块、父级与排序")
    void updateCopiesEditableFields() {
        Permission existing = permission(3L, "旧名称", "old:code", null, 1);
        Permission input = permission(0L, "新名称", "new:code", 2L, 9);
        input.setModule("field");
        input.setDescription("新说明");
        when(permissionRepository.findById(3L)).thenReturn(Optional.of(existing));
        when(permissionRepository.save(existing)).thenReturn(existing);

        Permission result = permissionService.update(3L, input);

        assertEquals("新名称", result.getName());
        assertEquals("new:code", result.getCode());
        assertEquals("field", result.getModule());
        assertEquals(2L, result.getParentId());
        assertEquals(9, result.getSortOrder());
        assertEquals("新说明", result.getDescription());
    }

    @Test
    @DisplayName("更新不存在的权限返回业务异常而不是静默新增")
    void updateMissingPermissionFails() {
        when(permissionRepository.findById(404L)).thenReturn(Optional.empty());

        BusinessException error = assertThrows(BusinessException.class,
                () -> permissionService.update(404L, permission(0L, "x", "x", null, 1)));

        assertEquals("权限不存在", error.getMessage());
        verify(permissionRepository, never()).save(any());
    }

    @Test
    @DisplayName("删除权限先清理角色绑定再删除权限本身")
    void deleteClearsRoleBindingsFirst() {
        Permission existing = permission(7L, "待删", "del:code", null, 1);
        when(permissionRepository.findById(7L)).thenReturn(Optional.of(existing));

        permissionService.delete(7L);

        var order = inOrder(rolePermissionRepository, permissionRepository);
        order.verify(rolePermissionRepository).deleteByPermissionId(7L);
        order.verify(permissionRepository).delete(existing);
    }

    @Test
    @DisplayName("删除不存在的权限不执行任何清理")
    void deleteMissingPermissionFails() {
        when(permissionRepository.findById(404L)).thenReturn(Optional.empty());

        assertThrows(BusinessException.class, () -> permissionService.delete(404L));

        verifyNoInteractions(rolePermissionRepository);
        verify(permissionRepository).findById(404L);
        verifyNoMoreInteractions(permissionRepository);
    }

    @Test
    @DisplayName("按模块查询直接委托仓储且保持返回顺序")
    void findByModuleDelegatesRepository() {
        List<Permission> rows = List.of(permission(1L, "A", "a", null, 1), permission(2L, "B", "b", null, 2));
        when(permissionRepository.findByModule("field")).thenReturn(rows);

        assertSame(rows, permissionService.findByModule("field"));
    }

    @Test
    @DisplayName("查询不存在的权限返回业务异常")
    void getByIdMissingPermissionFails() {
        when(permissionRepository.findById(99L)).thenReturn(Optional.empty());

        BusinessException error = assertThrows(BusinessException.class, () -> permissionService.getById(99L));

        assertEquals("权限不存在", error.getMessage());
    }
}
