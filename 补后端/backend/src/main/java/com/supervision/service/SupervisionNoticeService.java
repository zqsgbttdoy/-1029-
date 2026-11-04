package com.supervision.service;

import com.supervision.common.PageResult;
import com.supervision.common.PageUtils;
import com.supervision.dto.ReplyDTO;
import com.supervision.dto.SupervisionNoticeDTO;
import com.supervision.entity.SubItemDatabase;
import com.supervision.entity.SupervisionDiary;
import com.supervision.entity.SupervisionNotice;
import com.supervision.exception.BusinessException;
import com.supervision.repository.SubItemDatabaseRepository;
import com.supervision.repository.SupervisionDiaryRepository;
import com.supervision.repository.SupervisionNoticeRepository;
import com.supervision.repository.UserRepository;
import jakarta.persistence.criteria.Predicate;
import lombok.AllArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

@Service
@Transactional
@AllArgsConstructor
public class SupervisionNoticeService {

    private static final java.util.Set<String> CONTENT_LOCKED_STATUSES =
            java.util.Set.of("issued", "sent", "overdue", "responded", "replied", "verified");

    private final SupervisionNoticeRepository supervisionNoticeRepository;
    private final ProjectAccessService access;
    private final AttachmentAccessService attachmentAccess;
    private final DiaryReferenceService diaryReferences;
    private final DiaryResourceResolver diaryResources;
    private final SupervisionDiaryRepository supervisionDiaryRepository;
    private final SubItemDatabaseRepository subItemDatabaseRepository;
    private final UserRepository userRepository;

    private SupervisionNotice locked(Long id) {
        SupervisionNotice record = (SupervisionNotice) diaryResources.load("supervision-notices", id, true);
        diaryResources.requireVisible("supervision-notices", record);
        return record;
    }

