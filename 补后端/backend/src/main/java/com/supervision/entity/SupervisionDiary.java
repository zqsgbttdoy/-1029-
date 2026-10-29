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
@Table(name = "biz_supervision_diary")
public class SupervisionDiary extends FieldRecord {

    @Column(nullable = false, length = 50)
    private String code;

    @Column(name = "project_id", nullable = false)
    private Long projectId;

    @Column(name = "diary_date", nullable = false)
    private LocalDate diaryDate;

    @Column(name = "author_id")
    private Long authorId;

    @Column(length = 30)
    private String weather;

    @Column(length = 30)
    private String wind;

    @Column(length = 30)
    private String temperature;

    @Column(columnDefinition = "TEXT")
    private String construction;

    @Column(columnDefinition = "TEXT")
    private String management;

    @Column(columnDefinition = "TEXT")
    private String inspection;

    @Column(name = "other_matters", columnDefinition = "TEXT")
    private String otherMatters;

    @Column(name = "other_work", columnDefinition = "TEXT")
    private String otherWork;

    @Column(name = "new_issues", columnDefinition = "TEXT")
    private String newIssues;

    @Column(name = "material_inspection", columnDefinition = "TEXT")
    private String materialInspection;

    @Transient
    @com.fasterxml.jackson.annotation.JsonProperty(access = com.fasterxml.jackson.annotation.JsonProperty.Access.READ_ONLY)
    private String authorName;

    @Transient
    @com.fasterxml.jackson.annotation.JsonProperty(access = com.fasterxml.jackson.annotation.JsonProperty.Access.READ_ONLY)
    private String reviewerName;

    @Column(length = 20)
    private String status;

    @Column
    private Integer version;

    @Column(name = "reject_reason", length = 500)
    private String rejectReason;

    @Column(columnDefinition = "TEXT")
    private String photos;

    @Column(columnDefinition = "TEXT")
    private String attachments;

    @Column(name = "morning_meeting", columnDefinition = "TEXT")
    private String morningMeeting;

    @Column(name = "drawing_review", columnDefinition = "TEXT")
    private String drawingReview;

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
