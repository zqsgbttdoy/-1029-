package com.supervision.controller;

import com.supervision.common.ApiResponse;
import com.supervision.common.PageResult;
import com.supervision.dto.SubItemDatabaseDTO;
import com.supervision.entity.SubItemDatabase;
import com.supervision.service.SubItemDatabaseService;
import jakarta.validation.Valid;
import lombok.AllArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/sub-item-databases")
@AllArgsConstructor
public class SubItemDatabaseController {

    private final SubItemDatabaseService subItemDatabaseService;

    @GetMapping
    public ApiResponse<PageResult<SubItemDatabase>> list(
            @RequestParam(defaultValue = "1") int pageNum,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) Long projectId,
            @RequestParam(required = false) String name,
            @RequestParam(required = false) String status) {
        return ApiResponse.success(subItemDatabaseService.list(pageNum, pageSize, projectId, name, status));
    }

    @GetMapping("/{id}")
    public ApiResponse<SubItemDatabase> getById(@PathVariable Long id) {
        return ApiResponse.success(subItemDatabaseService.getById(id));
    }

    @GetMapping("/{id}/attachment-sources")
    public ApiResponse<Map<String, Object>> getAttachmentSources(@PathVariable Long id) {
        return ApiResponse.success(subItemDatabaseService.getAttachmentSources(id));
    }

    @PostMapping
    public ApiResponse<SubItemDatabase> create(@Valid @RequestBody SubItemDatabaseDTO dto) {
        return ApiResponse.success(subItemDatabaseService.create(dto));
    }

    @PutMapping("/{id}")
    public ApiResponse<SubItemDatabase> update(@PathVariable Long id, @Valid @RequestBody SubItemDatabaseDTO dto) {
        return ApiResponse.success(subItemDatabaseService.update(id, dto));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        subItemDatabaseService.delete(id);
        return ApiResponse.success(null);
    }

    @GetMapping("/tree")
    public ApiResponse<List<Map<String, Object>>> getTree(@RequestParam Long projectId) {
        return ApiResponse.success(subItemDatabaseService.getTree(projectId));
    }
}
