package com.supervision.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.supervision.common.*;
import com.supervision.entity.*;
import com.supervision.exception.BusinessException;
import jakarta.persistence.*;
import jakarta.persistence.criteria.*;
import jakarta.validation.Validator;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.*;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.*;
import java.util.*;
import java.util.stream.Collectors;

/** 四类现场记录共用的事务边界，所有 PC 和小程序写入口均经过此服务。 */
@Service
@RequiredArgsConstructor
public class FieldRecordService {
    private final EntityManager em;
    private final ProjectAccessService access;
    private final AttachmentAccessService attachments;
    private final InspectionChecklist checklists;
    private final ObjectMapper mapper;
    private final Validator validator;
    private final PlatformTransactionManager transactions;
    private final DiaryReferenceService diaryReferences;
    private final FieldRecordVisibility visibility;

    @Transactional(readOnly = true)
    public PageResult<? extends FieldRecord> list(FieldRecordKind kind, int pageNum, int pageSize, Long projectId,
                                                 String code, String status, LocalDate from, LocalDate to, Long authorId) {
        if (projectId != null) access.requireRead(projectId);
        if (from != null && to != null && from.isAfter(to)) throw new BusinessException("开始日期不能晚于结束日期");
        pageNum = PageUtils.normalizePageNum(pageNum);
        pageSize = PageUtils.normalizePageSizeForStats(pageSize);
        CriteriaBuilder cb = em.getCriteriaBuilder();
        CriteriaQuery<? extends FieldRecord> query = cb.createQuery(kind.getEntityClass());
        Root<? extends FieldRecord> root = query.from(kind.getEntityClass());
        query.where(filters(kind, root, cb, projectId, code, status, from, to, authorId));
        query.orderBy(cb.desc(root.get("createTime")), cb.desc(root.get("id")));
        CriteriaQuery<Long> count = cb.createQuery(Long.class);
        Root<?> countRoot = count.from(kind.getEntityClass());
        count.select(cb.count(countRoot)).where(filters(kind, countRoot, cb, projectId, code, status, from, to, authorId));
        var records = em.createQuery(query).setFirstResult((pageNum - 1) * pageSize).setMaxResults(pageSize).getResultList();
        fillDiaryNames(records);
        return new PageResult<>(records, em.createQuery(count).getSingleResult(), pageNum, pageSize);
    }

    private Predicate[] filters(FieldRecordKind kind, Root<?> root, CriteriaBuilder cb, Long pid, String code,
                                String status, LocalDate from, LocalDate to, Long authorId) {
        List<Predicate> p = new ArrayList<>();
        p.add(visibility.predicate(kind, root, cb));
        if (pid != null) p.add(cb.equal(root.get("projectId"), pid));
        if (authorId != null) p.add(cb.equal(root.get(kind.getAuthorField()), authorId));
        if (code != null && !code.isBlank()) p.add(cb.like(root.get("code"), "%" + code + "%"));
        if (status != null && !status.isBlank()) {
            if (kind == FieldRecordKind.DAILY) {
                // 日常巡检不再产生审核待办；历史状态只在“已保存”中聚合一次。
                p.add("recorded".equals(status) ? root.get("status").in(FieldRecordKind.DAILY_SAVED_STATUSES)
                        : "draft".equals(status) ? cb.equal(root.get("status"), "draft") : cb.disjunction());
            } else p.add("submitted".equals(normalizeStatus(status))
                    ? root.get("status").in("submitted", "pending") : cb.equal(root.get("status"), normalizeStatus(status)));
        }
        if (from != null) p.add(cb.greaterThanOrEqualTo(root.get(kind.getDateField()), from));
        if (to != null) p.add(cb.lessThanOrEqualTo(root.get(kind.getDateField()), to));
        return p.toArray(Predicate[]::new);
    }

    @Transactional(readOnly = true)
    public FieldRecord get(FieldRecordKind kind, Long id) {
        FieldRecord record = em.find(kind.getEntityClass(), id);
        if (record == null || "inactive".equals(record.getStatus())) throw new BusinessException(404, "记录不存在");
        checkVisible(kind, record);
        fillDiaryNames(List.of(record));
        return record;
    }

