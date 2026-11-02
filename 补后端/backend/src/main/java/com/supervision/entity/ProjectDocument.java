package com.supervision.entity;

import jakarta.persistence.*;
import lombok.Data;
import lombok.EqualsAndHashCode;
import lombok.NoArgsConstructor;

import java.time.LocalDate;

@Data
@NoArgsConstructor
@EqualsAndHashCode(callSuper = true)
@Entity
@Table(name = "biz_project_document")
public class ProjectDocument extends BaseEntity {

    @Column(name = "project_id", nullable = false)
    private Long projectId;

    @Column(name = "sub_item_id", nullable = false)
    private Long subItemId;

    @Column(nullable = false, length = 200)
    private String name;

    @Column(name = "file_path", nullable = false, length = 500)
    private String filePath;

    @Column(name = "file_size")
    private Long fileSize;

    @Column(name = "upload_date", nullable = false)
    private LocalDate uploadDate;

    @Column(name = "uploader_id")
    private Long uploaderId;

    @Column(length = 500)
    private String description;

    @Transient
    @com.fasterxml.jackson.annotation.JsonProperty(access = com.fasterxml.jackson.annotation.JsonProperty.Access.READ_ONLY)
    private Long diaryReferenceCount = 0L;
}
