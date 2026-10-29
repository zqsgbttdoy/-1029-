package com.supervision.service;

import com.supervision.common.PageResult;
import com.supervision.common.PageUtils;
import com.supervision.common.AuthContext;
import com.supervision.common.SystemAdmin;
import com.supervision.dto.UserDTO;
import com.supervision.entity.User;
import com.supervision.entity.UserRole;
import com.supervision.exception.BusinessException;
import com.supervision.repository.UserRepository;
import com.supervision.repository.UserRoleRepository;
import jakarta.persistence.criteria.Predicate;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class UserService {

    private static final String BUILT_IN_ADMIN_STATUS_MSG = "内置管理员账号不可停用、休假或离职";

    private final UserRepository userRepository;
    private final UserRoleRepository userRoleRepository;
    private final BCryptPasswordEncoder passwordEncoder;
    private final AttachmentAccessService attachments;

    /** 默认重置密码：由配置项 app.security.default-reset-password 提供，开发默认 123456，生产必须通过环境变量覆盖 */
    @Value("${app.security.default-reset-password:123456}")
    private String defaultResetPassword;

    public PageResult<User> list(int pageNum, int pageSize, String name, String status, Long deptId, Long projectId) {
        pageNum = PageUtils.normalizePageNum(pageNum);
        pageSize = PageUtils.normalizePageSize(pageSize);
        Specification<User> spec = (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            if (name != null && !name.isEmpty()) {
                predicates.add(cb.like(root.get("name"), "%" + name + "%"));
            }
            if (status != null && !status.isEmpty()) {
                predicates.add(cb.equal(root.get("status"), status));
            } else {
                predicates.add(cb.notEqual(root.get("status"), "inactive"));
            }
            if (deptId != null) {
                predicates.add(cb.equal(root.get("deptId"), deptId));
            }
            if (projectId != null) {
                predicates.add(cb.equal(root.get("projectId"), projectId));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
        Page<User> page = userRepository.findAll(spec,
                PageRequest.of(pageNum - 1, pageSize, Sort.by(Sort.Direction.DESC, "createTime")));
        return new PageResult<>(page.getContent(), page.getTotalElements(), pageNum, pageSize);
    }

    public User getById(Long id) {
        return userRepository.findById(id)
                .orElseThrow(() -> new BusinessException("用户不存在"));
    }

    @Transactional
    public User create(UserDTO dto) {
        if (userRepository.findByPhone(dto.getPhone()).isPresent()) {
            throw new BusinessException("手机号已存在");
        }
        User user = new User();
        user.setName(dto.getName());
        user.setGender(dto.getGender());
        user.setDeptId(dto.getDeptId());
        user.setPosition(dto.getPosition());
        user.setCertNo(dto.getCertNo());
        user.setPhone(dto.getPhone());
        user.setIdCard(dto.getIdCard());
        user.setProjectId(dto.getProjectId());
        user.setHireDate(dto.getHireDate());
        user.setStatus("active");
        String avatar = dto.getAvatar();
        if (avatar != null && avatar.replace('\\', '/').contains("uploads/")) {
            avatar = attachments.normalize(avatar);
            attachments.authorize(avatar);
        }
        user.setAvatar(avatar);
        String rawPassword = dto.getPassword() != null && !dto.getPassword().isEmpty() ? dto.getPassword() : "123456";
        user.setPassword(passwordEncoder.encode(rawPassword));
        return userRepository.save(user);
    }

    public User update(Long id, UserDTO dto) {
        User existing = getById(id);
        if (SystemAdmin.isBuiltInAdmin(existing)) {
            if (dto.getName() != null && !SystemAdmin.USER_NAME.equals(dto.getName())) {
                throw new BusinessException("内置管理员账号名不可修改");
            }
            requireActiveForBuiltInAdmin(dto.getStatus());
        }
        // 校验手机号唯一性（如果手机号有变更）
        if (dto.getPhone() != null && !dto.getPhone().equals(existing.getPhone())) {
            userRepository.findByPhone(dto.getPhone())
                    .ifPresent(u -> { throw new BusinessException("手机号已存在"); });
        }
        existing.setName(dto.getName());
        existing.setGender(dto.getGender());
        existing.setDeptId(dto.getDeptId());
        existing.setPosition(dto.getPosition());
        existing.setCertNo(dto.getCertNo());
        existing.setPhone(dto.getPhone());
        existing.setIdCard(dto.getIdCard());
        existing.setProjectId(dto.getProjectId());
        existing.setHireDate(dto.getHireDate());
        if (dto.getStatus() != null && !dto.getStatus().isEmpty()) {
            existing.setStatus(dto.getStatus());
        }
        return userRepository.save(existing);
    }

    /**
     * 管理员重置指定用户密码。未指定新密码时重置为配置的默认密码（app.security.default-reset-password）。
     * 返回重置后的明文密码，便于管理员告知用户。
     */
    @Transactional
    public String resetPassword(Long id, String newPassword) {
        User existing = getById(id);
        String raw = (newPassword != null && !newPassword.trim().isEmpty()) ? newPassword.trim() : defaultResetPassword;
        if (raw.length() < 6 || raw.length() > 32) {
            throw new BusinessException("密码长度应为6-32位");
        }
        existing.setPassword(passwordEncoder.encode(raw));
        userRepository.save(existing);
        log.info("密码重置审计: 操作者userId={}, 目标用户id={}", AuthContext.getUserId(), id);
        return raw;
    }

    @Transactional
    public void delete(Long id) {
        User existing = getById(id);
        if (SystemAdmin.isBuiltInAdmin(existing)) {
            throw new BusinessException("内置管理员账号不可删除");
        }
        existing.setStatus("inactive");
        userRepository.save(existing);
        // 删除即视同彻底移出：同步清理角色绑定，避免角色成员数与名单残留已删除人员。
        // 仅把状态改为“离职”不走此分支（PUT /users/{id}/status），其角色绑定与成员名单中的“离职”标签均按原样保留。
        userRoleRepository.deleteByUserId(id);
        log.info("删除用户同步清理角色绑定：操作者userId={}, 目标userId={}", AuthContext.getUserId(), id);
    }

    public User findByPhone(String phone) {
        return userRepository.findByPhone(phone)
                .orElseThrow(() -> new BusinessException("用户不存在"));
    }

    public User login(String phone, String password) {
        User user = userRepository.findByPhone(phone)
                .orElseThrow(() -> new BusinessException("用户不存在"));
        if (!"active".equals(user.getStatus())) {
            throw new BusinessException("用户已被禁用");
        }
        if (user.getPassword() == null || !passwordEncoder.matches(password, user.getPassword())) {
            throw new BusinessException("密码错误");
        }
        return user;
    }

    public void updateStatus(Long id, String status) {
        User existing = getById(id);
        if (SystemAdmin.isBuiltInAdmin(existing) && !"active".equals(status)) {
            throw new BusinessException(BUILT_IN_ADMIN_STATUS_MSG);
        }
        existing.setStatus(status);
        userRepository.save(existing);
    }

    /** 内置 admin 账号只允许保持启用，防止误停用后系统无人可管理（未传状态表示不修改） */
    private void requireActiveForBuiltInAdmin(String status) {
        if (status != null && !status.isEmpty() && !"active".equals(status)) {
            throw new BusinessException(BUILT_IN_ADMIN_STATUS_MSG);
        }
    }

    public List<UserRole> getUserRoles(Long userId) {
        return userRoleRepository.findByUserId(userId);
    }
}
