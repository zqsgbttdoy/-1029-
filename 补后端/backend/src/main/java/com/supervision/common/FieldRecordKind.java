package com.supervision.common;

import com.supervision.dto.*;
import com.supervision.entity.*;
import com.supervision.exception.BusinessException;
import lombok.Getter;

/** 类型及可编辑字段使用固定白名单，不接受客户端提供的表名或属性路径。 */
@Getter
public enum FieldRecordKind {
    DIARY("supervision-diaries", SupervisionDiary.class, SupervisionDiaryDTO.class, "authorId", "diaryDate",
            "code,projectId,diaryDate,weather,wind,temperature,construction,management,inspection,otherMatters,morningMeeting,drawingReview,otherWork,newIssues,materialInspection,photos,attachments"),
    LOG("supervision-logs", SupervisionLog.class, SupervisionLogDTO.class, "authorId", "logDate",
            "code,projectId,logDate,weekStart,weekEnd,weather,wind,temperature,content,construction,safetyIssues,management,inspection,otherMatters,morningMeeting,drawingReview,photos,attachments"),
    DAILY("daily-inspections", DailyInspection.class, DailyInspectionDTO.class, "inspectorId", "inspectionDate",
            "code,projectId,inspectionDate,location,content,issues,startTime,endTime,workerCount,manageCount,checklist,photos,attachments"),
    SIDELINE("sideline-inspections", SidelineInspection.class, SidelineInspectionDTO.class, "inspectorId", "inspectionDate",
            "code,projectId,inspectionDate,location,content,startTime,endTime,photos,attachments");

    private final String path;
    private final Class<? extends FieldRecord> entityClass;
    private final Class<?> dtoClass;
    private final String authorField;
    private final String dateField;
    private final String[] fields;

    FieldRecordKind(String path, Class<? extends FieldRecord> entityClass, Class<?> dtoClass,
                    String authorField, String dateField, String fields) {
        this.path = path;
        this.entityClass = entityClass;
        this.dtoClass = dtoClass;
        this.authorField = authorField;
        this.dateField = dateField;
        this.fields = fields.split(",");
    }

    public static FieldRecordKind fromPath(String path) {
        for (FieldRecordKind kind : values()) if (kind.path.equals(path)) return kind;
        throw new BusinessException(404, "记录类型不存在");
    }

    public boolean isInspection() { return this == DAILY || this == SIDELINE; }

    // 历史巡检只在业务判定中兼容为已保存，读取时不改写原状态或历史快照。
    public static final java.util.Set<String> DAILY_SAVED_STATUSES = java.util.Set.of(
            "recorded", "submitted", "pending", "approved", "rejected", "fixed", "active");

    public boolean requiresReview() { return this != DAILY; }

    public boolean retainsSubmittedVersions() { return this == DIARY || this == LOG; }

    public boolean isSavedMemo(String status) {
        return this == DAILY && status != null && DAILY_SAVED_STATUSES.contains(status);
    }

    public boolean isPublished(String status) {
        return status != null && (isSavedMemo(status) || java.util.Set.of("approved", "recorded", "fixed").contains(status));
    }
}
