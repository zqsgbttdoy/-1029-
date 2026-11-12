package com.supervision.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.supervision.common.DiaryLinkCodec;
import com.supervision.common.FieldRecordKind;
import com.supervision.entity.*;
import com.supervision.exception.BusinessException;
import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.*;

/** 日记与直传资料的唯一关联写入方；旧正文引用仍由 DiaryReferenceService 独立维护。 */
@Service
@RequiredArgsConstructor
public class DiaryAttachmentService {
    private static final Set<String> NOTICE_STATUSES = Set.of("issued", "sent", "overdue", "responded", "replied", "verified");
    private static final Set<String> CONTACT_STATUSES = Set.of("issued", "sent", "overdue", "responded", "replied", "verified");

    private final EntityManager em;
    private final ProjectAccessService access;
    private final FieldRecordVisibility visibility;
    private final ObjectMapper mapper;
    private final DiaryResourceResolver diaryResources;

    @Transactional(readOnly = true)
    public Map<String, Object> dailyWorkbench(Long projectId, LocalDate date) {
        if (projectId == null || date == null) throw new BusinessException(400, "请选择项目和日记日期");
        access.requireRead(projectId);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("projectId", projectId);
        result.put("date", date);
        result.put("dailyInspections", dailyInspections(projectId, date));
        result.put("supervisionNotices", notices(projectId, date));
        result.put("workContacts", contacts(projectId, date));
        List<ProjectDocument> documents = em.createQuery("select d from ProjectDocument d where d.projectId=:projectId "
                        + "and d.uploadDate=:date and exists (select s.id from SubItemDatabase s where s.id=d.subItemId "
                        + "and s.projectId=:projectId and s.status <> 'inactive') order by d.createTime desc,d.id desc", ProjectDocument.class)
                .setParameter("projectId", projectId).setParameter("date", date).getResultList();
        fillDocumentMetadata(documents);
        result.put("documents", documents);
        return result;
    }

    private List<Map<String, Object>> dailyInspections(Long projectId, LocalDate date) {
        List<DailyInspection> records = em.createQuery("select r from DailyInspection r where r.projectId=:projectId "
                        + "and r.inspectionDate=:date and r.status in :statuses order by r.createTime desc,r.id desc", DailyInspection.class)
                .setParameter("projectId", projectId).setParameter("date", date)
                .setParameter("statuses", FieldRecordKind.DAILY_SAVED_STATUSES).getResultList();
        List<Map<String, Object>> result = new ArrayList<>();
        for (DailyInspection record : records) {
            try { visibility.require(FieldRecordKind.DAILY, record); }
            catch (BusinessException denied) { if (denied.getCode() == 403 || denied.getCode() == 404) continue; throw denied; }
            String content = joinText(record.getContent(), record.getIssues());
            Map<String, Object> item = businessItem(record.getId(), record.getCode(), record.getInspectionDate(),
                    record.getLocation(), content, record.getStatus(), "daily-inspection.html?id=" + record.getId() + "&readonly=true");
            // 日记同步所需的结构化原文与照片：沿用原附件 URL，不在前端重复上传
            item.put("startTime", record.getStartTime());
            item.put("workerCount", record.getWorkerCount());
            item.put("manageCount", record.getManageCount());
            item.put("inspectionContent", record.getContent());
            item.put("issues", record.getIssues());
            item.put("checklist", record.getChecklist());
            item.put("syncPhotos", syncPhotos(record));
            List<Map<String, Object>> files = new ArrayList<>();
            diaryResources.files(record).forEach((file, name) -> {
                Map<String, Object> attachment = new LinkedHashMap<>();
                attachment.put("name", name);
                attachment.put("file", file);
                attachment.put("url", DiaryLinkCodec.stable("daily-inspections", record.getId(), file));
                files.add(attachment);
            });
            item.put("attachments", files);
            result.add(item);
        }
        return result;
    }

