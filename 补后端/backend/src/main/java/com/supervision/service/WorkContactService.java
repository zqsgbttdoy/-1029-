package com.supervision.service;

import com.supervision.common.PageResult;
import com.supervision.common.PageUtils;
import com.supervision.dto.ReplyDTO;
import com.supervision.dto.WorkContactDTO;
import com.supervision.entity.WorkContact;
import com.supervision.exception.BusinessException;
import com.supervision.repository.WorkContactRepository;
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
import java.util.List;

@Service
@Transactional
@AllArgsConstructor
public class WorkContactService {

    private static final java.util.Set<String> CONTENT_LOCKED_STATUSES =
            java.util.Set.of("issued", "sent", "overdue", "responded", "replied", "verified");

    private final WorkContactRepository workContactRepository;
    private final ProjectAccessService access;
    private final AttachmentAccessService attachmentAccess;

    public PageResult<WorkContact> list(int pageNum, int pageSize, Long projectId, String code, String status) {
        pageNum = PageUtils.normalizePageNum(pageNum);
        pageSize = PageUtils.normalizePageSize(pageSize);
        Specification<WorkContact> spec = (root, query, cb) -> {
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
        Page<WorkContact> page = workContactRepository.findAll(spec,
                PageRequest.of(pageNum - 1, pageSize, Sort.by(Sort.Direction.DESC, "createTime")));
        return new PageResult<>(page.getContent(), page.getTotalElements(), pageNum, pageSize);
    }

    public WorkContact getById(Long id) {
        WorkContact record = workContactRepository.findById(id)
                .orElseThrow(() -> new BusinessException("工作联系单不存在"));
        access.requireRead(record.getProjectId());
        return record;
    }

    public WorkContact create(WorkContactDTO dto) {
        access.requireRead(dto.getProjectId());
        attachmentAccess.bind(dto.getProjectId(), dto.getPhotos(), dto.getAttachments());
        workContactRepository.findByCode(dto.getCode())
                .filter(e -> !"inactive".equals(e.getStatus()))
                .ifPresent(e -> { throw new BusinessException("编号已存在"); });
        WorkContact workContact = new WorkContact();
        workContact.setCode(dto.getCode());
        workContact.setProjectId(dto.getProjectId());
        workContact.setContactDate(dto.getContactDate());
        workContact.setAuthorId(access.currentUser().getId());
        workContact.setTitle(dto.getTitle());
        workContact.setContent(dto.getContent());
        workContact.setPriority(dto.getPriority());
        workContact.setPhotos(dto.getPhotos());
        workContact.setAttachments(dto.getAttachments());
        String initialStatus = dto.getStatus() != null ? dto.getStatus() : "draft";
        // 创建只允许草稿或直接发送；回复/验证等后续状态必须走对应业务流程，禁止创建即终态跳过审批流。
        if (!"draft".equals(initialStatus) && !"sent".equals(initialStatus)) {
            throw new BusinessException(400, "创建工作联系单仅允许 draft/sent 初始状态，当前状态请通过后续流程流转");
        }
        workContact.setStatus(initialStatus);
        return workContactRepository.save(workContact);
    }

    public WorkContact update(Long id, WorkContactDTO dto) {
        WorkContact existing = getById(id);
        access.requireEdit(existing.getProjectId(), existing.getAuthorId());
        if (!java.util.Objects.equals(dto.getProjectId(), existing.getProjectId())) throw new BusinessException(400, "不可更换记录所属项目");
        attachmentAccess.bind(existing.getProjectId(), dto.getPhotos(), dto.getAttachments());
        // 正文锁定：已发送、已回复或已验证的单据正文不得覆盖，避免绕过审批流篡改既成事实。
        if (CONTENT_LOCKED_STATUSES.contains(existing.getStatus())
                && !java.util.Objects.equals(dto.getContent(), existing.getContent())) {
            throw new BusinessException(409, "已发送或已回复的联系单正文不可覆盖，如需修正请新建修订版本");
        }
        if (dto.getCode() != null && !dto.getCode().equals(existing.getCode())) {
            workContactRepository.findByCode(dto.getCode())
                    .filter(e -> !"inactive".equals(e.getStatus()))
                    .ifPresent(e -> { throw new BusinessException("编号已存在"); });
        }
        existing.setCode(dto.getCode());
        existing.setProjectId(dto.getProjectId());
        existing.setContactDate(dto.getContactDate());
        existing.setTitle(dto.getTitle());
        existing.setContent(dto.getContent());
        existing.setPriority(dto.getPriority());
        existing.setPhotos(dto.getPhotos());
        existing.setAttachments(dto.getAttachments());
        // 状态流转白名单：只允许草稿→已发送、已发送→已逾期、已回复→已验证，其余跳转一律拒绝。
        if (dto.getStatus() != null && !dto.getStatus().equals(existing.getStatus())) {
            boolean allowed = ("draft".equals(existing.getStatus()) && "sent".equals(dto.getStatus()))
                    || ("sent".equals(existing.getStatus()) && "overdue".equals(dto.getStatus()))
                    || ("replied".equals(existing.getStatus()) && "verified".equals(dto.getStatus()));
            if (!allowed) {
                throw new BusinessException(409, "不允许的状态流转：" + existing.getStatus() + " → " + dto.getStatus());
            }
            existing.setStatus(dto.getStatus());
        }
        return workContactRepository.save(existing);
    }

    @Transactional
    public void delete(Long id) {
        WorkContact existing = getById(id);
        access.requireEdit(existing.getProjectId(), existing.getAuthorId());
        existing.setStatus("inactive");
        workContactRepository.save(existing);
    }

    public WorkContact reply(ReplyDTO dto) {
        WorkContact existing = getById(dto.getId());
        if (!"sent".equals(existing.getStatus()) && !"overdue".equals(existing.getStatus())) {
            throw new BusinessException("只有已发送或已逾期状态的联系单才能回复");
        }
        existing.setReplyContent(dto.getReplyContent());
        existing.setReplyDate(LocalDate.now());
        existing.setStatus("replied");
        return workContactRepository.save(existing);
    }

    public List<WorkContact> findByStatus(String status) {
        return workContactRepository.findAll((root, query, cb) -> cb.and(access.scope(root, cb), cb.equal(root.get("status"), status)));
    }
}