    // 仅为已获准访问的记录补充姓名；不返回人员实体，也不接受客户端写入展示姓名。
    private void fillDiaryNames(Collection<? extends FieldRecord> records) {
        var namedRecords = records.stream().filter(r -> r instanceof SupervisionDiary || r instanceof SupervisionLog || r instanceof DailyInspection).toList();
        Set<Long> ids = new HashSet<>();
        for (FieldRecord record : namedRecords) {
            for (String field : record instanceof DailyInspection ? List.of("inspectorId") : List.of("authorId", "reviewerId")) {
                Long id = (Long) bean(record).getPropertyValue(field);
                if (id != null) ids.add(id);
            }
        }
        if (ids.isEmpty()) return;
        Map<Long, String> names = new HashMap<>();
        em.createQuery("select u from User u where u.id in :ids", User.class).setParameter("ids", ids)
                .getResultList().forEach(user -> names.put(user.getId(), user.getName()));
        for (FieldRecord record : namedRecords) {
            if (record instanceof DailyInspection daily) daily.setAuthorName(names.get(daily.getInspectorId()));
            else {
                bean(record).setPropertyValue("authorName", names.get(bean(record).getPropertyValue("authorId")));
                bean(record).setPropertyValue("reviewerName", names.get(bean(record).getPropertyValue("reviewerId")));
            }
        }
    }

    private void checkVisible(FieldRecordKind kind, FieldRecord record) {
        visibility.require(kind, record);
    }

    public FieldRecord create(FieldRecordKind kind, Map<String, Object> input, String requestId) {
        if (requestId == null || !requestId.matches("[a-zA-Z0-9_-]{16,100}")) throw new BusinessException(400, "缺少有效的请求唯一标识，请刷新页面");
        String key = hash(access.currentUser().getId() + ":" + kind.name() + ":" + requestId);
        String fingerprint = hash(json(new TreeMap<>(input)));
        TransactionTemplate tx = new TransactionTemplate(transactions);
        try {
            return tx.execute(status -> {
                FieldRecord previous = byRequest(kind, key);
                if (previous != null) return replay(kind, previous, fingerprint);
                FieldRecord record = candidate(kind, input, null);
                access.requireRead(record.getProjectId());
                bean(record).setPropertyValue(kind.getAuthorField(), access.currentUser().getId());
                record.setStatus("draft");
                record.setRequestKey(key);
                record.setRequestHash(fingerprint);
                if (bean(record).isWritableProperty("version")) bean(record).setPropertyValue("version", 1);
                Object source = input.get("sourceRecordId");
                if (source != null) {
                    FieldRecord old = revisionSource(kind, Long.valueOf(source.toString()));
                    if (kind.retainsSubmittedVersions() && nextRevision(kind, old.getId()) != null)
                        throw new BusinessException(409, "已有后续版本，请从原记录的修订入口打开，不能重复建立同一版本");
                    if (!Objects.equals(old.getProjectId(), record.getProjectId())) throw new BusinessException(400, "修订稿不能更换项目");
                    if (kind.retainsSubmittedVersions() && !Objects.equals(bean(old).getPropertyValue(kind.getDateField()), bean(record).getPropertyValue(kind.getDateField())))
                        throw new BusinessException(400, "修订稿不能更换记录日期");
                    record.setSourceRecordId(old.getId());
                    if (bean(record).isWritableProperty("version")) bean(record).setPropertyValue("version", businessVersion(old) + 1);
                }
                if (record instanceof SupervisionDiary diary) diaryReferences.lockSources(diary);
                attachments.bind(record);
                checkCode(kind, record, null);
                applyRequestedStatus(kind, record, input.get("status"));
                em.persist(record);
                em.flush();
                if (record instanceof SupervisionDiary diary) diaryReferences.sync(diary);
                event(kind, record, "create", null);
                return record;
            });
        } catch (DataIntegrityViolationException | jakarta.persistence.PersistenceException | BusinessException e) {
            if (e instanceof BusinessException business && business.getCode() != 409) throw e;
            // 并发相同请求由数据库唯一约束裁决，回滚后另开事务读取原结果。
            // 编号预检查也可能观察到刚提交的同键记录；必须在新事务中复核正文和权限。
            TransactionTemplate recovery = new TransactionTemplate(transactions);
            recovery.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            FieldRecord previous = recovery.execute(status -> {
                FieldRecord saved = byRequest(kind, key);
                return saved == null ? null : replay(kind, saved, fingerprint);
            });
            if (previous != null) return previous;
            throw e;
        }
    }

