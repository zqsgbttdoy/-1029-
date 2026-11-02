package com.supervision.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;
import jakarta.validation.constraints.Min;

@Data
public class DailyInspectionDTO {

    @NotBlank(message = "编号不能为空")
    private String code;

    @NotNull(message = "项目ID不能为空")
    private Long projectId;

    @NotNull(message = "巡视日期不能为空")
    private LocalDate inspectionDate;

    private Long inspectorId;
    private String location;
    private String content;
    private String issues;
    private LocalDateTime startTime;
    private LocalDateTime endTime;
    @Min(value = 0, message = "施工人数必须为非负整数")
    private Integer workerCount;
    @Min(value = 0, message = "管理人数必须为非负整数")
    private Integer manageCount;
    private String checklist;
    private String status;
    private String photos;
    private String attachments;
}
