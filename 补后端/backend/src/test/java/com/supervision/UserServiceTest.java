package com.supervision;

import com.supervision.common.PageResult;
import com.supervision.dto.UserDTO;
import com.supervision.entity.User;
import com.supervision.exception.BusinessException;
import com.supervision.repository.UserRepository;
import com.supervision.repository.UserRoleRepository;
import com.supervision.service.UserService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import java.util.Collections;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@DisplayName("UserService 单元测试")
class UserServiceTest {

    @Mock
    private UserRepository userRepository;

    @Mock
    private UserRoleRepository userRoleRepository;

    @Mock
    private BCryptPasswordEncoder passwordEncoder;

    @InjectMocks
    private UserService userService;

    private UserDTO buildUserDTO() {
        UserDTO dto = new UserDTO();
        dto.setName("张三");
        dto.setGender("男");
        dto.setPhone("13800138000");
        dto.setDeptId(1L);
        dto.setPosition("监理工程师");
        return dto;
    }

    @Test
    @DisplayName("创建用户 - 验证默认密码被BCrypt加密和status设置")
    void testCreateUser() {
        UserDTO dto = buildUserDTO();
        when(userRepository.findByPhone(dto.getPhone())).thenReturn(Optional.empty());
        when(passwordEncoder.encode(anyString())).thenAnswer(invocation -> "ENC:" + invocation.getArgument(0));
        when(userRepository.save(any(User.class))).thenAnswer(invocation -> {
            User user = invocation.getArgument(0);
            user.setId(1L);
            return user;
        });

        User result = userService.create(dto);

        assertNotNull(result);
        assertEquals("active", result.getStatus());
        assertEquals("ENC:123456", result.getPassword());
        assertEquals("张三", result.getName());
        assertEquals("13800138000", result.getPhone());
        verify(passwordEncoder).encode("123456");
        verify(userRepository).save(any(User.class));
    }

    @Test
    @DisplayName("创建用户 - 自定义密码应被BCrypt加密")
    void testCreateUserWithCustomPassword() {
        UserDTO dto = buildUserDTO();
        dto.setPassword("customPwd");
        when(userRepository.findByPhone(dto.getPhone())).thenReturn(Optional.empty());
        when(passwordEncoder.encode(anyString())).thenAnswer(invocation -> "ENC:" + invocation.getArgument(0));
        when(userRepository.save(any(User.class))).thenAnswer(invocation -> {
            User user = invocation.getArgument(0);
            user.setId(1L);
            return user;
        });

        User result = userService.create(dto);

        assertEquals("ENC:customPwd", result.getPassword());
        verify(passwordEncoder).encode("customPwd");
    }

    @Test
    @DisplayName("创建用户 - 重复手机号应抛出BusinessException")
    void testCreateUserWithDuplicatePhone() {
        UserDTO dto = buildUserDTO();
        User existingUser = new User();
        existingUser.setId(1L);
        existingUser.setPhone("13800138000");
        when(userRepository.findByPhone(dto.getPhone())).thenReturn(Optional.of(existingUser));

        BusinessException exception = assertThrows(BusinessException.class, () -> userService.create(dto));
        assertEquals("手机号已存在", exception.getMessage());
        verify(userRepository, never()).save(any());
    }

    @Test
    @DisplayName("删除用户 - 应设置status为inactive并清理角色绑定")
    void testDeleteUser() {
        User user = new User();
        user.setId(1L);
        user.setStatus("active");
        when(userRepository.findById(1L)).thenReturn(Optional.of(user));
        when(userRepository.save(any(User.class))).thenAnswer(invocation -> invocation.getArgument(0));

        userService.delete(1L);

        verify(userRepository).save(argThat(u -> "inactive".equals(u.getStatus())));
        // 删除后不得在角色成员名单里留下“幽灵成员”
        verify(userRoleRepository).deleteByUserId(1L);
    }

