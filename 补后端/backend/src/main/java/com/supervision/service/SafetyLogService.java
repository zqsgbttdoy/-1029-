package com.supervision.service;

import com.supervision.common.PageResult;
import com.supervision.common.PageUtils;
import com.supervision.dto.ApproveDTO;
import com.supervision.dto.SafetyLogDTO;
import com.supervision.entity.SafetyLog;
import com.supervision.entity.User;
import com.supervision.exception.BusinessException;
import com.supervision.repository.SafetyLogRepository;
import jakarta.persistence.criteria.Predicate;
import lombok.AllArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

@Service
@Transactional
@AllArgsConstructor
public class SafetyLogService {

    private final SafetyLogRepository safetyLogRepository;
    private final ProjectAccessService access;
    private final AttachmentAccessService attachmentAccess;

    public PageResult<SafetyLog> list(int pageNum, int pageSize, Long projectId, String code, String status) {
        pageNum = PageUtils.normalizePageNum(pageNum);
        // 统计页需一次拉取全量数据做聚合，使用放宽的统计上限（2000）
        pageSize = PageUtils.normalizePageSizeForStats(pageSize);
        Specification<SafetyLog> spec = (root, query, cb) -> {
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
        Page<SafetyLog> page = safetyLogRepository.findAll(spec,
                PageRequest.of(pageNum - 1, pageSize, Sort.by(Sort.Direction.DESC, "createTime")));
        return new PageResult<>(page.getContent(), page.getTotalElements(), pageNum, pageSize);
    }

    /**
     * Word 导出专用查询：与列表同等的项目数据权限与筛选条件，但不分页，
     * 由调用方一次性取齐（limit 用于限制单次导出体量，避免超大文档拖垮服务）。
     */
    public List<SafetyLog> listForExport(Long projectId, String code, String status,
                                         LocalDate dateFrom, LocalDate dateTo, int limit) {
        int max = Math.max(1, limit);
        Specification<SafetyLog> spec = (root, query, cb) -> {
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
            if (dateFrom != null) {
                predicates.add(cb.greaterThanOrEqualTo(root.get("logDate"), dateFrom));
            }
            if (dateTo != null) {
                predicates.add(cb.lessThanOrEqualTo(root.get("logDate"), dateTo));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
        Sort sort = Sort.by(Sort.Direction.DESC, "logDate").and(Sort.by(Sort.Direction.DESC, "createTime"));
        return safetyLogRepository.findAll(spec, PageRequest.of(0, max, sort)).getContent();
    }

    public SafetyLog getById(Long id) {
        SafetyLog record = safetyLogRepository.findById(id)
                .orElseThrow(() -> new BusinessException("安全日志不存在"));
        access.requireRead(record.getProjectId());
        return record;
    }

    public SafetyLog create(SafetyLogDTO dto) {
        access.requireRead(dto.getProjectId());
        attachmentAccess.bind(dto.getProjectId(), dto.getPhotos(), dto.getAttachments());
        safetyLogRepository.findByCode(dto.getCode())
                .filter(e -> !"inactive".equals(e.getStatus()))
                .ifPresent(e -> { throw new BusinessException("编号已存在"); });
        SafetyLog safetyLog = new SafetyLog();
        safetyLog.setCode(dto.getCode());
        safetyLog.setProjectId(dto.getProjectId());
        safetyLog.setLogDate(dto.getLogDate());
        safetyLog.setAuthorId(access.currentUser().getId());
        safetyLog.setWeather(dto.getWeather());
        safetyLog.setWind(dto.getWind());
        safetyLog.setTemperature(dto.getTemperature());
        safetyLog.setContent(dto.getContent());
        safetyLog.setInspection(dto.getInspection());
        safetyLog.setSafety(dto.getSafety());
        safetyLog.setMajorIssue(dto.getMajorIssue());
        safetyLog.setPhotos(dto.getPhotos());
        safetyLog.setAttachments(dto.getAttachments());
        safetyLog.setStatus("draft");
        safetyLog.setVersion(1);
        return safetyLogRepository.save(safetyLog);
    }

    public SafetyLog update(Long id, SafetyLogDTO dto) {
        SafetyLog existing = getById(id);
        access.requireEdit(existing.getProjectId(), existing.getAuthorId());
        if ("approved".equals(existing.getStatus())) {
            throw new BusinessException(409, "已批准的安全日志正文不可覆盖，如需修正请新建修订版本");
        }
        if (!java.util.Objects.equals(dto.getProjectId(), existing.getProjectId())) throw new BusinessException(400, "不可更换记录所属项目");
        attachmentAccess.bind(existing.getProjectId(), dto.getPhotos(), dto.getAttachments());
        if (dto.getCode() != null && !dto.getCode().equals(existing.getCode())) {
            safetyLogRepository.findByCode(dto.getCode())
                    .filter(e -> !"inactive".equals(e.getStatus()))
                    .ifPresent(e -> { throw new BusinessException("编号已存在"); });
        }
        existing.setCode(dto.getCode());
        existing.setProjectId(dto.getProjectId());
        existing.setLogDate(dto.getLogDate());
        existing.setWeather(dto.getWeather());
        existing.setWind(dto.getWind());
        existing.setTemperature(dto.getTemperature());
        existing.setContent(dto.getContent());
        existing.setInspection(dto.getInspection());
        existing.setSafety(dto.getSafety());
        existing.setMajorIssue(dto.getMajorIssue());
        existing.setPhotos(dto.getPhotos());
        existing.setAttachments(dto.getAttachments());
        boolean submitting = "submitted".equals(dto.getStatus()) && !"submitted".equals(existing.getStatus());
        applyStatusTransition(existing, dto.getStatus());
        if (submitting) {
            // 提交即留痕：导出件的“整改闭环”板块依据提交/审核时间与审核人还原流转链路。
            existing.setSubmittedAt(LocalDateTime.now());
            User submitter = access.currentUser();
            if (submitter != null) existing.setSubmittedBy(submitter.getName());
        }
        return safetyLogRepository.save(existing);
    }

    /**
     * 更新接口的状态流转白名单：仅允许提交（draft→submitted）与整回（submitted→draft）；
     * 审批终态（approved/rejected/inactive）必须走审批/删除专用接口，防止绕过审批流直改状态。
     */
    private void applyStatusTransition(SafetyLog existing, String requested) {
        if (requested == null || requested.isBlank() || requested.equals(existing.getStatus())) {
            return;
        }
        if ("approved".equals(requested) || "rejected".equals(requested) || "inactive".equals(requested)) {
            throw new BusinessException(400, "审批与删除状态请通过对应专用接口变更");
        }
        if ("submitted".equals(requested)) {
            existing.setStatus("submitted");
        } else if ("draft".equals(requested)) {
            existing.setStatus("draft");
        } else {
            throw new BusinessException(400, "不支持的状态流转：" + requested);
        }
    }

    @Transactional
    public void delete(Long id) {
        SafetyLog existing = getById(id);
        access.requireEdit(existing.getProjectId(), existing.getAuthorId());
        existing.setStatus("inactive");
        safetyLogRepository.save(existing);
    }

    @Transactional
    public SafetyLog approve(ApproveDTO dto) {
        if (dto.getStatus() == null) {
            throw new BusinessException("审核状态不能为空");
        }
        SafetyLog existing = getById(dto.getId());
        access.requireReview(existing.getProjectId());
        if (!"submitted".equals(existing.getStatus())) {
            // 草稿未提交不得审批（409）；已批准/已驳回等终态重复审批同样 409。
            throw new BusinessException(409, "只有已提交状态的安全日志才能审批");
        }
        if ("approved".equals(dto.getStatus())) {
            existing.setStatus("approved");
            existing.setRejectReason(null);
            existing.setRejectedAt(null);
            existing.setRejectedBy(null);
        } else if ("rejected".equals(dto.getStatus())) {
            existing.setStatus("rejected");
            existing.setRejectReason(dto.getRejectReason());
            existing.setRejectedAt(LocalDateTime.now());
        }
        // 审核留痕：审核人与审核时间写入记录，供台账与 Word 导出还原闭环链路。
        existing.setReviewedAt(LocalDateTime.now());
        User reviewer = access.currentUser();
        if (reviewer != null) {
            existing.setReviewerId(reviewer.getId());
            if ("rejected".equals(dto.getStatus())) existing.setRejectedBy(reviewer.getName());
        }
        return safetyLogRepository.save(existing);
    }

    public SafetyLog newVersion(Long id) {
        SafetyLog existing = getById(id);
        SafetyLog newVer = new SafetyLog();
        newVer.setCode(existing.getCode());
        newVer.setProjectId(existing.getProjectId());
        newVer.setLogDate(existing.getLogDate());
        newVer.setAuthorId(access.currentUser().getId());
        newVer.setWeather(existing.getWeather());
        newVer.setWind(existing.getWind());
        newVer.setTemperature(existing.getTemperature());
        newVer.setContent(existing.getContent());
        newVer.setInspection(existing.getInspection());
        newVer.setSafety(existing.getSafety());
        newVer.setMajorIssue(existing.getMajorIssue());
        newVer.setPhotos(existing.getPhotos());
        newVer.setAttachments(existing.getAttachments());
        newVer.setStatus("draft");
        newVer.setVersion(existing.getVersion() + 1);
        return safetyLogRepository.save(newVer);
    }

    public List<SafetyLog> findByProjectId(Long projectId) {
        access.requireRead(projectId);
        return safetyLogRepository.findByProjectId(projectId);
    }
}
