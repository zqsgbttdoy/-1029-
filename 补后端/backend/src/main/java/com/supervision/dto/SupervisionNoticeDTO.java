package com.supervision.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDate;
import java.util.List;

@Data
public class SupervisionNoticeDTO {

    @NotBlank(message = "编号不能为空")
    private String code;

    @NotNull(message = "项目ID不能为空")
    private Long projectId;

    @NotNull(message = "通知日期不能为空")
    private LocalDate noticeDate;

    private Long authorId;

    @NotBlank(message = "标题不能为空")
    private String title;

    private String content;
    private LocalDate deadline;
    private String status;
    private String priority;
    private String photos;
    private String attachments;
    private Long relatedDiaryId;
    private List<Long> documentDirectoryIds;
}
