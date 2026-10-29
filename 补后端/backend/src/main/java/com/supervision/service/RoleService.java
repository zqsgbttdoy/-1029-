package com.supervision.service;

import com.supervision.common.AuthContext;
import com.supervision.common.PageResult;
import com.supervision.common.PageUtils;
import com.supervision.common.SystemAdmin;
import com.supervision.dto.RoleMemberDTO;
import com.supervision.entity.Permission;
import com.supervision.entity.Role;
import com.supervision.entity.RolePermission;
import com.supervision.entity.User;
import com.supervision.entity.UserRole;
import com.supervision.exception.BusinessException;
import com.supervision.repository.PermissionRepository;
import com.supervision.repository.RolePermissionRepository;
import com.supervision.repository.RoleRepository;
import com.supervision.repository.UserRepository;
import com.supervision.repository.UserRoleRepository;
import jakarta.persistence.criteria.Predicate;
import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Slf4j
@Service
@AllArgsConstructor
public class RoleService {

    private final RoleRepository roleRepository;
    private final RolePermissionRepository rolePermissionRepository;
    private final UserRoleRepository userRoleRepository;
    private final PermissionRepository permissionRepository;
    private final UserRepository userRepository;

    public PageResult<Role> list(int pageNum, int pageSize, String name, String status) {
        pageNum = PageUtils.normalizePageNum(pageNum);
        pageSize = PageUtils.normalizePageSize(pageSize);
        Specification<Role> spec = (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            if (name != null && !name.isEmpty()) {
                predicates.add(cb.like(root.get("name"), "%" + name + "%"));
            }
            if (status != null && !status.isEmpty()) {
                predicates.add(cb.equal(root.get("status"), status));
            } else {
                predicates.add(cb.notEqual(root.get("status"), "inactive"));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
        Page<Role> page = roleRepository.findAll(spec,
                PageRequest.of(pageNum - 1, pageSize, Sort.by(Sort.Direction.DESC, "createTime")));
        fillUserCounts(page.getContent());
        return new PageResult<>(page.getContent(), page.getTotalElements(), pageNum, pageSize);
    }

    /** 角色列表逐条展示成员人数，一次分组查询回填，避免 N+1 查询 */
    private void fillUserCounts(List<Role> roles) {
        if (roles == null || roles.isEmpty()) {
            return;
        }
        Map<Long, Integer> counts = new HashMap<>();
        for (Object[] row : userRoleRepository.countGroupByRoleId()) {
            counts.put(((Number) row[0]).longValue(), ((Number) row[1]).intValue());
        }
        for (Role role : roles) {
            role.setUserCount(counts.getOrDefault(role.getId(), 0));
        }
    }

    public Role getById(Long id) {
        return roleRepository.findById(id)
                .orElseThrow(() -> new BusinessException("角色不存在"));
    }

    public Role create(Role role) {
        roleRepository.findByCode(role.getCode())
                .filter(e -> !"inactive".equals(e.getStatus()))
                .ifPresent(e -> { throw new BusinessException("角色编码已存在"); });
        role.setStatus("active");
        return roleRepository.save(role);
    }

    public Role update(Long id, Role role) {
        Role existing = getById(id);
        existing.setName(role.getName());
        existing.setDescription(role.getDescription());
        return roleRepository.save(existing);
    }

    @Transactional
    public void delete(Long id) {
        Role existing = getById(id);
        if (SystemAdmin.isAdminRole(existing)) {
            throw new BusinessException("系统管理员角色为内置角色，不可删除");
        }
        existing.setStatus("inactive");
        roleRepository.save(existing);
    }

    @Transactional
    public void assignPermissions(Long id, List<Long> permissionIds) {
        Role role = getById(id);
        Set<Long> ids = new LinkedHashSet<>(permissionIds == null ? List.of() : permissionIds);
        ids.remove(null);
        // 系统管理员角色固定拥有全部权限：忽略前端勾选，始终绑定当前全部权限项
        if (SystemAdmin.isAdminRole(role)) {
            ids = new LinkedHashSet<>(permissionRepository.findAll().stream().map(Permission::getId).toList());
        }
        rolePermissionRepository.deleteByRoleId(id);
        rolePermissionRepository.flush();
        // 构建列表后一次 saveAll，配合 hibernate.jdbc.batch_size 实现批量插入
        List<RolePermission> rolePermissions = new ArrayList<>();
        for (Long permissionId : ids) {
            RolePermission rp = new RolePermission();
            rp.setRoleId(id);
            rp.setPermissionId(permissionId);
            rolePermissions.add(rp);
        }
        rolePermissionRepository.saveAll(rolePermissions);
        log.info("分配角色权限：操作者userId={}, roleId={}, 权限数量={}",
                AuthContext.getUserId(), id, ids.size());
    }

    @Transactional
    public void assignUsers(Long id, List<Long> userIds) {
        Role role = getById(id);
        Set<Long> ids = new LinkedHashSet<>(userIds == null ? List.of() : userIds);
        ids.remove(null);
        // 内置 admin 账号始终保留系统管理员角色，防止误操作把唯一管理员移出
        if (SystemAdmin.isAdminRole(role)) {
            userRepository.findByName(SystemAdmin.USER_NAME).ifPresent(admin -> ids.add(admin.getId()));
        }
        userRoleRepository.deleteByRoleId(id);
        userRoleRepository.flush();
        // 构建列表后一次 saveAll，配合 hibernate.jdbc.batch_size 实现批量插入
        List<UserRole> userRoles = new ArrayList<>();
        for (Long userId : ids) {
            UserRole ur = new UserRole();
            ur.setUserId(userId);
            ur.setRoleId(id);
            userRoles.add(ur);
        }
        userRoleRepository.saveAll(userRoles);
        log.info("分配角色用户：操作者userId={}, roleId={}, 用户数量={}",
                AuthContext.getUserId(), id, ids.size());
    }

    public List<RolePermission> getRolePermissions(Long roleId) {
        return rolePermissionRepository.findByRoleId(roleId);
    }

    public List<Long> getPermissionIds(Long roleId) {
        getById(roleId);
        return rolePermissionRepository.findByRoleId(roleId).stream()
                .map(RolePermission::getPermissionId)
                .distinct()
                .toList();
    }

    /**
     * 角色绑定的成员列表（权限设置页成员面板）。
     * 在职成员排在前面，其余按姓名升序，保证同一角色多次打开顺序稳定。
     */
    public List<RoleMemberDTO> listMembers(Long roleId) {
        getById(roleId);
        List<Long> userIds = userRoleRepository.findByRoleId(roleId).stream()
                .map(UserRole::getUserId)
                .distinct()
                .toList();
        if (userIds.isEmpty()) {
            return List.of();
        }
        List<RoleMemberDTO> members = new ArrayList<>();
        for (User user : userRepository.findAllById(userIds)) {
            RoleMemberDTO member = new RoleMemberDTO();
            member.setId(user.getId());
            member.setName(user.getName());
            member.setDeptId(user.getDeptId());
            member.setPosition(user.getPosition());
            member.setPhone(user.getPhone());
            member.setStatus(user.getStatus());
            members.add(member);
        }
        members.sort(Comparator
                .comparing((RoleMemberDTO member) -> "active".equals(member.getStatus()) ? 0 : 1)
                .thenComparing(member -> member.getName() == null ? "" : member.getName()));
        return members;
    }

    /** 全量“用户→已绑角色ID”映射，供人员管理页角色列一次取数，避免逐行查询 */
    public Map<Long, List<Long>> getUserRoleMap() {
        Map<Long, List<Long>> map = new HashMap<>();
        for (UserRole userRole : userRoleRepository.findAll()) {
            map.computeIfAbsent(userRole.getUserId(), k -> new ArrayList<>()).add(userRole.getRoleId());
        }
        return map;
    }

    public List<Long> getRoleIdsByUser(Long userId) {
        requireUser(userId);
        return userRoleRepository.findByUserId(userId).stream()
                .map(UserRole::getRoleId)
                .distinct()
                .toList();
    }

    /** 角色绑定单个成员：已绑定则不重复写入（幂等） */
    @Transactional
    public void bindUser(Long roleId, Long userId) {
        requireAssignRole(getById(roleId));
        requireUser(userId);
        if (userRoleRepository.findByUserIdAndRoleId(userId, roleId).isPresent()) {
            return;
        }
        UserRole userRole = new UserRole();
        userRole.setUserId(userId);
        userRole.setRoleId(roleId);
        userRoleRepository.save(userRole);
        log.info("角色新增成员：操作者userId={}, roleId={}, userId={}", AuthContext.getUserId(), roleId, userId);
    }

    /** 解除单个成员与角色的绑定：未绑定时视为已完成，内置 admin 账号不得失去管理员角色 */
    @Transactional
    public void unbindUser(Long roleId, Long userId) {
        Role role = getById(roleId);
        User user = requireUser(userId);
        if (SystemAdmin.isAdminRole(role) && SystemAdmin.isBuiltInAdmin(user)) {
            throw new BusinessException("内置管理员账号必须保留系统管理员角色");
        }
        userRoleRepository.findByUserIdAndRoleId(userId, roleId).ifPresent(userRoleRepository::delete);
        log.info("角色解除成员：操作者userId={}, roleId={}, userId={}", AuthContext.getUserId(), roleId, userId);
    }

    /**
     * 从人员侧保存角色归属（整体替换该用户的角色）。
     * 内置 admin 账号自动补回系统管理员角色，返回实际生效的角色ID供前端回显。
     */
    @Transactional
    public List<Long> assignRoles(Long userId, List<Long> roleIds) {
        User user = requireUser(userId);
        Set<Long> ids = new LinkedHashSet<>(roleIds == null ? List.of() : roleIds);
        ids.remove(null);
        for (Long roleId : ids) {
            Role role = roleRepository.findById(roleId)
                    .orElseThrow(() -> new BusinessException("存在无效角色，请刷新后重试"));
            requireAssignRole(role);
        }
        if (SystemAdmin.isBuiltInAdmin(user)) {
            roleRepository.findByCode(SystemAdmin.ROLE_CODE).ifPresent(role -> ids.add(role.getId()));
        }
        userRoleRepository.deleteByUserId(userId);
        userRoleRepository.flush();
        // 构建列表后一次 saveAll，配合 hibernate.jdbc.batch_size 实现批量插入
        List<UserRole> userRoles = new ArrayList<>();
        for (Long roleId : ids) {
            UserRole userRole = new UserRole();
            userRole.setUserId(userId);
            userRole.setRoleId(roleId);
            userRoles.add(userRole);
        }
        userRoleRepository.saveAll(userRoles);
        log.info("分配用户角色：操作者userId={}, 目标userId={}, 角色数量={}",
                AuthContext.getUserId(), userId, ids.size());
        return new ArrayList<>(ids);
    }

    private User requireUser(Long userId) {
        return userRepository.findById(userId)
                .orElseThrow(() -> new BusinessException("用户不存在"));
    }

    /** 已软删除（inactive）的角色不再接受成员绑定，防止人员列表消失后仍能绑定 */
    private void requireAssignRole(Role role) {
        if ("inactive".equals(role.getStatus())) {
            throw new BusinessException("角色已删除，请刷新后重试");
        }
    }
}
