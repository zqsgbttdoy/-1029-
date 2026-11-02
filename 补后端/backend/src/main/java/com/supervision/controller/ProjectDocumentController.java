package com.supervision.controller;

import com.supervision.common.ApiResponse;
import com.supervision.common.PageResult;
import com.supervision.dto.ProjectDocumentDTO;
import com.supervision.entity.ProjectDocument;
import com.supervision.service.ProjectDocumentService;
import jakarta.validation.Valid;
import lombok.AllArgsConstructor;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/project-documents")
@AllArgsConstructor
public class ProjectDocumentController {

    private final ProjectDocumentService projectDocumentService;
    private final com.supervision.service.DiaryReferenceService diaryReferences;

    @GetMapping("/{id}/diary-references")
    public ApiResponse<?> references(@PathVariable Long id, @RequestParam(defaultValue = "1") int pageNum,
                                     @RequestParam(defaultValue = "20") int pageSize) {
        return ApiResponse.success(diaryReferences.references(id, pageNum, pageSize));
    }

    @GetMapping
    public ApiResponse<PageResult<ProjectDocument>> list(
            @RequestParam(defaultValue = "1") int pageNum,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) Long projectId,
            @RequestParam(required = false) Long subItemId,
            @RequestParam(required = false) String name) {
        return ApiResponse.success(projectDocumentService.list(pageNum, pageSize, projectId, subItemId, name));
    }

    @GetMapping("/{id}")
    public ApiResponse<ProjectDocument> getById(@PathVariable Long id) {
        return ApiResponse.success(projectDocumentService.getById(id));
    }

    @PostMapping
    public ApiResponse<ProjectDocument> create(@Valid @RequestBody ProjectDocumentDTO dto) {
        return ApiResponse.success(projectDocumentService.create(dto));
    }

    @PutMapping("/{id}")
    public ApiResponse<ProjectDocument> update(@PathVariable Long id, @Valid @RequestBody ProjectDocumentDTO dto) {
        return ApiResponse.success(projectDocumentService.update(id, dto));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        projectDocumentService.delete(id);
        return ApiResponse.success(null);
    }

    @PostMapping("/upload")
    public ApiResponse<ProjectDocument> upload(
            @RequestParam Long projectId,
            @RequestParam Long subItemId,
            @RequestParam MultipartFile file) {
        return ApiResponse.success(projectDocumentService.upload(projectId, subItemId, file));
    }
}