    private List<Map<String, Object>> notices(Long projectId, LocalDate date) {
        List<SupervisionNotice> records = em.createQuery("select r from SupervisionNotice r where r.projectId=:projectId "
                        + "and r.noticeDate=:date and r.status in :statuses order by r.createTime desc,r.id desc", SupervisionNotice.class)
                .setParameter("projectId", projectId).setParameter("date", date)
                .setParameter("statuses", NOTICE_STATUSES).getResultList();
        List<Map<String, Object>> result = new ArrayList<>();
        for (SupervisionNotice record : records) {
            result.add(businessItem(record.getId(), record.getCode(), record.getNoticeDate(), record.getTitle(), record.getContent(),
                    record.getStatus(), "supervision-notice.html?id=" + record.getId() + "&readonly=true"));
        }
        return result;
    }

    private List<Map<String, Object>> contacts(Long projectId, LocalDate date) {
        List<WorkContact> records = em.createQuery("select r from WorkContact r where r.projectId=:projectId "
                        + "and r.contactDate=:date and r.status in :statuses order by r.createTime desc,r.id desc", WorkContact.class)
                .setParameter("projectId", projectId).setParameter("date", date)
                .setParameter("statuses", CONTACT_STATUSES).getResultList();
        List<Map<String, Object>> result = new ArrayList<>();
        for (WorkContact record : records) {
            result.add(businessItem(record.getId(), record.getCode(), record.getContactDate(), record.getTitle(), record.getContent(),
                    record.getStatus(), "work-contact.html?id=" + record.getId() + "&readonly=true"));
        }
        return result;
    }

