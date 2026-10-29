package com.supervision.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
public class SupervisionLogDTO {

    @NotBlank(message = "编号不能为空")
    private String code;

    @NotNull(message = "项目ID不能为空")
    private Long projectId;

    @NotNull(message = "日志日期不能为空")
    private LocalDate logDate;

    private LocalDate weekStart;
    private LocalDate weekEnd;
    private Long authorId;
    private String content;
    private String construction;
    private String safetyIssues;
    private String management;
    private String inspection;
    private String morningMeeting;
    private String drawingReview;
    private String otherMatters;
    private String status;
    private String photos;
    private String attachments;
    private String weather;
    private String wind;
    private String temperature;
    private Long reviewerId;
    private LocalDateTime reviewedAt;
    private LocalDateTime submittedAt;
    private String submittedBy;
    private LocalDateTime rejectedAt;
    private String rejectedBy;
}