    private FieldRecord byRequest(FieldRecordKind kind, String key) {
        return em.createQuery("select r from " + kind.getEntityClass().getSimpleName() + " r where r.requestKey=:key", kind.getEntityClass())
                .setParameter("key", key).getResultStream().findFirst().orElse(null);
    }

    private FieldRecord replay(FieldRecordKind kind, FieldRecord record, String fingerprint) {
        checkVisible(kind, record);
        if (!fingerprint.equals(record.getRequestHash())) throw new BusinessException(409, "同一请求标识不能提交不同内容");
        fillDiaryNames(List.of(record));
        return record;
    }

    @Transactional
    public FieldRecord update(FieldRecordKind kind, Long id, Map<String, Object> input, Long version) {
        FieldRecord record = locked(kind, id, version);
        requireEditable(kind, record);
        FieldRecord candidate = candidate(kind, input, record);
        if (!Objects.equals(record.getProjectId(), candidate.getProjectId())) throw new BusinessException(400, "已有记录不能更换项目");
        if (kind.retainsSubmittedVersions() && record.getSourceRecordId() != null
                && !Objects.equals(bean(record).getPropertyValue(kind.getDateField()), bean(candidate).getPropertyValue(kind.getDateField())))
            throw new BusinessException(400, "修订稿不能更换记录日期");
        if (candidate instanceof SupervisionDiary diary) diaryReferences.lockSources(diary);
        attachments.bind(candidate);
        checkCode(kind, candidate, id);
        for (String field : kind.getFields()) bean(record).setPropertyValue(field, bean(candidate).getPropertyValue(field));
        if (record instanceof SupervisionLog log) log.setDiarySources(((SupervisionLog) candidate).getDiarySources());
        applyRequestedStatus(kind, record, input.get("status"));
        em.flush();
        if (record instanceof SupervisionDiary diary) diaryReferences.sync(diary);
        else if (kind.isInspection()) diaryReferences.invalidate(kind.getPath(), record, false);
        event(kind, record, "save", null);
        return record;
    }

    @Transactional
    public FieldRecord submit(FieldRecordKind kind, Long id, Long version) {
        FieldRecord record = locked(kind, id, version);
        requireEditable(kind, record);
        applyRequestedStatus(kind, record, "submitted");
        em.flush();
        event(kind, record, "submit", null);
        return record;
    }

    @Transactional
    public FieldRecord approve(FieldRecordKind kind, Long id, Long version, String status, String reason) {
        FieldRecord record = locked(kind, id, version);
        if (!kind.requiresReview()) throw new BusinessException(400, "日常巡检无需审核");
        access.requireReview(record.getProjectId());
        if (!Set.of("submitted", "pending").contains(record.getStatus())) throw new BusinessException(409, "只有已提交记录可以审核");
        if (!Set.of("approved", "rejected").contains(status)) throw new BusinessException(400, "审核状态无效");
        if ("rejected".equals(status) && (reason == null || reason.isBlank())) throw new BusinessException(400, "请填写退回原因");
        if (reason != null && reason.length() > 500) throw new BusinessException(400, "退回原因不能超过 500 字");
        record.setStatus(status);
        setIfPresent(record, "reviewerId", access.currentUser().getId());
        setIfPresent(record, "reviewedAt", LocalDateTime.now());
        setIfPresent(record, "rejectReason", "rejected".equals(status) ? reason : null);
        if ("rejected".equals(status)) {
            setIfPresent(record, "rejectedAt", LocalDateTime.now());
            setIfPresent(record, "rejectedBy", access.currentUser().getName());
        }
        em.flush();
        event(kind, record, status, reason);
        return record;
    }

