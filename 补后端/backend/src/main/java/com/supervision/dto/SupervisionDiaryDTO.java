package com.supervision.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
public class SupervisionDiaryDTO {

    @NotBlank(message = "编号不能为空")
    private String code;

    @NotNull(message = "项目ID不能为空")
    private Long projectId;

    @NotNull(message = "日记日期不能为空")
    private LocalDate diaryDate;

    private Long authorId;
    private String weather;
    private String wind;
    private String temperature;
    private String construction;
    private String management;
    private String inspection;
    private String otherMatters;
    private String otherWork;
    private String newIssues;
    private String materialInspection;
    private String status;
    private String photos;
    private String attachments;
    private String morningMeeting;
    private String drawingReview;
    private Long reviewerId;
    private LocalDateTime reviewedAt;
    private LocalDateTime submittedAt;
    private String submittedBy;
    private LocalDateTime rejectedAt;
    private String rejectedBy;
}