    @Test
    @DisplayName("内置 admin 账号不可删除、不可停用、不可改名")
    void testBuiltInAdminIsProtected() {
        User admin = new User();
        admin.setId(1L);
        admin.setName("admin");
        admin.setStatus("active");
        when(userRepository.findById(1L)).thenReturn(Optional.of(admin));

        assertThrows(BusinessException.class, () -> userService.delete(1L));
        assertThrows(BusinessException.class, () -> userService.updateStatus(1L, "disabled"));
        UserDTO rename = buildUserDTO();
        assertThrows(BusinessException.class, () -> userService.update(1L, rename));
        UserDTO disable = buildUserDTO();
        disable.setName("admin");
        disable.setStatus("inactive");
        assertThrows(BusinessException.class, () -> userService.update(1L, disable));
        verify(userRepository, never()).save(any());
        verify(userRoleRepository, never()).deleteByUserId(any());
        assertEquals("active", admin.getStatus());
    }

    @Test
    @DisplayName("删除用户 - 用户不存在应抛出BusinessException")
    void testDeleteNonExistentUser() {
        when(userRepository.findById(999L)).thenReturn(Optional.empty());

        assertThrows(BusinessException.class, () -> userService.delete(999L));
        verify(userRepository, never()).save(any());
    }

    @Test
    @DisplayName("更新用户状态")
    void testUpdateStatus() {
        User user = new User();
        user.setId(1L);
        user.setStatus("active");
        when(userRepository.findById(1L)).thenReturn(Optional.of(user));
        when(userRepository.save(any(User.class))).thenAnswer(invocation -> invocation.getArgument(0));

        userService.updateStatus(1L, "disabled");

        verify(userRepository).save(argThat(u -> "disabled".equals(u.getStatus())));
    }

    @Test
    @DisplayName("带筛选条件的列表查询")
    void testListWithFilters() {
        User user = new User();
        user.setId(1L);
        user.setName("张三");
        user.setStatus("active");
        Page<User> mockPage = new PageImpl<>(Collections.singletonList(user));
        when(userRepository.findAll(any(Specification.class), any(Pageable.class))).thenReturn(mockPage);

        PageResult<User> result = userService.list(1, 10, "张", "active", 1L, 1L);

        assertNotNull(result);
        assertEquals(1, result.getList().size());
        assertEquals(1, result.getTotal());
        assertEquals(1, result.getPageNum());
        assertEquals(10, result.getPageSize());
        verify(userRepository).findAll(any(Specification.class), any(Pageable.class));
    }

    @Test
    @DisplayName("列表查询 - pageNum小于1应修正为1")
    void testListWithInvalidPageNum() {
        Page<User> mockPage = new PageImpl<>(Collections.emptyList());
        when(userRepository.findAll(any(Specification.class), any(Pageable.class))).thenReturn(mockPage);

        PageResult<User> result = userService.list(0, 10, null, null, null, null);

        assertEquals(1, result.getPageNum());
    }

    @Test
    @DisplayName("列表查询 - pageSize超过200应修正为200")
    void testListWithExceedingPageSize() {
        Page<User> mockPage = new PageImpl<>(Collections.emptyList());
        when(userRepository.findAll(any(Specification.class), any(Pageable.class))).thenReturn(mockPage);

        PageResult<User> result = userService.list(1, 300, null, null, null, null);

        assertEquals(200, result.getPageSize());
    }

    @Test
    @DisplayName("根据ID查询用户 - 用户存在")
    void testGetById() {
        User user = new User();
        user.setId(1L);
        user.setName("张三");
        when(userRepository.findById(1L)).thenReturn(Optional.of(user));

        User result = userService.getById(1L);

        assertNotNull(result);
        assertEquals("张三", result.getName());
    }

    @Test
    @DisplayName("根据ID查询用户 - 用户不存在应抛出BusinessException")
    void testGetByIdNotFound() {
        when(userRepository.findById(999L)).thenReturn(Optional.empty());

        BusinessException exception = assertThrows(BusinessException.class, () -> userService.getById(999L));
        assertEquals("用户不存在", exception.getMessage());
    }
}
