package com.supervision.entity;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.Setter;

/** 正文派生索引，不保存累计篇数；与日记及来源写事务一同维护。 */
@Getter
@Setter
@Entity
@Table(name = "biz_diary_reference", uniqueConstraints = @UniqueConstraint(name = "uk_diary_reference", columnNames = {"diary_id", "source_type", "source_id", "file_key"}), indexes = {
        @Index(name = "idx_diary_reference_file", columnList = "project_id,file_key,active,diary_id"),
        @Index(name = "idx_diary_reference_source", columnList = "source_type,source_id,active")})
public class DiaryReference extends BaseEntity {
    @Column(name = "project_id", nullable = false) private Long projectId;
    @Column(name = "diary_id", nullable = false) private Long diaryId;
    @Column(name = "source_type", nullable = false, length = 40) private String sourceType;
    @Column(name = "source_id", nullable = false) private Long sourceId;
    @Column(name = "file_key", nullable = false, length = 64) private String fileKey;
    @Column(name = "file_url", nullable = false, length = 500) private String fileUrl;
    @Column(name = "file_name", nullable = false, length = 500) private String fileName;
    @Column(nullable = false) private boolean active;
    @Column(name = "inactive_reason", length = 100) private String inactiveReason;
    public String identity() { return sourceType + ":" + sourceId + ":" + fileUrl; }
}
