package com.supervision.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.Data;

import java.time.LocalDate;

@Data
public class ProjectDTO {

    @NotBlank(message = "项目名称不能为空")
    private String name;

    @NotBlank(message = "项目编号不能为空")
    private String code;

    @NotBlank(message = "建设单位不能为空")
    @Size(max = 200, message = "建设单位不能超过200个字符")
    private String buildUnit;

    private String address;
    private String type;
    @Pattern(regexp = "planning|active|paused|completed", message = "项目状态必须为筹备中、进行中、已暂停或已完成")
    private String status;
    private LocalDate startDate;
    private LocalDate endDate;
    private String description;
    private Long managerId;
}