    @Transactional
    public void delete(FieldRecordKind kind, Long id, Long version) {
        FieldRecord record = locked(kind, id, version);
        requireEditable(kind, record);
        if (kind == FieldRecordKind.DAILY && !Set.of("draft", "recorded", "submitted", "pending").contains(record.getStatus()))
            throw new BusinessException(409, "只能删除本人草稿或已保存的日常巡检记录；已审核的历史记录不可删除");
        record.setStatus("inactive");
        em.flush();
        if (kind == FieldRecordKind.DIARY) diaryReferences.deleteDiary(id);
        else if (kind.isInspection()) diaryReferences.invalidate(kind.getPath(), record, true);
        event(kind, record, "delete", null);
    }

    private FieldRecord locked(FieldRecordKind kind, Long id, Long version) {
        if (version == null) throw new BusinessException(428, "缺少记录版本，请重新打开记录后操作");
        FieldRecord record = em.find(kind.getEntityClass(), id, LockModeType.PESSIMISTIC_WRITE);
        if (record == null || "inactive".equals(record.getStatus())) throw new BusinessException(404, "记录不存在");
        checkVisible(kind, record);
        if (!Objects.equals(record.getLockVersion(), version)) throw new BusinessException(409, "记录已被其他端修改；本次内容未覆盖，请保留草稿并重新打开核对");
        return record;
    }

    private void requireOwner(FieldRecordKind kind, FieldRecord record) {
        if (!access.currentUser().getId().equals(bean(record).getPropertyValue(kind.getAuthorField())))
            throw new BusinessException(403, "仅填写人可以修改自己的记录");
    }

    private void requireEditable(FieldRecordKind kind, FieldRecord record) {
        requireOwner(kind, record);
        if (kind.isSavedMemo(record.getStatus())) return;
        if (kind.retainsSubmittedVersions() && !"draft".equals(record.getStatus()))
            throw new BusinessException(409, "已提交版本已冻结，不可修改、删除或再次提交；被驳回后请建立下一版本");
        if (!Set.of("draft", "rejected").contains(record.getStatus())) throw new BusinessException(409, "记录已提交或已审核，不能直接修改；已审核记录请建立修订稿");
    }

    private int businessVersion(FieldRecord record) {
        Object value = bean(record).isReadableProperty("version") ? bean(record).getPropertyValue("version") : null;
        return value instanceof Number n ? Math.max(1, n.intValue()) : 1;
    }

    private FieldRecord revisionSource(FieldRecordKind kind, Long id) {
        FieldRecord old = em.find(kind.getEntityClass(), id, LockModeType.PESSIMISTIC_WRITE);
        checkVisible(kind, old);
        requireOwner(kind, old);
        if (!"approved".equals(old.getStatus()) && !(kind.retainsSubmittedVersions() && "rejected".equals(old.getStatus())))
            throw new BusinessException(409, "只能从已审核通过或已驳回的冻结版本建立修订稿");
        return old;
    }

    private FieldRecord nextRevision(FieldRecordKind kind, Long id) {
        // 锁住原版本后进行当前读，跨端并发只能建立一份后续版本。
        return em.createQuery("select r from " + kind.getEntityClass().getSimpleName()
                        + " r where r.sourceRecordId=:id and r.status <> 'inactive' order by r.id", kind.getEntityClass())
                .setParameter("id", id).setLockMode(LockModeType.PESSIMISTIC_WRITE).setMaxResults(1)
                .getResultStream().findFirst().orElse(null);
    }

    @Transactional
    public FieldRecord newVersion(FieldRecordKind kind, Long id) {
        if (!kind.retainsSubmittedVersions()) throw new BusinessException(400, "此记录类型请使用原有工作流程");
        FieldRecord old = revisionSource(kind, id);
        FieldRecord next = nextRevision(kind, id);
        if (next != null) { checkVisible(kind, next); fillDiaryNames(List.of(next)); return next; }
        Map<String, Object> input = new LinkedHashMap<>();
        for (String field : kind.getFields()) input.put(field, bean(old).getPropertyValue(field));
        input.remove("code");
        input.put("sourceRecordId", id);
        if (old instanceof SupervisionLog log) input.put("diarySources", log.getDiarySources());
        return create(kind, input, UUID.randomUUID().toString());
    }