    public PageResult<SupervisionNotice> list(int pageNum, int pageSize, Long projectId, String code, String status) {
        pageNum = PageUtils.normalizePageNum(pageNum);
        pageSize = PageUtils.normalizePageSize(pageSize);
        Specification<SupervisionNotice> spec = (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            predicates.add(access.scope(root, cb));
            if (projectId != null) {
                predicates.add(cb.equal(root.get("projectId"), projectId));
            }
            if (code != null && !code.isEmpty()) {
                predicates.add(cb.like(root.get("code"), "%" + code + "%"));
            }
            if (status != null && !status.isEmpty()) {
                predicates.add(cb.equal(root.get("status"), status));
            } else {
                predicates.add(cb.notEqual(root.get("status"), "inactive"));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
        Page<SupervisionNotice> page = supervisionNoticeRepository.findAll(spec,
                PageRequest.of(pageNum - 1, pageSize, Sort.by(Sort.Direction.DESC, "createTime")));
        return new PageResult<>(page.getContent(), page.getTotalElements(), pageNum, pageSize);
    }

    public SupervisionNotice getById(Long id) {
        SupervisionNotice record = supervisionNoticeRepository.findById(id)
                .orElseThrow(() -> new BusinessException("监理通知不存在"));
        access.requireRead(record.getProjectId());
        fillRelatedDiary(record);
        fillDocumentDirectories(record);
        return record;
    }

    private Long resolveDiaryId(Long diaryId, Long projectId) {
        if (diaryId == null) return null;
        SupervisionDiary diary = supervisionDiaryRepository.findById(diaryId)
                .filter(item -> !"inactive".equals(item.getStatus()))
                .orElseThrow(() -> new BusinessException(400, "关联的监理日记不存在"));
        if (!java.util.Objects.equals(projectId, diary.getProjectId())) {
            throw new BusinessException(400, "只能关联同一项目的监理日记");
        }
        if (!"approved".equals(diary.getStatus())) {
            throw new BusinessException(400, "只能关联已审核通过的监理日记");
        }
        return diary.getId();
    }

    private List<Long> resolveDocumentDirectoryIds(List<Long> directoryIds, Long projectId) {
        if (directoryIds == null || directoryIds.isEmpty()) return new ArrayList<>();
        List<Long> ids = new ArrayList<>(new LinkedHashSet<>(directoryIds));
        if (ids.stream().anyMatch(java.util.Objects::isNull)) {
            throw new BusinessException(400, "工程资料目录ID不能为空");
        }
        List<SubItemDatabase> all = subItemDatabaseRepository.findByProjectId(projectId);
        Map<Long, SubItemDatabase> byId = all.stream().collect(Collectors.toMap(SubItemDatabase::getId, item -> item));
        for (Long id : ids) {
            SubItemDatabase selected = byId.get(id);
            if (selected == null || !"active".equals(selected.getStatus())) {
                throw new BusinessException(400, "工程资料目录不存在、已禁用或不属于当前项目");
            }
            boolean hasActiveChildren = all.stream().anyMatch(item -> "active".equals(item.getStatus())
                    && java.util.Objects.equals(id, item.getParentId()));
            if (hasActiveChildren) throw new BusinessException(400, "只能选择末级工程资料目录");
            Set<Long> visited = new LinkedHashSet<>();
            SubItemDatabase parent = selected;
            while (parent.getParentId() != null && visited.add(parent.getId())) {
                parent = byId.get(parent.getParentId());
                if (parent == null || !"active".equals(parent.getStatus())) {
                    throw new BusinessException(400, "工程资料目录的上级目录无效或已禁用");
                }
            }
        }
        return ids;
    }

    private void fillDocumentDirectories(SupervisionNotice record) {
        record.setDocumentDirectories(new ArrayList<>());
        if (record.getDocumentDirectoryIds() == null || record.getDocumentDirectoryIds().isEmpty()) return;
        List<SubItemDatabase> all = subItemDatabaseRepository.findByProjectId(record.getProjectId());
        Map<Long, SubItemDatabase> byId = all.stream().collect(Collectors.toMap(SubItemDatabase::getId, item -> item));
        List<Map<String, Object>> summaries = new ArrayList<>();
        for (Long id : record.getDocumentDirectoryIds()) {
            SubItemDatabase selected = byId.get(id);
            if (selected == null) continue;
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("id", selected.getId());
            summary.put("name", selected.getName());
            summary.put("path", documentDirectoryPath(selected, byId));
            summaries.add(summary);
        }
        record.setDocumentDirectories(summaries);
    }

    private String documentDirectoryPath(SubItemDatabase selected, Map<Long, SubItemDatabase> byId) {
        List<String> names = new ArrayList<>();
        Set<Long> visited = new LinkedHashSet<>();
        SubItemDatabase current = selected;
        while (current != null && visited.add(current.getId())) {
            names.add(current.getName());
            current = current.getParentId() == null ? null : byId.get(current.getParentId());
        }
        java.util.Collections.reverse(names);
        return String.join(" / ", names);
    }

    private void fillRelatedDiary(SupervisionNotice record) {
        record.setRelatedDiary(null);
        if (record.getRelatedDiaryId() == null) return;
        supervisionDiaryRepository.findById(record.getRelatedDiaryId())
                .filter(diary -> java.util.Objects.equals(record.getProjectId(), diary.getProjectId()))
                .ifPresent(diary -> {
                    Map<String, Object> summary = new LinkedHashMap<>();
                    summary.put("id", diary.getId());
                    summary.put("code", diary.getCode());
                    summary.put("diaryDate", diary.getDiaryDate());
                    summary.put("authorName", diary.getAuthorId() == null ? null : userRepository.findById(diary.getAuthorId())
                            .map(com.supervision.entity.User::getName).orElse(null));
                    summary.put("construction", diary.getConstruction());
                    record.setRelatedDiary(summary);
                });
    }

    public SupervisionNotice create(SupervisionNoticeDTO dto) {
        access.requireRead(dto.getProjectId());
        attachmentAccess.bind(dto.getProjectId(), dto.getPhotos(), dto.getAttachments());
        supervisionNoticeRepository.findByCode(dto.getCode())
                .filter(e -> !"inactive".equals(e.getStatus()))
                .ifPresent(e -> { throw new BusinessException("编号已存在"); });
        SupervisionNotice supervisionNotice = new SupervisionNotice();
        supervisionNotice.setCode(dto.getCode());
        supervisionNotice.setProjectId(dto.getProjectId());
        supervisionNotice.setNoticeDate(dto.getNoticeDate());
        supervisionNotice.setAuthorId(access.currentUser().getId());
        supervisionNotice.setTitle(dto.getTitle());
        supervisionNotice.setContent(dto.getContent());
        supervisionNotice.setDeadline(dto.getDeadline());
        supervisionNotice.setPriority(dto.getPriority());
        supervisionNotice.setPhotos(dto.getPhotos());
        supervisionNotice.setAttachments(dto.getAttachments());
        supervisionNotice.setRelatedDiaryId(resolveDiaryId(dto.getRelatedDiaryId(), dto.getProjectId()));
        supervisionNotice.setDocumentDirectoryIds(resolveDocumentDirectoryIds(dto.getDocumentDirectoryIds(), dto.getProjectId()));
        String initialStatus = dto.getStatus() != null ? dto.getStatus() : "draft";
        // 创建只允许草稿或直接下发；回复/验证等后续状态必须走对应业务流程，禁止创建即终态跳过审批流。
        if (!"draft".equals(initialStatus) && !"issued".equals(initialStatus)) {
            throw new BusinessException(400, "创建通知单仅允许 draft/issued 初始状态，当前状态请通过后续流程流转");
        }
        supervisionNotice.setStatus(initialStatus);
        return supervisionNoticeRepository.save(supervisionNotice);
    }

    public SupervisionNotice update(Long id, SupervisionNoticeDTO dto) {
        SupervisionNotice existing = locked(id);
        access.requireEdit(existing.getProjectId(), existing.getAuthorId());
        if (!java.util.Objects.equals(dto.getProjectId(), existing.getProjectId())) throw new BusinessException(400, "不可更换记录所属项目");
        attachmentAccess.bind(existing.getProjectId(), dto.getPhotos(), dto.getAttachments());
        // 正文锁定：已下发、已回复或已验证的单据正文不得覆盖，避免绕过审批流篡改既成事实。
        if (CONTENT_LOCKED_STATUSES.contains(existing.getStatus())
                && !java.util.Objects.equals(dto.getContent(), existing.getContent())) {
            throw new BusinessException(409, "已下发或已回复的通知单正文不可覆盖，如需修正请新建修订版本");
        }
        if (dto.getCode() != null && !dto.getCode().equals(existing.getCode())) {
            supervisionNoticeRepository.findByCode(dto.getCode())
                    .filter(e -> !"inactive".equals(e.getStatus()))
                    .ifPresent(e -> { throw new BusinessException("编号已存在"); });
        }
        existing.setCode(dto.getCode());
        existing.setProjectId(dto.getProjectId());
        existing.setNoticeDate(dto.getNoticeDate());
        existing.setTitle(dto.getTitle());
        existing.setContent(dto.getContent());
        existing.setDeadline(dto.getDeadline());
        existing.setPriority(dto.getPriority());
        existing.setPhotos(dto.getPhotos());
        existing.setAttachments(dto.getAttachments());
        existing.setRelatedDiaryId(resolveDiaryId(dto.getRelatedDiaryId(), existing.getProjectId()));
        existing.setDocumentDirectoryIds(resolveDocumentDirectoryIds(dto.getDocumentDirectoryIds(), existing.getProjectId()));
        // 状态流转白名单：只允许草稿→已下发、已下发→已逾期、已回复→已验证，其余跳转一律拒绝。
        if (dto.getStatus() != null && !dto.getStatus().equals(existing.getStatus())) {
            boolean allowed = ("draft".equals(existing.getStatus()) && "issued".equals(dto.getStatus()))
                    || ("issued".equals(existing.getStatus()) && "overdue".equals(dto.getStatus()))
                    || ("responded".equals(existing.getStatus()) && "verified".equals(dto.getStatus()));
            if (!allowed) {
                throw new BusinessException(409, "不允许的状态流转：" + existing.getStatus() + " → " + dto.getStatus());
            }
            existing.setStatus(dto.getStatus());
        }
        diaryReferences.invalidate("supervision-notices", existing, false);
        return supervisionNoticeRepository.save(existing);
    }

    @Transactional
    public void delete(Long id) {
        SupervisionNotice existing = locked(id);
        access.requireEdit(existing.getProjectId(), existing.getAuthorId());
        existing.setStatus("inactive");
        diaryReferences.invalidate("supervision-notices", existing, true);
        supervisionNoticeRepository.save(existing);
    }

    public SupervisionNotice reply(ReplyDTO dto) {
        SupervisionNotice existing = locked(dto.getId());
        if (!"issued".equals(existing.getStatus()) && !"overdue".equals(existing.getStatus())) {
            throw new BusinessException("只有已下发或已逾期状态的通知单才能回复");
        }
        existing.setReplyContent(dto.getReplyContent());
        existing.setReplyDate(LocalDate.now());
        existing.setStatus("responded");
        // 回复附件合并进 attachments（标记 source=reply），保证详情页可回显且下载走同一授权链。
        existing.setAttachments(attachmentAccess.bindReply(existing.getProjectId(), existing.getAttachments(), dto.getAttachments()));
        // 整改照片同样合并进 photos，避免前端已上传的照片提交后被丢弃。
        existing.setPhotos(attachmentAccess.mergeAttachments(existing.getProjectId(), existing.getPhotos(), dto.getPhotos(), "reply"));
        diaryReferences.invalidate("supervision-notices", existing, false);
        return supervisionNoticeRepository.save(existing);
    }

    public List<SupervisionNotice> findByStatus(String status) {
        return supervisionNoticeRepository.findAll((root, query, cb) -> cb.and(access.scope(root, cb), cb.equal(root.get("status"), status)));
    }
}
