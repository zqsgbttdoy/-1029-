package com.supervision.service;

import com.supervision.common.FieldRecordKind;
import com.supervision.entity.FieldRecord;
import com.supervision.exception.BusinessException;
import jakarta.persistence.criteria.*;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.PropertyAccessorFactory;
import org.springframework.stereotype.Service;

/** 列表、资源查询与反查统一使用现场记录类型的可见性。 */
@Service
@RequiredArgsConstructor
public class FieldRecordVisibility {
    private final ProjectAccessService access;
    public Predicate predicate(FieldRecordKind kind, From<?, ?> root, CriteriaBuilder cb) {
        var reviews = access.projectIds(true);
        Predicate reviewer = reviews.isEmpty() ? cb.disjunction() : cb.and(root.get("projectId").in(reviews), cb.notEqual(root.get("status"), "draft"));
        Predicate published = kind == FieldRecordKind.DAILY ? root.get("status").in(FieldRecordKind.DAILY_SAVED_STATUSES)
                : root.get("status").in("approved", "recorded", "fixed");
        var ids = access.projectIds(false);
        return cb.and(ids.isEmpty() ? cb.disjunction() : root.get("projectId").in(ids), cb.notEqual(root.get("status"), "inactive"),
                cb.or(cb.equal(root.get(kind.getAuthorField()), access.currentUser().getId()), published, reviewer));
    }
    public void require(FieldRecordKind kind, FieldRecord record) {
        if (record == null || "inactive".equals(record.getStatus())) throw new BusinessException(404, "记录不存在或已删除");
        access.requireRead(record.getProjectId());
        Object author = PropertyAccessorFactory.forBeanPropertyAccess(record).getPropertyValue(kind.getAuthorField());
        if (!access.currentUser().getId().equals(author) && !kind.isPublished(record.getStatus())
                && ("draft".equals(record.getStatus()) || !access.canReview(record.getProjectId())))
            throw new BusinessException(403, "无权查看他人的草稿或待办");
    }
}