    @Transactional(readOnly = true)
    public List<FieldRecord> versions(FieldRecordKind kind, Long id) {
        FieldRecord current = get(kind, id);
        List<FieldRecord> result = new ArrayList<>();
        Set<Long> seen = new HashSet<>();
        while (current != null) {
            if (!seen.add(current.getId()) || seen.size() > 500) throw new BusinessException(409, "版本链异常，请联系管理员核对");
            try { checkVisible(kind, current); result.add(current); }
            catch (BusinessException e) { if (e.getCode() != 403 && e.getCode() != 404) throw e; }
            Long parent = current.getSourceRecordId();
            current = parent == null ? null : em.find(kind.getEntityClass(), parent);
        }
        Collections.reverse(result);
        fillDiaryNames(result);
        return result;
    }

    private FieldRecord candidate(FieldRecordKind kind, Map<String, Object> input, FieldRecord previous) {
        Map<String, Object> fields = new LinkedHashMap<>();
        for (String field : kind.getFields()) {
            Object value = input.containsKey(field) ? input.get(field) : previous == null ? null : bean(previous).getPropertyValue(field);
            if (value instanceof String text && text.length() > 60000) throw new BusinessException(400, "单个字段内容过长");
            fields.put(field, value);
        }
        if (fields.get("code") == null || fields.get("code").toString().isBlank())
            fields.put("code", previous == null ? kind.name() + "-" + UUID.randomUUID() : bean(previous).getPropertyValue("code"));
        if (fields.get("code").toString().length() > 50) throw new BusinessException(400, "编号不能超过 50 字符");
        if (kind == FieldRecordKind.DAILY) {
            for (String field : List.of("workerCount", "manageCount")) {
                Object value = fields.get(field);
                if (value != null && !value.toString().matches("[0-9]{1,10}"))
                    throw new BusinessException(400, "施工人数、管理人数必须为非负整数");
            }
        }
        try {
            Object dto = mapper.convertValue(fields, kind.getDtoClass());
            var errors = validator.validate(dto);
            if (!errors.isEmpty()) throw new BusinessException(400, errors.stream().map(v -> v.getMessage()).collect(Collectors.joining("；")));
            FieldRecord record = kind.getEntityClass().getDeclaredConstructor().newInstance();
            for (String field : kind.getFields()) bean(record).setPropertyValue(field, bean(dto).getPropertyValue(field));
            if (record instanceof DailyInspection daily) {
                if (daily.getStartTime() != null && daily.getEndTime() != null && !daily.getEndTime().isAfter(daily.getStartTime()))
                    throw new BusinessException(400, "巡视结束时间必须晚于开始时间");
                daily.setChecklist(checklists.normalize(daily.getChecklist(), previous instanceof DailyInspection old ? old.getChecklist() : null,
                        access.currentUser().getId(), access.currentUser().getName()));
            }
            if (record instanceof SupervisionLog log) {
                Object source = input.containsKey("diarySources") ? input.get("diarySources") : previous instanceof SupervisionLog old ? old.getDiarySources() : null;
                log.setDiarySources(validateSources(log, source));
            }
            return record;
        } catch (BusinessException e) { throw e; }
        catch (Exception e) { throw new BusinessException(400, "字段格式不正确，请检查日期和时间"); }
    }

    private void checkCode(FieldRecordKind kind, FieldRecord record, Long exceptId) {
        List<Long> ids = em.createQuery("select r.id from " + kind.getEntityClass().getSimpleName() + " r where r.code=:code", Long.class)
                .setParameter("code", bean(record).getPropertyValue("code")).getResultList();
        if (ids.stream().anyMatch(id -> !id.equals(exceptId))) throw new BusinessException(409, "编号已存在，请使用新编号");
    }

