package com.supervision.controller;

import com.supervision.common.*;
import com.supervision.dto.ApproveDTO;
import com.supervision.entity.*;
import com.supervision.service.FieldRecordService;
import jakarta.validation.Valid;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;
import java.time.LocalDate;
import java.util.*;

/** 继承端点保持既有四类 API 路径不变，统一提交和并发契约。 */
public abstract class FieldRecordController {
    private final FieldRecordService records;
    private final FieldRecordKind kind;

    protected FieldRecordController(FieldRecordService records, FieldRecordKind kind) {
        this.records = records;
        this.kind = kind;
    }

    @GetMapping
    public ApiResponse<?> list(@RequestParam(defaultValue = "1") int pageNum,
                              @RequestParam(defaultValue = "20") int pageSize,
                              @RequestParam(required = false) Long projectId,
                              @RequestParam(required = false) String code,
                              @RequestParam(required = false) String status,
                              @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate dateFrom,
                              @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate dateTo,
                              @RequestParam(required = false) Long authorId) {
        return ApiResponse.success(records.list(kind, pageNum, pageSize, projectId, code, status, dateFrom, dateTo, authorId));
    }

    @GetMapping("/{id}")
    public ApiResponse<FieldRecord> getById(@PathVariable Long id) { return ApiResponse.success(records.get(kind, id)); }

    @PostMapping
    public ApiResponse<FieldRecord> create(@RequestBody Map<String, Object> body,
                                          @RequestHeader(value = "Idempotency-Key", required = false) String key) {
        return ApiResponse.success(records.create(kind, body, key));
    }

    @PutMapping("/{id}")
    public ApiResponse<FieldRecord> update(@PathVariable Long id, @RequestBody Map<String, Object> body,
                                          @RequestHeader(value = "X-Record-Version", required = false) Long version) {
        return ApiResponse.success(records.update(kind, id, body, version));
    }

    @PostMapping("/{id}/submit")
    public ApiResponse<FieldRecord> submit(@PathVariable Long id,
                                          @RequestHeader(value = "X-Record-Version", required = false) Long version) {
        return ApiResponse.success(records.submit(kind, id, version));
    }

    @PostMapping("/{id}/approve")
    public ApiResponse<FieldRecord> approve(@PathVariable Long id, @Valid @RequestBody ApproveDTO dto,
                                           @RequestHeader(value = "X-Record-Version", required = false) Long version) {
        return ApiResponse.success(records.approve(kind, id, version, dto.getStatus(), dto.getRejectReason()));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id,
                                   @RequestHeader(value = "X-Record-Version", required = false) Long version) {
        records.delete(kind, id, version);
        return ApiResponse.success(null);
    }

    @PostMapping("/{id}/new-version")
    public ApiResponse<FieldRecord> newVersion(@PathVariable Long id) { return ApiResponse.success(records.newVersion(kind, id)); }

    @GetMapping("/{id}/versions")
    public ApiResponse<List<FieldRecord>> versions(@PathVariable Long id) { return ApiResponse.success(records.versions(kind, id)); }

    @GetMapping("/{id}/history")
    public ApiResponse<List<FieldRecordEvent>> history(@PathVariable Long id) { return ApiResponse.success(records.history(kind, id)); }
}
