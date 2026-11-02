package com.supervision.entity;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.LocalDate;
import java.time.LocalDateTime;

@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "biz_safety_log")
public class SafetyLog extends BaseEntity {

    @Column(nullable = false, length = 50)
    private String code;

    @Column(name = "project_id", nullable = false)
    private Long projectId;

    @Column(name = "log_date", nullable = false)
    private LocalDate logDate;

    @Column(name = "author_id")
    private Long authorId;

    @Column(columnDefinition = "TEXT")
    private String content;

    @Column(columnDefinition = "TEXT")
    private String inspection;

    @Column(columnDefinition = "TEXT")
    private String safety;

    @Column(name = "major_issue", columnDefinition = "TEXT")
    private String majorIssue;

    @Column(length = 20)
    private String status;

    @Column
    private Integer version;

    @Column(name = "source_record_id")
    private Long sourceRecordId;

    @Version
    @Column(name = "lock_version", nullable = false, columnDefinition = "bigint default 0")
    private Long lockVersion = 0L;

    @Column(name = "reject_reason", length = 500)
    private String rejectReason;

    @Column(columnDefinition = "TEXT")
    private String photos;

    @Column(columnDefinition = "TEXT")
    private String attachments;

    @Column(length = 30)
    private String weather;

    @Column(length = 30)
    private String wind;

    @Column(length = 30)
    private String temperature;

    @Column(name = "reviewer_id")
    private Long reviewerId;

    @Column(name = "reviewed_at")
    private LocalDateTime reviewedAt;

    @Column(name = "submitted_at")
    private LocalDateTime submittedAt;

    @Column(name = "submitted_by", length = 50)
    private String submittedBy;

    @Column(name = "rejected_at")
    private LocalDateTime rejectedAt;

    @Column(name = "rejected_by", length = 50)
    private String rejectedBy;
}
