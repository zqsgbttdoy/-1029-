package com.supervision.repository;

import com.supervision.entity.UserRole;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;
import java.util.Optional;

public interface UserRoleRepository extends JpaRepository<UserRole, Long> {

    List<UserRole> findByUserId(Long userId);

    List<UserRole> findByRoleId(Long roleId);

    /** 绑定前的存在性检查，保证同一用户同一角色不写入重复记录 */
    Optional<UserRole> findByUserIdAndRoleId(Long userId, Long roleId);

    /** 一次分组统计各角色成员数，避免角色列表逐条 count 造成 N+1 查询；返回 [roleId, count] */
    @Query("select ur.roleId, count(ur) from UserRole ur group by ur.roleId")
    List<Object[]> countGroupByRoleId();

    void deleteByUserId(Long userId);

    void deleteByRoleId(Long roleId);
}
