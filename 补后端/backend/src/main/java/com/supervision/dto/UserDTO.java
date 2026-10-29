package com.supervision.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.Data;

import java.time.LocalDate;
import java.util.List;

@Data
public class UserDTO {

    @NotBlank(message = "姓名不能为空")
    @Size(max = 50, message = "姓名不能超过50个字符")
    private String name;

    private String gender;

    private Long deptId;

    @Size(max = 50, message = "职位不能超过50个字符")
    private String position;

    private String certNo;

    @NotBlank(message = "手机号不能为空")
    @Pattern(regexp = "^1[3-9]\\d{9}$", message = "手机号格式不正确")
    private String phone;

    private String idCard;

    /** 单项目时代的历史字段，保留为“主归属”兼容口径；多选场景下由后端取 projectIds 首个回写 */
    private Long projectId;

    /** 一人多项目：非 null 时按“整体替换”同步 biz_project_member 关系表；null 表示不动显式绑定（兼容旧客户端） */
    private List<Long> projectIds;

    private LocalDate hireDate;

    private String status;

    @Size(min = 6, max = 20, message = "密码长度应在6-20个字符之间")
    private String password;

    private String avatar;
}
