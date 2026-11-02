package com.supervision.service;

import com.fasterxml.jackson.databind.*;
import com.supervision.common.*;
import com.supervision.entity.*;
import com.supervision.exception.BusinessException;
import jakarta.persistence.*;
import jakarta.persistence.criteria.*;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.PropertyAccessorFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.time.LocalDate;
import java.util.*;

/** 只依赖基础权限和存储模型；查询、关联验证及文件票据共享精确来源解析。 */
@Service
@RequiredArgsConstructor
public class DiaryResourceResolver {
    private final EntityManager em;
    private final ProjectAccessService access;
    private final FieldRecordVisibility visibility;
    private final ObjectMapper mapper;
    private final InspectionChecklist checklists;
    private record Source(Class<?> entity, String date, String title, FieldRecordKind kind) { }
    private Source source(String type) {
        if (type == null) throw new BusinessException(400, "请选择资源来源");
        return switch (type) {
            case "daily-inspections" -> new Source(DailyInspection.class, "inspectionDate", "location", FieldRecordKind.DAILY);
            case "sideline-inspections" -> new Source(SidelineInspection.class, "inspectionDate", "location", FieldRecordKind.SIDELINE);
            case "supervision-notices" -> new Source(SupervisionNotice.class, "noticeDate", "title", null);
            case "work-contacts" -> new Source(WorkContact.class, "contactDate", "title", null);
            case "project-documents" -> new Source(ProjectDocument.class, "uploadDate", "name", null);
            default -> throw new BusinessException(400, "资源来源无效");
        };
    }
    public Object load(String type, Long id, boolean lock) {
        if (id == null || id <= 0) throw new BusinessException(400, "资源编号无效");
        Object record = lock ? em.find(source(type).entity(), id, LockModeType.PESSIMISTIC_WRITE) : em.find(source(type).entity(), id);
        // 授权上传附件时可能已读过同一实体，取得源锁后必须刷新，不能恢复并发删除前的绑定。
        if (lock && record != null) em.refresh(record, LockModeType.PESSIMISTIC_WRITE);
        return record;
    }
    public Long project(Object record) { return (Long) value(record, "projectId"); }
    private Object value(Object record, String field) { return PropertyAccessorFactory.forBeanPropertyAccess(record).getPropertyValue(field); }
    private String text(Object record, String field) { return Objects.toString(value(record, field), ""); }
    public void requireVisible(String type, Object record) {
        Source source = source(type);
        if (record == null) throw new BusinessException(404, "资料已删除或不可用");
        if (source.kind() != null) visibility.require(source.kind(), (FieldRecord) record);
        else {
            access.requireRead(project(record));
            if (!(record instanceof ProjectDocument) && "inactive".equals(text(record, "status")))
                throw new BusinessException(404, "资料已删除或不可用");
        }
    }
    public Map<String, String> files(Object record) {
        Map<String, String> result = new LinkedHashMap<>();
        if (record instanceof ProjectDocument document) {
            if (document.getFilePath() != null && !document.getFilePath().isBlank())
                result.put(DiaryLinkCodec.normalize(document.getFilePath()), document.getName());
        } else {
            append(result, text(record, "photos"));
            append(result, text(record, "attachments"));
            if (record instanceof DailyInspection daily) append(result, checklists.fileJson(daily.getChecklist()));
        }
        return result;
    }
    private void append(Map<String, String> result, String json) {
        if (json == null || json.isBlank()) return;
        try {
            JsonNode array = mapper.readTree(json);
            if (!array.isArray()) throw new IllegalArgumentException();
            for (JsonNode item : array) {
                String file = DiaryLinkCodec.normalize(item.isTextual() ? item.asText() : item.path("url").asText());
                String name = item.isObject() ? item.path("name").asText("") : "";
                if (name.isBlank()) name = file.substring(file.lastIndexOf('/') + 1);
                result.putIfAbsent(file, name);
            }
        } catch (Exception e) { throw new BusinessException(400, "来源附件数据无效，请核对原记录"); }
    }
    public Map<String, Object> requireFile(String type, Long id, String raw, Long projectId, Object record) {
        requireVisible(type, record);
        if (projectId != null && !projectId.equals(project(record))) throw new BusinessException(403, "不可关联其他项目文件");
        String file = DiaryLinkCodec.normalize(raw);
        String name = files(record).get(file);
        if (name == null) throw new BusinessException(404, "资料已删除或已移除该文件");
        Map<String, Object> item = new LinkedHashMap<>(fileItem(type, id, file, name));
        item.put("projectId", project(record));
        return item;
    }
    @Transactional(readOnly = true)
    public Map<String, Object> resolve(String type, Long id, String raw) {
        return requireFile(type, id, raw, null, load(type, id, false));
    }
    private Map<String, Object> fileItem(String type, Long id, String file, String name) {
        return Map.of("sourceType", type, "sourceId", id, "file", file, "name", name,
                "type", file.substring(file.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT), "url", DiaryLinkCodec.stable(type, id, file));
    }
    @Transactional(readOnly = true)
    public PageResult<Map<String, Object>> list(Long projectId, String type, LocalDate date, LocalDate from, LocalDate to,
                                               String keyword, int page, int size) {
        access.requireRead(projectId);
        Source source = source(type);
        if (from == null && to == null) { from = date == null ? LocalDate.now() : date; to = from; }
        if (from != null && to != null && from.isAfter(to)) throw new BusinessException(400, "开始日期不能晚于结束日期");
        page = PageUtils.normalizePageNum(page); size = Math.min(100, Math.max(1, size));
        if ((long) (page - 1) * size > Integer.MAX_VALUE) throw new BusinessException(400, "页码超出范围");
        if (keyword != null && keyword.length() > 200) throw new BusinessException(400, "关键词过长");
        CriteriaBuilder cb = em.getCriteriaBuilder();
        var query = cb.createQuery(source.entity());
        var root = query.from(source.entity());
        query.where(filters(source, root, cb, projectId, from, to, keyword));
        query.orderBy(cb.desc(root.get(source.date())), cb.desc(root.get("id")));
        var count = cb.createQuery(Long.class); var cr = count.from(source.entity());
        count.select(cb.count(cr)).where(filters(source, cr, cb, projectId, from, to, keyword));
        List<Map<String, Object>> list = new ArrayList<>();
        for (Object record : em.createQuery(query).setFirstResult((page - 1) * size).setMaxResults(size).getResultList()) {
            Long id = ((BaseEntity) record).getId();
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("sourceType", type); item.put("sourceId", id); item.put("title", text(record, source.title()));
            item.put("code", record instanceof ProjectDocument ? "" : text(record, "code"));
            item.put("date", value(record, source.date()));
            item.put("files", files(record).entrySet().stream().map(f -> fileItem(type, id, f.getKey(), f.getValue())).toList());
            list.add(item);
        }
        return new PageResult<>(list, em.createQuery(count).getSingleResult(), page, size);
    }
    private Predicate[] filters(Source source, Root<?> root, CriteriaBuilder cb, Long projectId, LocalDate from, LocalDate to, String keyword) {
        List<Predicate> p = new ArrayList<>();
        p.add(cb.equal(root.get("projectId"), projectId));
        if (source.kind() != null) p.add(visibility.predicate(source.kind(), root, cb));
        else if (source.entity() != ProjectDocument.class) p.add(cb.notEqual(root.get("status"), "inactive"));
        if (from != null) p.add(cb.greaterThanOrEqualTo(root.get(source.date()), from));
        if (to != null) p.add(cb.lessThanOrEqualTo(root.get(source.date()), to));
        if (keyword != null && !keyword.isBlank()) {
            String search = "%" + keyword.trim().replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%";
            Predicate title = cb.like(root.get(source.title()), search, '!');
            p.add(source.entity() == ProjectDocument.class ? title : cb.or(title, cb.like(root.get("code"), search, '!')));
        }
        return p.toArray(Predicate[]::new);
    }
}