    private void applyRequestedStatus(FieldRecordKind kind, FieldRecord record, Object requested) {
        String status = requested == null ? "draft" : normalizeStatus(requested.toString());
        if (kind == FieldRecordKind.DAILY) {
            if (!Set.of("draft", "submitted", "recorded").contains(status))
                throw new BusinessException(400, "日常巡检只能保存草稿或提交保存，无需审核");
            // 已保存巡检修改原件，不因旧客户端的草稿请求而降级或退出项目可见列表。
            if (kind.isSavedMemo(record.getStatus()) || !"draft".equals(status)) status = "recorded";
        } else {
            if ("rejected".equals(status)) status = "draft";
            if (!Set.of("draft", "submitted").contains(status))
                throw new BusinessException(400, "请通过提交或审核操作改变状态");
        }
        if (!"draft".equals(status)) {
            String primary = kind == FieldRecordKind.DIARY ? "construction" : "content";
            Set<String> workFields = kind == FieldRecordKind.LOG
                    ? Set.of("construction", "inspection", "safetyIssues", "otherMatters", "content", "management")
                    : Set.of(primary, "management", "inspection");
            boolean hasText = Arrays.stream(kind.getFields()).filter(workFields::contains)
                    .map(f -> bean(record).getPropertyValue(f)).anyMatch(v -> v != null && !v.toString().isBlank());
            if (!hasText) throw new BusinessException(400, "请填写实际工作内容后提交");
            if (kind == FieldRecordKind.DIARY) {
                if (((SupervisionDiary) record).getWeather() == null || ((SupervisionDiary) record).getWeather().isBlank())
                    throw new BusinessException(400, "请填写天气");
                if (attachments.urls(record.getPhotos()).isEmpty()) throw new BusinessException(400, "监理日记至少上传一张现场照片");
            }
            if (kind.isInspection() && (bean(record).getPropertyValue("location") == null || bean(record).getPropertyValue("location").toString().isBlank()))
                throw new BusinessException(400, "请填写检查部位");
            if (record instanceof DailyInspection daily) {
                if ((daily.getStartTime() == null) != (daily.getEndTime() == null))
                    throw new BusinessException(400, "提交时请补齐巡视开始和结束时间");
                checklists.validateForSubmit(daily.getChecklist());
            }
            if (kind == FieldRecordKind.SIDELINE) {
                LocalDateTime start = (LocalDateTime) bean(record).getPropertyValue("startTime");
                LocalDateTime end = (LocalDateTime) bean(record).getPropertyValue("endTime");
                if (start == null || end == null || !end.isAfter(start)) throw new BusinessException(400, "旁站结束时间必须晚于开始时间");
                validateSideline(((SidelineInspection) record).getContent());
            }
            setIfPresent(record, "submittedAt", LocalDateTime.now());
            setIfPresent(record, "submittedBy", access.currentUser().getName());
        }
        record.setStatus(status);
    }

    @Transactional(readOnly = true)
    public List<FieldRecordEvent> history(FieldRecordKind kind, Long id) {
        get(kind, id);
        return em.createQuery("select e from FieldRecordEvent e where e.recordType=:kind and e.recordId=:id order by e.id desc", FieldRecordEvent.class)
                .setParameter("kind", kind.getPath()).setParameter("id", id).getResultList();
    }

    private void event(FieldRecordKind kind, FieldRecord record, String action, String reason) {
        fillDiaryNames(List.of(record));
        FieldRecordEvent event = new FieldRecordEvent();
        event.setRecordType(kind.getPath());
        event.setRecordId(record.getId());
        event.setActorId(access.currentUser().getId());
        event.setActorName(access.currentUser().getName());
        event.setAction(action);
        event.setReason(reason);
        event.setSnapshot(json(record));
        em.persist(event);
    }

