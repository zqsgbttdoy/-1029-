package com.supervision.dto;

import lombok.Data;

/**
 * 角色成员展示对象：权限设置页右侧成员面板只需姓名、部门、职位、联系方式与状态，
 * 因此不直接返回 User 实体，避免账号密码等敏感字段随响应外泄。
 */
@Data
public class RoleMemberDTO {

    private Long id;

    private String name;

    private Long deptId;

    private String position;

    private String phone;

    private String status;
}
