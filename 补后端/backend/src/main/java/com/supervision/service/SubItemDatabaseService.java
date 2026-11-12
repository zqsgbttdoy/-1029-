package com.supervision.service;

import com.supervision.common.PageResult;
import com.supervision.common.PageUtils;
import com.supervision.dto.SubItemDatabaseDTO;
import com.supervision.entity.SubItemDatabase;
import com.supervision.exception.BusinessException;
import com.supervision.repository.SubItemDatabaseRepository;
import jakarta.persistence.criteria.Predicate;
import lombok.AllArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
@AllArgsConstructor
public class SubItemDatabaseService {

    private final SubItemDatabaseRepository subItemDatabaseRepository;
    private final ProjectAccessService access;
    private final DirectoryAttachmentTraceService attachmentTraces;

    public PageResult<SubItemDatabase> list(int pageNum, int pageSize, Long projectId, String name, String status) {
        pageNum = PageUtils.normalizePageNum(pageNum);
        pageSize = PageUtils.normalizePageSize(pageSize);
        Specification<SubItemDatabase> spec = (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            // 目录属于项目数据，按当前用户可见项目范围过滤，禁止跨项目读取。
            predicates.add(access.scope(root, cb));
            if (projectId != null) {
                predicates.add(cb.equal(root.get("projectId"), projectId));
            }
            if (name != null && !name.isEmpty()) {
                predicates.add(cb.like(root.get("name"), "%" + name + "%"));
            }
            if (status != null && !status.isEmpty()) {
                predicates.add(cb.equal(root.get("status"), status));
            } else {
                predicates.add(cb.notEqual(root.get("status"), "inactive"));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
        Page<SubItemDatabase> page = subItemDatabaseRepository.findAll(spec,
                PageRequest.of(pageNum - 1, pageSize, Sort.by(Sort.Direction.ASC, "sortOrder")));
        return new PageResult<>(page.getContent(), page.getTotalElements(), pageNum, pageSize);
    }

    public SubItemDatabase getById(Long id) {
        SubItemDatabase record = subItemDatabaseRepository.findById(id)
                .orElseThrow(() -> new BusinessException("子项数据库记录不存在"));
        access.requireRead(record.getProjectId());
        return record;
    }

    public SubItemDatabase create(SubItemDatabaseDTO dto) {
        access.requireRead(dto.getProjectId());
        SubItemDatabase subItemDatabase = new SubItemDatabase();
        subItemDatabase.setProjectId(dto.getProjectId());
        subItemDatabase.setName(dto.getName());
        subItemDatabase.setParentId(dto.getParentId());
        subItemDatabase.setSortOrder(dto.getSortOrder());
        subItemDatabase.setDescription(dto.getDescription());
        subItemDatabase.setStatus("active");
        return subItemDatabaseRepository.save(subItemDatabase);
    }

    public SubItemDatabase update(Long id, SubItemDatabaseDTO dto) {
        SubItemDatabase existing = getById(id);
        existing.setProjectId(dto.getProjectId());
        existing.setName(dto.getName());
        existing.setParentId(dto.getParentId());
        existing.setSortOrder(dto.getSortOrder());
        existing.setDescription(dto.getDescription());
        return subItemDatabaseRepository.save(existing);
    }

    @Transactional
    public void delete(Long id) {
        SubItemDatabase existing = getById(id);
        existing.setStatus("inactive");
        subItemDatabaseRepository.save(existing);
    }

    public List<Map<String, Object>> getTree(Long projectId) {
        access.requireRead(projectId);
        List<SubItemDatabase> all = subItemDatabaseRepository.findByProjectId(projectId);
        Map<Long, Map<String, Object>> stats = attachmentTraces.treeStats(all);
        return buildTree(all, null, stats);
    }

    public Map<String, Object> getAttachmentSources(Long id) {
        SubItemDatabase selected = getById(id);
        return attachmentTraces.detail(selected, subItemDatabaseRepository.findByProjectId(selected.getProjectId()));
    }

    private List<Map<String, Object>> buildTree(List<SubItemDatabase> all, Long parentId, Map<Long, Map<String, Object>> stats) {
        List<Map<String, Object>> tree = new ArrayList<>();
        for (SubItemDatabase item : all) {
            if ((parentId == null && item.getParentId() == null) ||
                    (parentId != null && parentId.equals(item.getParentId()))) {
                Map<String, Object> node = new HashMap<>();
                node.put("id", item.getId());
                node.put("projectId", item.getProjectId());
                node.put("name", item.getName());
                node.put("parentId", item.getParentId());
                node.put("sortOrder", item.getSortOrder());
                node.put("description", item.getDescription());
                node.put("status", item.getStatus());
                node.putAll(stats.getOrDefault(item.getId(), Map.of(
                        "attachmentCount", 0, "recordCount", 0, "sourceDistribution", List.of())));
                node.put("children", buildTree(all, item.getId(), stats));
                tree.add(node);
            }
        }
        return tree;
    }
}