    @Transactional(readOnly = true)
    public Map<String, Object> summary(Long projectId, LocalDate date) {
        access.requireRead(projectId);
        Map<String, Object> result = new LinkedHashMap<>();
        for (FieldRecordKind kind : FieldRecordKind.values()) {
            Map<String, Long> counts = new LinkedHashMap<>();
            for (String status : List.of("draft", "submitted", "approved", "rejected", "recorded")) {
                CriteriaBuilder cb = em.getCriteriaBuilder();
                CriteriaQuery<Long> q = cb.createQuery(Long.class);
                Root<?> root = q.from(kind.getEntityClass());
                q.select(cb.count(root)).where(filters(kind, root, cb, projectId, null, status, date, date, null));
                counts.put(status, em.createQuery(q).getSingleResult());
            }
            result.put(kind.getPath(), counts);
        }
        result.put("date", date);
        result.put("canReview", access.canReview(projectId));
        return result;
    }

    private List<SupervisionDiary> approvedDiaries(Long projectId, LocalDate date) {
        access.requireRead(projectId);
        List<SupervisionDiary> sources = em.createQuery("select d from SupervisionDiary d where d.projectId=:pid and d.diaryDate=:date and d.status='approved' and not exists (select revision.id from SupervisionDiary revision where revision.sourceRecordId=d.id and revision.status='approved') order by d.authorId,d.id", SupervisionDiary.class)
                .setParameter("pid", projectId).setParameter("date", date).setMaxResults(501).getResultList();
        if (sources.size() > 500) throw new BusinessException(400, "当日日记超过 500 份，请分工核对后人工整编，不进行截断取数");
        // 审核通过的修订可能隔着被驳回的中间版本；所有已被后续通过版本替代的祖先都不再参与整编。
        Set<Long> superseded = new HashSet<>();
        for (SupervisionDiary diary : sources) {
            Long parent = diary.getSourceRecordId();
            Set<Long> seen = new HashSet<>();
            while (parent != null && seen.add(parent)) {
                superseded.add(parent);
                SupervisionDiary old = em.find(SupervisionDiary.class, parent);
                parent = old == null ? null : old.getSourceRecordId();
            }
        }
        return sources.stream().filter(d -> !superseded.contains(d.getId())).toList();
    }

