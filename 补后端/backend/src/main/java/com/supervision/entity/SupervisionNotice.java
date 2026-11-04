package com.supervision.entity;

import jakarta.persistence.*;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@Getter
@Setter
@NoArgsConstructor
@Entity
@Table(name = "biz_supervision_notice")
public class SupervisionNotice extends BaseEntity {

    @Column(nullable = false, length = 50)
    private String code;

    @Column(name = "project_id", nullable = false)
    private Long projectId;

    @Column(name = "notice_date", nullable = false)
    private LocalDate noticeDate;

    @Column(name = "author_id")
    private Long authorId;

    @Column(nullable = false, length = 200)
    private String title;

    @Column(columnDefinition = "TEXT")
    private String content;

    @Column
    private LocalDate deadline;

    @Column(name = "reply_content", columnDefinition = "TEXT")
    private String replyContent;

    @Column(name = "reply_date")
    private LocalDate replyDate;

    @Column(length = 20)
    private String status;

    @Column(length = 20)
    private String priority;

    @Column(columnDefinition = "TEXT")
    private String photos;

    @Column(columnDefinition = "TEXT")
    private String attachments;

    @Column(name = "related_diary_id")
    private Long relatedDiaryId;

    @Convert(converter = DirectoryIdsConverter.class)
    @Column(name = "document_directory_ids", columnDefinition = "TEXT")
    private List<Long> documentDirectoryIds = new ArrayList<>();

    /** 详情只读目录摘要：ID、名称与完整路径，由服务层组装，不参与持久化。 */
    @Transient
    @com.fasterxml.jackson.annotation.JsonProperty(access = com.fasterxml.jackson.annotation.JsonProperty.Access.READ_ONLY)
    private List<Map<String, Object>> documentDirectories;

    /** 详情只读摘要：编号、日期、作者、施工内容，由服务层组装，不参与持久化。 */
    @Transient
    @com.fasterxml.jackson.annotation.JsonProperty(access = com.fasterxml.jackson.annotation.JsonProperty.Access.READ_ONLY)
    private java.util.Map<String, Object> relatedDiary;

    @Converter
    public static class DirectoryIdsConverter implements AttributeConverter<List<Long>, String> {
        private static final com.fasterxml.jackson.databind.ObjectMapper MAPPER = new com.fasterxml.jackson.databind.ObjectMapper();

        @Override
        public String convertToDatabaseColumn(List<Long> ids) {
            try {
                return MAPPER.writeValueAsString(ids == null ? List.of() : ids);
            } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
                throw new IllegalArgumentException("工程资料目录ID序列化失败", e);
            }
        }

        @Override
        public List<Long> convertToEntityAttribute(String value) {
            if (value == null || value.isBlank()) return new ArrayList<>();
            try {
                return MAPPER.readValue(value, MAPPER.getTypeFactory().constructCollectionType(List.class, Long.class));
            } catch (java.io.IOException e) {
                throw new IllegalArgumentException("工程资料目录ID格式无效", e);
            }
        }
    }
}