    private Map<String, Object> businessItem(Long id, String code, LocalDate date, String title, String content,
                                             String status, String route) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", id);
        item.put("code", code);
        item.put("date", date);
        item.put("title", title);
        item.put("content", content);
        item.put("status", status);
        item.put("route", route);
        item.put("copyText", joinText(code, title, content));
        return item;
    }

    private String joinText(String... values) {
        return Arrays.stream(values).filter(Objects::nonNull).map(String::trim).filter(value -> !value.isEmpty())
                .reduce((left, right) -> left + "\n" + right).orElse("");
    }

    /** 整单照片、检查项照片及图片格式的问题附件均可同步；普通附件仍只提供查看。 */
    private List<Map<String, Object>> syncPhotos(DailyInspection record) {
        List<Map<String, Object>> result = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        try {
            appendPhotos(result, seen, mapper.readTree(record.getPhotos() == null || record.getPhotos().isBlank() ? "[]" : record.getPhotos()), false);
            String raw = record.getChecklist();
            if (raw != null && !raw.isBlank()) {
                for (JsonNode item : mapper.readTree(raw).path("items")) {
                    appendPhotos(result, seen, item.path("photos"), false);
                    for (JsonNode problem : item.path("problems")) appendPhotos(result, seen, problem.path("attachments"), true);
                }
            }
            return result;
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw new BusinessException(400, "巡检照片数据无效，请核对原记录");
        }
    }

    private void appendPhotos(List<Map<String, Object>> target, Set<String> seen, JsonNode array, boolean imageOnly) {
        if (array == null || array.isMissingNode() || array.isNull()) return;
        if (!array.isArray()) throw new BusinessException(400, "巡检照片数据无效，请核对原记录");
        for (JsonNode entry : array) {
            String raw = entry.isTextual() ? entry.asText() : entry.path("url").asText("");
            if (raw.isBlank()) continue;
            String url = DiaryLinkCodec.normalize(raw);
            String extension = url.replaceFirst("^.*[.]", "").toLowerCase(Locale.ROOT);
            if (imageOnly && !Set.of("jpg", "jpeg", "png", "gif", "webp", "bmp").contains(extension)) continue;
            if (!seen.add(url)) continue;
            Map<String, Object> photo = new LinkedHashMap<>();
            String name = entry.isObject() ? entry.path("name").asText("") : "";
            photo.put("url", url);
            photo.put("name", name.isBlank() ? url.substring(url.lastIndexOf('/') + 1) : name);
            if (entry.isObject() && entry.path("size").isNumber()) photo.put("size", entry.path("size").asLong());
            target.add(photo);
        }
    }

    @Transactional(readOnly = true)
    public Map<String, Object> related(Long diaryId) {
        SupervisionDiary diary = diary(diaryId, false);
        visibility.require(FieldRecordKind.DIARY, diary);
        return relatedResult(diary);
    }

    @Transactional
    public Map<String, Object> attach(Long diaryId, Long documentId) {
        SupervisionDiary diary = diary(diaryId, true);
        requireEditable(diary);
        ProjectDocument document = document(documentId, true);
        requireSameDay(diary, document);
        requireActiveDirectory(document);
        if (document.getDiaryId() != null && !diary.getId().equals(document.getDiaryId()))
            throw new BusinessException(409, "资料已关联其他日记，不能抢占关联");
        LinkedHashSet<Long> ids = attachmentIds(diary);
        ids.add(document.getId());
        diary.setRelatedAttachmentIds(writeIds(ids));
        document.setDiaryId(diary.getId());
        em.flush();
        return relatedResult(diary);
    }

    @Transactional
    public Map<String, Object> detach(Long diaryId, Long documentId) {
        SupervisionDiary diary = diary(diaryId, true);
        requireEditable(diary);
        ProjectDocument document = document(documentId, true);
        if (!Objects.equals(diary.getProjectId(), document.getProjectId()))
            throw new BusinessException(400, "日记与资料不属于同一项目");
        if (document.getDiaryId() != null && !diary.getId().equals(document.getDiaryId()))
            throw new BusinessException(409, "资料已关联其他日记，不能取消该关联");
        LinkedHashSet<Long> ids = attachmentIds(diary);
        ids.remove(document.getId());
        diary.setRelatedAttachmentIds(writeIds(ids));
        if (diary.getId().equals(document.getDiaryId())) document.setDiaryId(null);
        em.flush();
        return relatedResult(diary);
    }

    private Map<String, Object> relatedResult(SupervisionDiary diary) {
        List<ProjectDocument> documents = em.createQuery("select d from ProjectDocument d where d.diaryId=:diaryId "
                        + "order by d.createTime desc,d.id desc", ProjectDocument.class)
                .setParameter("diaryId", diary.getId()).getResultList();
        fillDocumentMetadata(documents);
        User author = diary.getAuthorId() == null ? null : em.find(User.class, diary.getAuthorId());
        diary.setAuthorName(author == null ? null : author.getName());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("diary", diary);
        result.put("list", documents);
        result.put("count", documents.size());
        return result;
    }

    private SupervisionDiary diary(Long id, boolean lock) {
        if (id == null || id <= 0) throw new BusinessException(400, "日记编号无效");
        SupervisionDiary diary = em.find(SupervisionDiary.class, id, lock ? LockModeType.PESSIMISTIC_WRITE : LockModeType.NONE);
        if (diary == null || "inactive".equals(diary.getStatus())) throw new BusinessException(404, "日记不存在或已删除");
        if (lock) em.refresh(diary, LockModeType.PESSIMISTIC_WRITE);
        return diary;
    }

    private ProjectDocument document(Long id, boolean lock) {
        if (id == null || id <= 0) throw new BusinessException(400, "资料编号无效");
        ProjectDocument document = em.find(ProjectDocument.class, id, lock ? LockModeType.PESSIMISTIC_WRITE : LockModeType.NONE);
        if (document == null) throw new BusinessException(404, "资料不存在或已删除");
        if (lock) em.refresh(document, LockModeType.PESSIMISTIC_WRITE);
        return document;
    }

    private void requireEditable(SupervisionDiary diary) {
        access.requireRead(diary.getProjectId());
        if (!Objects.equals(access.currentUser().getId(), diary.getAuthorId()))
            throw new BusinessException(403, "仅填写人可以修改自己的记录");
        if (!"draft".equals(diary.getStatus()))
            throw new BusinessException(409, "已提交、已审核或历史冻结版本不能修改资料关联");
    }

    private void requireSameDay(SupervisionDiary diary, ProjectDocument document) {
        if (!Objects.equals(diary.getProjectId(), document.getProjectId()))
            throw new BusinessException(400, "日记与资料不属于同一项目");
        if (!Objects.equals(diary.getDiaryDate(), document.getUploadDate()))
            throw new BusinessException(400, "只能关联与日记日期相同的当天直传资料");
    }

    private void requireActiveDirectory(ProjectDocument document) {
        SubItemDatabase directory = em.find(SubItemDatabase.class, document.getSubItemId());
        if (directory == null || "inactive".equals(directory.getStatus())
                || !Objects.equals(directory.getProjectId(), document.getProjectId()))
            throw new BusinessException(400, "资料所属目录不存在、已停用或不属于当前项目");
    }

    private LinkedHashSet<Long> attachmentIds(SupervisionDiary diary) {
        String json = diary.getRelatedAttachmentIds();
        if (json == null || json.isBlank()) return new LinkedHashSet<>();
        try {
            JsonNode array = mapper.readTree(json);
            if (!array.isArray()) throw new IllegalArgumentException();
            LinkedHashSet<Long> ids = new LinkedHashSet<>();
            for (JsonNode item : array) {
                if (!item.isIntegralNumber() || !item.canConvertToLong() || item.asLong() <= 0) throw new IllegalArgumentException();
                ids.add(item.asLong());
            }
            return ids;
        } catch (Exception e) {
            throw new BusinessException(409, "日记资料关联数据异常，请联系管理员核对");
        }
    }

    private String writeIds(Collection<Long> ids) {
        try { return mapper.writeValueAsString(ids); }
        catch (Exception e) { throw new IllegalStateException("日记资料关联序列化失败", e); }
    }

    /** 调用方已锁定日记；随后按资料 ID 顺序加锁并清空两侧关系。 */
    @Transactional
    public void detachAll(SupervisionDiary diary) {
        List<ProjectDocument> documents = em.createQuery("select d from ProjectDocument d where d.diaryId=:diaryId order by d.id", ProjectDocument.class)
                .setParameter("diaryId", diary.getId()).setLockMode(LockModeType.PESSIMISTIC_WRITE).getResultList();
        for (ProjectDocument document : documents) {
            em.refresh(document, LockModeType.PESSIMISTIC_WRITE);
            if (diary.getId().equals(document.getDiaryId())) document.setDiaryId(null);
        }
        diary.setRelatedAttachmentIds("[]");
    }

    /**
     * 资料删除前锁定当天全部可能关联的日记，再锁资料，避免先持资料锁再等待日记锁。
     * 调用方必须先完成未加锁的权限预检，返回后仍可在原事务执行旧正文引用失效和资料删除。
     */
    @Transactional
    public ProjectDocument prepareDocumentDelete(Long documentId) {
        ProjectDocument snapshot = document(documentId, false);
        List<SupervisionDiary> diaries = em.createQuery("select d from SupervisionDiary d where d.projectId=:projectId "
                        + "and d.diaryDate=:date order by d.id", SupervisionDiary.class)
                .setParameter("projectId", snapshot.getProjectId()).setParameter("date", snapshot.getUploadDate())
                .setLockMode(LockModeType.PESSIMISTIC_WRITE).getResultList();
        ProjectDocument document = document(documentId, true);
        if (document.getDiaryId() != null) {
            Long diaryId = document.getDiaryId();
            SupervisionDiary diary = diaries.stream().filter(item -> diaryId.equals(item.getId())).findFirst()
                    .orElseThrow(() -> new BusinessException(409, "资料关联数据异常，请先解除无效日记关联"));
            LinkedHashSet<Long> ids = attachmentIds(diary);
            ids.remove(document.getId());
            diary.setRelatedAttachmentIds(writeIds(ids));
            document.setDiaryId(null);
            em.flush();
        }
        return document;
    }

    /** 批量填充上传者、完整目录路径和可见日记摘要，不产生逐行查询。 */
    @Transactional(readOnly = true)
    public void fillDocumentMetadata(Collection<ProjectDocument> documents) {
        if (documents == null || documents.isEmpty()) return;
        Set<Long> userIds = new HashSet<>();
        Set<Long> projectIds = new HashSet<>();
        Set<Long> diaryIds = new HashSet<>();
        for (ProjectDocument document : documents) {
            document.setUploaderName(null);
            document.setDirectoryPath(null);
            document.setRelatedDiary(null);
            if (document.getUploaderId() != null) userIds.add(document.getUploaderId());
            if (document.getProjectId() != null) projectIds.add(document.getProjectId());
            if (document.getDiaryId() != null) diaryIds.add(document.getDiaryId());
        }
        Map<Long, SupervisionDiary> diaries = new HashMap<>();
        if (!diaryIds.isEmpty()) {
            em.createQuery("select d from SupervisionDiary d where d.id in :ids", SupervisionDiary.class)
                    .setParameter("ids", diaryIds).getResultList().forEach(diary -> {
                        diaries.put(diary.getId(), diary);
                        if (diary.getAuthorId() != null) userIds.add(diary.getAuthorId());
                    });
        }
        Map<Long, String> names = userNames(userIds);
        Map<Long, SubItemDatabase> directories = new HashMap<>();
        if (!projectIds.isEmpty()) {
            em.createQuery("select d from SubItemDatabase d where d.projectId in :ids", SubItemDatabase.class)
                    .setParameter("ids", projectIds).getResultList().forEach(item -> directories.put(item.getId(), item));
        }
        Map<Long, String> paths = new HashMap<>();
        for (ProjectDocument document : documents) {
            document.setUploaderName(names.get(document.getUploaderId()));
            document.setDirectoryPath(directoryPath(document.getSubItemId(), directories, paths));
            SupervisionDiary diary = diaries.get(document.getDiaryId());
            if (diary == null || "inactive".equals(diary.getStatus())) continue;
            try { visibility.require(FieldRecordKind.DIARY, diary); }
            catch (BusinessException denied) { if (denied.getCode() == 403 || denied.getCode() == 404) continue; throw denied; }
            document.setRelatedDiary(diarySummary(diary, names.get(diary.getAuthorId())));
        }
    }

    public Map<String, Object> diarySummary(SupervisionDiary diary, String authorName) {
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("id", diary.getId());
        summary.put("code", diary.getCode());
        summary.put("diaryDate", diary.getDiaryDate());
        summary.put("authorId", diary.getAuthorId());
        summary.put("authorName", authorName);
        summary.put("status", diary.getStatus());
        summary.put("route", "supervision-diary.html?id=" + diary.getId() + "&readonly=true");
        return summary;
    }

    private Map<Long, String> userNames(Set<Long> ids) {
        if (ids.isEmpty()) return Map.of();
        Map<Long, String> names = new HashMap<>();
        em.createQuery("select u from User u where u.id in :ids", User.class).setParameter("ids", ids)
                .getResultList().forEach(user -> names.put(user.getId(), user.getName()));
        return names;
    }

    private String directoryPath(Long id, Map<Long, SubItemDatabase> directories, Map<Long, String> cache) {
        if (id == null || !directories.containsKey(id)) return null;
        if (cache.containsKey(id)) return cache.get(id);
        List<String> names = new ArrayList<>();
        Set<Long> visited = new HashSet<>();
        SubItemDatabase current = directories.get(id);
        while (current != null && visited.add(current.getId())) {
            names.add(current.getName());
            current = current.getParentId() == null ? null : directories.get(current.getParentId());
        }
        Collections.reverse(names);
        String path = String.join(" / ", names);
        cache.put(id, path);
        return path;
    }
}
