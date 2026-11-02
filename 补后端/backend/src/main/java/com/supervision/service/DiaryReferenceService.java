package com.supervision.service;

import com.supervision.common.*;
import com.supervision.entity.*;
import com.supervision.exception.BusinessException;
import jakarta.persistence.*;
import jakarta.persistence.criteria.*;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.PropertyAccessorFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
@Transactional
public class DiaryReferenceService {
    private final EntityManager em;
    private final DiaryResourceResolver resources;
    private final FieldRecordVisibility visibility;

    private Map<String, DiaryLinkCodec.Link> links(SupervisionDiary diary) {
        Map<String, DiaryLinkCodec.Link> result = new LinkedHashMap<>();
        var bean = PropertyAccessorFactory.forBeanPropertyAccess(diary);
        for (String field : DiaryLinkCodec.FIELDS)
            for (var link : DiaryLinkCodec.parse((String) bean.getPropertyValue(field))) result.putIfAbsent(link.identity(), link);
        if (result.size() > 200) throw new BusinessException(400, "每篇日记最多关联 200 个不同来源文件，请减少链接后保存");
        return result;
    }
    private List<DiaryReference> current(Long diaryId) {
        return em.createQuery("select r from DiaryReference r where r.diaryId=:id order by r.id", DiaryReference.class)
                .setParameter("id", diaryId).setLockMode(LockModeType.PESSIMISTIC_WRITE).getResultList();
    }
    /** 在绑定日记自己的上传附件前取源锁，统一为日记→来源→上传文件→关系的锁顺序。 */
    public void lockSources(SupervisionDiary diary) { lockedSources(links(diary)); }
    private Map<String, Object> lockedSources(Map<String, DiaryLinkCodec.Link> desired) {
        Map<String, Object> sources = new HashMap<>();
        desired.values().stream().sorted(Comparator.comparing(DiaryLinkCodec.Link::sourceType).thenComparing(DiaryLinkCodec.Link::sourceId))
                .forEach(link -> {
                    String key = link.sourceType() + ":" + link.sourceId();
                    if (!sources.containsKey(key)) sources.put(key, resources.load(link.sourceType(), link.sourceId(), true));
                });
        return sources;
    }
    /** 调用方已持有日记锁（新建时为未提交的新行）；先取全部源锁，再读取/修改关系。 */
    public void sync(SupervisionDiary diary) {
        Map<String, DiaryLinkCodec.Link> desired = links(diary);
        Map<String, Object> sources = lockedSources(desired);
        Map<String, DiaryReference> existing = current(diary.getId()).stream().collect(Collectors.toMap(DiaryReference::identity, r -> r));
        Map<String, DiaryReference> inherited = new HashMap<>();
        if (diary.getSourceRecordId() != null) {
            SupervisionDiary original = em.find(SupervisionDiary.class, diary.getSourceRecordId());
            visibility.require(FieldRecordKind.DIARY, original);
            if (!Objects.equals(original.getProjectId(), diary.getProjectId()) || !Objects.equals(original.getAuthorId(), diary.getAuthorId())
                    || (!"approved".equals(original.getStatus()) && !"rejected".equals(original.getStatus())))
                throw new BusinessException(403, "修订稿来源无效");
            Set<String> originalLinks = links(original).keySet();
            for (DiaryReference row : current(original.getId())) if (originalLinks.contains(row.identity())) inherited.put(row.identity(), row);
        }
        for (var link : desired.values()) {
            DiaryReference row = existing.remove(link.identity());
            DiaryReference proof = row != null ? row : inherited.get(link.identity());
            boolean active = proof == null || proof.isActive();
            try {
                resources.requireFile(link.sourceType(), link.sourceId(), link.file(), diary.getProjectId(), sources.get(link.sourceType() + ":" + link.sourceId()));
            } catch (BusinessException e) {
                if (proof == null || (e.getCode() != 403 && e.getCode() != 404)) throw e;
                active = false;
            }
            if (row == null) {
                row = new DiaryReference();
                row.setProjectId(diary.getProjectId()); row.setDiaryId(diary.getId());
                row.setSourceType(link.sourceType()); row.setSourceId(link.sourceId());
                row.setFileKey(DiaryLinkCodec.hash(link.file())); row.setFileUrl(link.file());
                row.setFileName(link.name()); row.setActive(active);
                row.setInactiveReason(active ? null : "资料已删除或不可用");
                em.persist(row);
            } else {
                row.setFileName(link.name()); row.setActive(active);
                row.setInactiveReason(active ? null : "资料已删除或不可用");
            }
        }
        existing.values().forEach(em::remove);
        em.flush();
    }
    public void deleteDiary(Long id) {
        em.createQuery("delete from DiaryReference r where r.diaryId=:id").setParameter("id", id).executeUpdate();
    }
    /** 调用方先锁源；仅把已失去精确绑定的关系置为失效，永不因新增附件复活。 */
    public void invalidate(String type, BaseEntity record, boolean deleted) {
        Set<String> files = deleted ? Set.of() : resources.files(record).keySet();
        for (DiaryReference row : em.createQuery("select r from DiaryReference r where r.sourceType=:type and r.sourceId=:id and r.active=true order by r.id", DiaryReference.class)
                .setParameter("type", type).setParameter("id", record.getId()).setLockMode(LockModeType.PESSIMISTIC_WRITE).getResultList()) {
            if (!files.contains(row.getFileUrl())) { row.setActive(false); row.setInactiveReason("资料已删除或已移除该文件"); }
        }
    }
    private Predicate joined(Root<DiaryReference> r, Root<SupervisionDiary> d, CriteriaBuilder cb) {
        return cb.and(cb.equal(r.get("diaryId"), d.get("id")), cb.equal(r.get("projectId"), d.get("projectId")), cb.isTrue(r.get("active")),
                visibility.predicate(FieldRecordKind.DIARY, d, cb));
    }
    /** 一次聚合当前页全部文件，同时比较路径，避免仅用哈希或逐文件请求。 */
    @Transactional(readOnly = true)
    public void fillCounts(List<ProjectDocument> documents) {
        if (documents.isEmpty()) return;
        CriteriaBuilder cb = em.getCriteriaBuilder(); var q = cb.createTupleQuery();
        var r = q.from(DiaryReference.class); var d = q.from(SupervisionDiary.class);
        List<Predicate> files = new ArrayList<>();
        for (ProjectDocument doc : documents) {
            doc.setDiaryReferenceCount(0L);
            try {
                String file = DiaryLinkCodec.normalize(doc.getFilePath());
                files.add(cb.and(cb.equal(r.get("projectId"), doc.getProjectId()), cb.equal(r.get("fileKey"), DiaryLinkCodec.hash(file)), cb.equal(r.get("fileUrl"), file)));
            } catch (BusinessException ignored) { /* 历史无效存储路径不产生有效计数。 */ }
        }
        if (files.isEmpty()) return;
        q.multiselect(r.get("projectId"), r.get("fileUrl"), cb.countDistinct(d.get("id")))
                .where(joined(r, d, cb), cb.or(files.toArray(Predicate[]::new))).groupBy(r.get("projectId"), r.get("fileUrl"));
        Map<String, Long> counts = new HashMap<>();
        for (Tuple row : em.createQuery(q).getResultList()) counts.put(row.get(0) + ":" + row.get(1), (Long) row.get(2));
        for (ProjectDocument doc : documents) {
            try { doc.setDiaryReferenceCount(counts.getOrDefault(doc.getProjectId() + ":" + DiaryLinkCodec.normalize(doc.getFilePath()), 0L)); }
            catch (BusinessException ignored) { }
        }
    }
    @Transactional(readOnly = true)
    public PageResult<Map<String, Object>> references(Long documentId, int page, int size) {
        ProjectDocument doc = em.find(ProjectDocument.class, documentId);
        resources.requireVisible("project-documents", doc);
        String file = DiaryLinkCodec.normalize(doc.getFilePath());
        page = PageUtils.normalizePageNum(page); size = Math.min(100, Math.max(1, size));
        if ((long) (page - 1) * size > Integer.MAX_VALUE) throw new BusinessException(400, "页码超出范围");
        CriteriaBuilder cb = em.getCriteriaBuilder(); var q = cb.createQuery(SupervisionDiary.class);
        var r = q.from(DiaryReference.class); var d = q.from(SupervisionDiary.class);
        q.select(d).distinct(true).where(fileFilter(r, d, cb, doc.getProjectId(), file)).orderBy(cb.desc(d.get("id")));
        var count = cb.createQuery(Long.class); var cr = count.from(DiaryReference.class); var cd = count.from(SupervisionDiary.class);
        count.select(cb.countDistinct(cd.get("id"))).where(fileFilter(cr, cd, cb, doc.getProjectId(), file));
        var diaries = em.createQuery(q).setFirstResult((page - 1) * size).setMaxResults(size).getResultList();
        Set<Long> authors = diaries.stream().map(SupervisionDiary::getAuthorId).filter(Objects::nonNull).collect(Collectors.toSet());
        Map<Long, String> names = new HashMap<>();
        if (!authors.isEmpty()) em.createQuery("select u from User u where u.id in :ids", User.class).setParameter("ids", authors).getResultList().forEach(u -> names.put(u.getId(), u.getName()));
        List<Map<String, Object>> list = new ArrayList<>();
        for (SupervisionDiary diary : diaries) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", diary.getId()); item.put("code", diary.getCode()); item.put("diaryDate", diary.getDiaryDate());
            item.put("authorName", names.getOrDefault(diary.getAuthorId(), "")); item.put("status", diary.getStatus()); list.add(item);
        }
        return new PageResult<>(list, em.createQuery(count).getSingleResult(), page, size);
    }
    private Predicate fileFilter(Root<DiaryReference> r, Root<SupervisionDiary> d, CriteriaBuilder cb, Long projectId, String file) {
        return cb.and(joined(r, d, cb), cb.equal(r.get("projectId"), projectId), cb.equal(r.get("fileKey"), DiaryLinkCodec.hash(file)), cb.equal(r.get("fileUrl"), file));
    }
}
