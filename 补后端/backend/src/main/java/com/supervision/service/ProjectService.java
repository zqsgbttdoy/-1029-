package com.supervision.service;

import com.supervision.common.PageResult;
import com.supervision.common.PageUtils;
import com.supervision.dto.ProjectDTO;
import com.supervision.entity.Project;
import com.supervision.exception.BusinessException;
import com.supervision.repository.ProjectRepository;
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
public class ProjectService {

    private final ProjectRepository projectRepository;
    private final ProjectAccessService projectAccess;

    public PageResult<Project> list(int pageNum, int pageSize, String name, String code, String type, String status) {
        pageNum = PageUtils.normalizePageNum(pageNum);
        pageSize = PageUtils.normalizePageSize(pageSize);
        java.util.List<Long> allowedIds = projectAccess.projectIds(false);
        Specification<Project> spec = (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            predicates.add(allowedIds.isEmpty() ? cb.disjunction() : root.get("id").in(allowedIds));
            if (name != null && !name.isEmpty()) {
                predicates.add(cb.like(root.get("name"), "%" + name + "%"));
            }
            if (code != null && !code.isEmpty()) {
                predicates.add(cb.like(root.get("code"), "%" + code + "%"));
            }
            if (type != null && !type.isEmpty()) {
                predicates.add(cb.equal(root.get("type"), type));
            }
            if (status != null && !status.isEmpty()) {
                predicates.add(cb.equal(root.get("status"), status));
            } else {
                predicates.add(cb.notEqual(root.get("status"), "inactive"));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
        Page<Project> page = projectRepository.findAll(spec,
                PageRequest.of(pageNum - 1, pageSize, Sort.by(Sort.Direction.DESC, "createTime")));
        return new PageResult<>(page.getContent(), page.getTotalElements(), pageNum, pageSize);
    }

    public Project getById(Long id) {
        projectAccess.requireRead(id);
        Project project = projectRepository.findById(id)
                .orElseThrow(() -> new BusinessException("项目不存在"));
        // 软删除（status=inactive）的项目对外视为不存在，防止已删项目仍可被查询/恢复
        if ("inactive".equals(project.getStatus())) {
            throw new BusinessException("项目不存在");
        }
        return project;
    }

    public Project create(ProjectDTO dto) {
        projectAccess.requireAdmin();
        projectRepository.findByCode(dto.getCode())
                .filter(e -> !"inactive".equals(e.getStatus()))
                .ifPresent(e -> { throw new BusinessException("项目编号已存在"); });
        Project project = new Project();
        project.setName(dto.getName());
        project.setCode(dto.getCode());
        project.setBuildUnit(dto.getBuildUnit());
        project.setAddress(dto.getAddress());
        project.setType(dto.getType());
        project.setStartDate(dto.getStartDate());
        project.setEndDate(dto.getEndDate());
        project.setDescription(dto.getDescription());
        project.setManagerId(dto.getManagerId());
        project.setStatus(dto.getStatus() == null ? "active" : dto.getStatus());
        return projectRepository.save(project);
    }

    @Transactional
    public Project update(Long id, ProjectDTO dto) {
        projectAccess.requireAdmin();
        Project existing = getById(id);
        existing.setName(dto.getName());
        existing.setCode(dto.getCode());
        existing.setBuildUnit(dto.getBuildUnit());
        existing.setAddress(dto.getAddress());
        existing.setType(dto.getType());
        existing.setStartDate(dto.getStartDate());
        existing.setEndDate(dto.getEndDate());
        existing.setDescription(dto.getDescription());
        existing.setManagerId(dto.getManagerId());
        // 旧客户端未携带状态时保留原值；表单提供的新状态必须随其他字段一起保存。
        if (dto.getStatus() != null) existing.setStatus(dto.getStatus());
        return projectRepository.save(existing);
    }

    @Transactional
    public void delete(Long id) {
        projectAccess.requireAdmin();
        Project existing = getById(id);
        existing.setStatus("inactive");
        projectRepository.save(existing);
    }

    public List<Project> findByStatus(String status) {
        java.util.List<Long> ids = projectAccess.projectIds(false);
        return projectRepository.findByStatus(status).stream().filter(p -> ids.contains(p.getId())).toList();
    }

    public void updateStatus(Long id, String status) {
        projectAccess.requireAdmin();
        Project existing = getById(id);
        existing.setStatus(status);
        projectRepository.save(existing);
    }
}
