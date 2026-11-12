package com.supervision.service;

import com.supervision.common.PageResult;
import com.supervision.common.PageUtils;
import com.supervision.dto.ApproveDTO;
import com.supervision.dto.SupervisionLogDTO;
import com.supervision.entity.SupervisionLog;
import com.supervision.exception.BusinessException;
import com.supervision.repository.SupervisionLogRepository;
import jakarta.persistence.criteria.Predicate;
import lombok.AllArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;

@Service
@AllArgsConstructor
public class SupervisionLogService {

    private final SupervisionLogRepository supervisionLogRepository;

    public PageResult<SupervisionLog> list(int pageNum, int pageSize, Long projectId, String code, String status) {
        pageNum = PageUtils.normalizePageNum(pageNum);
        // 统计页需一次拉取全量数据做聚合，使用放宽的统计上限（2000）
        pageSize = PageUtils.normalizePageSizeForStats(pageSize);
        Specification<SupervisionLog> spec = (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
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
        Page<SupervisionLog> page = supervisionLogRepository.findAll(spec,
                PageRequest.of(pageNum - 1, pageSize, Sort.by(Sort.Direction.DESC, "createTime")));
        return new PageResult<>(page.getContent(), page.getTotalElements(), pageNum, pageSize);
    }

    public SupervisionLog getById(Long id) {
        return supervisionLogRepository.findById(id)
                .orElseThrow(() -> new BusinessException("监理日志不存在"));
    }

    public SupervisionLog create(SupervisionLogDTO dto) {
        supervisionLogRepository.findByCode(dto.getCode())
                .filter(e -> !"inactive".equals(e.getStatus()))
                .ifPresent(e -> { throw new BusinessException("编号已存在"); });
        SupervisionLog supervisionLog = new SupervisionLog();
        supervisionLog.setCode(dto.getCode());
        supervisionLog.setProjectId(dto.getProjectId());
        supervisionLog.setLogDate(dto.getLogDate());
        supervisionLog.setWeekStart(dto.getWeekStart());
        supervisionLog.setWeekEnd(dto.getWeekEnd());
        supervisionLog.setAuthorId(dto.getAuthorId());
        supervisionLog.setParticipants(dto.getParticipants());
        supervisionLog.setWeather(dto.getWeather());
        supervisionLog.setWind(dto.getWind());
        supervisionLog.setTemperature(dto.getTemperature());
        supervisionLog.setContent(dto.getContent());
        supervisionLog.setManagement(dto.getManagement());
        supervisionLog.setInspection(dto.getInspection());
        supervisionLog.setMorningMeeting(dto.getMorningMeeting());
        supervisionLog.setDrawingReview(dto.getDrawingReview());
        supervisionLog.setOtherMatters(dto.getOtherMatters());
        supervisionLog.setPhotos(dto.getPhotos());
        supervisionLog.setAttachments(dto.getAttachments());
        supervisionLog.setStatus("draft");
        supervisionLog.setVersion(1);
        return supervisionLogRepository.save(supervisionLog);
    }

    public SupervisionLog update(Long id, SupervisionLogDTO dto) {
        SupervisionLog existing = getById(id);
        if (dto.getCode() != null && !dto.getCode().equals(existing.getCode())) {
            supervisionLogRepository.findByCode(dto.getCode())
                    .filter(e -> !"inactive".equals(e.getStatus()))
                    .ifPresent(e -> { throw new BusinessException("编号已存在"); });
        }
        existing.setCode(dto.getCode());
        existing.setProjectId(dto.getProjectId());
        existing.setLogDate(dto.getLogDate());
        existing.setWeekStart(dto.getWeekStart());
        existing.setWeekEnd(dto.getWeekEnd());
        existing.setAuthorId(dto.getAuthorId());
        existing.setParticipants(dto.getParticipants());
        existing.setWeather(dto.getWeather());
        existing.setWind(dto.getWind());
        existing.setTemperature(dto.getTemperature());
        existing.setContent(dto.getContent());
        existing.setManagement(dto.getManagement());
        existing.setInspection(dto.getInspection());
        existing.setMorningMeeting(dto.getMorningMeeting());
        existing.setDrawingReview(dto.getDrawingReview());
        existing.setOtherMatters(dto.getOtherMatters());
        existing.setPhotos(dto.getPhotos());
        existing.setAttachments(dto.getAttachments());
        return supervisionLogRepository.save(existing);
    }

    @Transactional
    public void delete(Long id) {
        SupervisionLog existing = getById(id);
        existing.setStatus("inactive");
        supervisionLogRepository.save(existing);
    }

    @Transactional
    public SupervisionLog approve(ApproveDTO dto) {
        if (dto.getStatus() == null) {
            throw new BusinessException("审核状态不能为空");
        }
        SupervisionLog existing = getById(dto.getId());
        if (!"draft".equals(existing.getStatus()) && !"submitted".equals(existing.getStatus())) {
            throw new BusinessException("只有草稿或已提交状态的日志才能审批");
        }
        if ("approved".equals(dto.getStatus())) {
            existing.setStatus("approved");
            existing.setRejectReason(null);
        } else if ("rejected".equals(dto.getStatus())) {
            existing.setStatus("rejected");
            existing.setRejectReason(dto.getRejectReason());
        }
        return supervisionLogRepository.save(existing);
    }

    public SupervisionLog newVersion(Long id) {
        SupervisionLog existing = getById(id);
        SupervisionLog newVer = new SupervisionLog();
        newVer.setCode(existing.getCode());
        newVer.setProjectId(existing.getProjectId());
        newVer.setLogDate(existing.getLogDate());
        newVer.setWeekStart(existing.getWeekStart());
        newVer.setWeekEnd(existing.getWeekEnd());
        newVer.setAuthorId(existing.getAuthorId());
        newVer.setParticipants(existing.getParticipants());
        newVer.setWeather(existing.getWeather());
        newVer.setWind(existing.getWind());
        newVer.setTemperature(existing.getTemperature());
        newVer.setContent(existing.getContent());
        newVer.setManagement(existing.getManagement());
        newVer.setInspection(existing.getInspection());
        newVer.setMorningMeeting(existing.getMorningMeeting());
        newVer.setDrawingReview(existing.getDrawingReview());
        newVer.setOtherMatters(existing.getOtherMatters());
        newVer.setPhotos(existing.getPhotos());
        newVer.setAttachments(existing.getAttachments());
        newVer.setStatus("draft");
        newVer.setVersion(existing.getVersion() + 1);
        return supervisionLogRepository.save(newVer);
    }

    public List<SupervisionLog> findByProjectId(Long projectId) {
        return supervisionLogRepository.findByProjectId(projectId);
    }
}