    /** 自动预填仅返回对应字段原值；不添加作者、编号、附件或来源标记。 */
    @Transactional(readOnly = true)
    public Map<String, String> diaryPrefill(Long projectId, LocalDate date) {
        List<SupervisionDiary> sources = approvedDiaries(projectId, date);
        Map<String, String> fields = new LinkedHashMap<>();
        for (String target : List.of("weather", "wind", "temperature", "construction", "inspection", "safetyIssues",
                "otherMatters", "management", "morningMeeting", "drawingReview")) {
            String origin = "safetyIssues".equals(target) ? "newIssues" : target;
            List<String> values = sources.stream().map(d -> (String) bean(d).getPropertyValue(origin))
                    .filter(v -> v != null && !v.isBlank()).distinct().toList();
            // 气象短字段存在分歧时留给填写人核对，不能拼接后截断或任选一人结论。
            boolean weatherField = Set.of("weather", "wind", "temperature").contains(target);
            String value = weatherField ? (values.size() == 1 ? values.get(0) : "") : String.join("\n\n", values);
            if (value.length() > (weatherField ? 30 : 60000))
                throw new BusinessException(400, "日记汇总字段内容过长，请人工核对，不自动截断原文");
            fields.put(target, value);
        }
        return fields;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> diarySource(Long projectId, LocalDate date) {
        List<SupervisionDiary> sources = approvedDiaries(projectId, date);
        Map<String, Object> fields = new LinkedHashMap<>();
        for (String field : List.of("construction", "management", "inspection", "otherMatters", "morningMeeting", "drawingReview")) {
            List<String> texts = new ArrayList<>();
            for (SupervisionDiary diary : sources) {
                Object text = bean(diary).getPropertyValue(field);
                if ("construction".equals(field)) {
                    List<String> content = new ArrayList<>();
                    if (text != null && !text.toString().isBlank()) content.add(text.toString());
                    // 日志不新增属性；新增日记栏目以明确标题整编到工作内容，保留来源。
                    String[][] extraFields = {{"otherWork", "其他工作"}, {"newIssues", "工作中的新问题"}, {"materialInspection", "材料进场检查"}};
                    for (String[] extra : extraFields) {
                        Object value = bean(diary).getPropertyValue(extra[0]);
                        if (value != null && !value.toString().isBlank()) content.add("【" + extra[1] + "】\n" + value);
                    }
                    text = String.join("\n\n", content);
                }
                if (text == null || text.toString().isBlank()) continue;
                User author = diary.getAuthorId() == null ? null : em.find(User.class, diary.getAuthorId());
                texts.add("【" + (author == null ? "原记录作者" : author.getName()) + "｜日记 " + diary.getCode() + "】\n" + text);
            }
            fields.put("construction".equals(field) ? "content" : field, String.join("\n\n", texts));
        }
        // 新日志的施工进度只取同名日记栏目；不从综合工作内容推断安全问题或处理结论。
        List<String> construction = new ArrayList<>();
        for (SupervisionDiary diary : sources) {
            if (diary.getConstruction() == null || diary.getConstruction().isBlank()) continue;
            User author = diary.getAuthorId() == null ? null : em.find(User.class, diary.getAuthorId());
            construction.add("【" + (author == null ? "原记录作者" : author.getName()) + "｜日记 " + diary.getCode() + "】\n" + diary.getConstruction());
        }
        fields.put("construction", String.join("\n\n", construction));
        fields.put("sources", sources.stream().map(d -> Map.of("id", d.getId(), "code", d.getCode(), "date", d.getDiaryDate(), "lockVersion", d.getLockVersion())).toList());
        return fields;
    }

    private String validateSources(SupervisionLog log, Object raw) {
        if (raw == null || raw.toString().isBlank()) return null;
        try {
            var array = mapper.readTree(raw.toString());
            if (!array.isArray() || array.size() > 500) throw new IllegalArgumentException();
            List<Map<String, Object>> sources = new ArrayList<>();
            Set<Long> seen = new HashSet<>();
            for (var item : array) {
                SupervisionDiary diary = (SupervisionDiary) get(FieldRecordKind.DIARY, item.path("id").asLong());
                if (!Objects.equals(diary.getProjectId(), log.getProjectId()) || !Objects.equals(diary.getDiaryDate(), log.getLogDate())
                        || !"approved".equals(diary.getStatus()) || diary.getLockVersion() != item.path("lockVersion").asLong())
                    throw new BusinessException(409, "日记来源不是本项目当日已审核版本，请重新取数");
                if (seen.add(diary.getId())) sources.add(Map.of("id", diary.getId(), "code", diary.getCode(),
                        "date", diary.getDiaryDate(), "lockVersion", diary.getLockVersion()));
            }
            return json(sources);
        } catch (BusinessException e) { throw e; }
        catch (Exception e) { throw new BusinessException(400, "日记来源格式不正确"); }
    }

    private void validateSideline(String content) {
        try {
            var detail = mapper.readTree(content);
            if (detail.path("process").asText().isBlank() || detail.path("result").asText().isBlank()
                    || !detail.path("docs").isArray() || detail.path("docs").isEmpty()) throw new IllegalArgumentException();
            for (String field : List.of("manageCount", "workerCount")) {
                var value = detail.path(field);
                if (!value.isIntegralNumber() || !value.canConvertToInt() || value.asInt() < 0) throw new IllegalArgumentException();
            }
        } catch (Exception e) { throw new BusinessException(400, "请填写旁站工序、结果、关联资料和非负整数人员数量"); }
    }

    private static BeanWrapper bean(Object object) { return PropertyAccessorFactory.forBeanPropertyAccess(object); }
    private static void setIfPresent(Object object, String field, Object value) { if (bean(object).isWritableProperty(field)) bean(object).setPropertyValue(field, value); }
    private static String normalizeStatus(String status) { return "pending".equals(status) ? "submitted" : status; }
    private String json(Object object) {
        try { return mapper.writeValueAsString(object); } catch (Exception e) { throw new IllegalStateException(e); }
    }
    private static String hash(String text) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
}
