package com.supervision.service;

import com.supervision.common.PageResult;
import com.supervision.common.PageUtils;
import com.supervision.dto.ProjectDocumentDTO;
import com.supervision.entity.ProjectDocument;
import com.supervision.exception.BusinessException;
import com.supervision.repository.ProjectDocumentRepository;
import jakarta.persistence.criteria.Predicate;
import lombok.AllArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

@Service
@Transactional
@AllArgsConstructor
public class ProjectDocumentService {

    private final ProjectDocumentRepository projectDocumentRepository;
    private final ProjectAccessService access;
    private final AttachmentAccessService attachmentAccess;
    private final FileStorageService storage;
    private final com.supervision.repository.SubItemDatabaseRepository subItems;
    private final DiaryReferenceService diaryReferences;
    private final DiaryResourceResolver diaryResources;
    private final DiaryAttachmentService diaryAttachments;

    private void validateSubItem(Long projectId, Long subItemId) {
        if (subItemId == null) throw new BusinessException(400, "请选择资料所属子项");
        var item = subItems.findById(subItemId).orElseThrow(() -> new BusinessException(400, "资料子项不存在"));
        if (!projectId.equals(item.getProjectId()) || "inactive".equals(item.getStatus()))
            throw new BusinessException(400, "资料子项不属于当前项目或已停用");
    }

    public PageResult<ProjectDocument> list(int pageNum, int pageSize, Long projectId, Long subItemId, String name,
                                            String diaryFilter) {
        pageNum = PageUtils.normalizePageNum(pageNum);
        pageSize = PageUtils.normalizePageSize(pageSize);
        if (diaryFilter != null && !diaryFilter.isBlank() && !java.util.Set.of("linked", "unlinked").contains(diaryFilter))
            throw new BusinessException(400, "日记关联筛选条件无效");
        Specification<ProjectDocument> spec = (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            predicates.add(access.scope(root, cb));
            if (projectId != null) {
                predicates.add(cb.equal(root.get("projectId"), projectId));
            }
            if (subItemId != null) {
                predicates.add(cb.equal(root.get("subItemId"), subItemId));
            }
            if (name != null && !name.isEmpty()) {
                predicates.add(cb.like(root.get("name"), "%" + name + "%"));
            }
            if ("linked".equals(diaryFilter)) predicates.add(cb.isNotNull(root.get("diaryId")));
            if ("unlinked".equals(diaryFilter)) predicates.add(cb.isNull(root.get("diaryId")));
            return cb.and(predicates.toArray(new Predicate[0]));
        };
        Page<ProjectDocument> page = projectDocumentRepository.findAll(spec,
                PageRequest.of(pageNum - 1, pageSize, Sort.by(Sort.Direction.DESC, "createTime")));
        diaryReferences.fillCounts(page.getContent());
        diaryAttachments.fillDocumentMetadata(page.getContent());
        return new PageResult<>(page.getContent(), page.getTotalElements(), pageNum, pageSize);
    }

    public ProjectDocument getById(Long id) {
        ProjectDocument record = projectDocumentRepository.findById(id)
                .orElseThrow(() -> new BusinessException("项目文档不存在"));
        access.requireRead(record.getProjectId());
        diaryReferences.fillCounts(List.of(record));
        diaryAttachments.fillDocumentMetadata(List.of(record));
        return record;
    }

    public ProjectDocument create(ProjectDocumentDTO dto) {
        access.requireRead(dto.getProjectId());
        String url = attachmentAccess.bindDocument(dto.getProjectId(), dto.getFilePath());
        validateSubItem(dto.getProjectId(), dto.getSubItemId());
        ProjectDocument projectDocument = new ProjectDocument();
        projectDocument.setUploaderId(access.currentUser().getId());
        projectDocument.setProjectId(dto.getProjectId());
        projectDocument.setSubItemId(dto.getSubItemId());
        projectDocument.setName(dto.getName());
        projectDocument.setFilePath(url);
        projectDocument.setFileSize(dto.getFileSize());
        projectDocument.setDescription(dto.getDescription());
        projectDocument.setUploadDate(LocalDate.now());
        return projectDocumentRepository.save(projectDocument);
    }

    private ProjectDocument locked(Long id) {
        ProjectDocument record = (ProjectDocument) diaryResources.load("project-documents", id, true);
        diaryResources.requireVisible("project-documents", record);
        return record;
    }

    public ProjectDocument update(Long id, ProjectDocumentDTO dto) {
        ProjectDocument existing = locked(id);
        access.requireEdit(existing.getProjectId(), existing.getUploaderId());
        if (!java.util.Objects.equals(existing.getProjectId(), dto.getProjectId())) throw new BusinessException(400, "不可更换资料所属项目");
        String url = attachmentAccess.bindDocument(existing.getProjectId(), dto.getFilePath());
        validateSubItem(existing.getProjectId(), dto.getSubItemId());
        existing.setProjectId(dto.getProjectId());
        existing.setSubItemId(dto.getSubItemId());
        existing.setName(dto.getName());
        existing.setFilePath(url);
        existing.setFileSize(dto.getFileSize());
        existing.setDescription(dto.getDescription());
        diaryReferences.invalidate("project-documents", existing, false);
        return projectDocumentRepository.save(existing);
    }

    @Transactional
    public void delete(Long id) {
        ProjectDocument existing = projectDocumentRepository.findById(id)
                .orElseThrow(() -> new BusinessException(404, "项目文档不存在"));
        diaryResources.requireVisible("project-documents", existing);
        access.requireEdit(existing.getProjectId(), existing.getUploaderId());
        existing = diaryAttachments.prepareDocumentDelete(id);
        diaryReferences.invalidate("project-documents", existing, true);
        projectDocumentRepository.delete(existing);
    }

    public ProjectDocument upload(Long projectId, Long subItemId, MultipartFile file) {
        access.requireRead(projectId);
        validateSubItem(projectId, subItemId);
        java.util.Map<String, Object> uploaded = storage.upload(file);
        ProjectDocumentDTO dto = new ProjectDocumentDTO();
        dto.setProjectId(projectId);
        dto.setSubItemId(subItemId);
        dto.setName((String) uploaded.get("name"));
        dto.setFilePath((String) uploaded.get("url"));
        dto.setFileSize(file.getSize());
        return create(dto);
    }

    public List<ProjectDocument> findByProjectId(Long projectId) {
        access.requireRead(projectId);
        return projectDocumentRepository.findByProjectId(projectId);
    }
}
