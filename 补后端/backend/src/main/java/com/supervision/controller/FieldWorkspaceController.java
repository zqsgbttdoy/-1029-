package com.supervision.controller;

import com.supervision.common.ApiResponse;
import com.supervision.common.FieldRecordKind;
import com.supervision.entity.ProjectMember;
import com.supervision.service.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.util.*;

@RestController
@RequiredArgsConstructor
public class FieldWorkspaceController {
    private final FieldRecordService records;
    private final ProjectAccessService access;
    private final SafetyLogService safetyLogs;
    private final DiaryAttachmentService diaryAttachments;

    /** 列表统一入口：保留原业务路径，复用同一状态过滤及项目、作者可见性校验。 */
    @GetMapping("/records/{kind}")
    public ApiResponse<?> list(@PathVariable String kind,
            @RequestParam(defaultValue = "1") int pageNum,
            @RequestParam(defaultValue = "20") int pageSize,
            @RequestParam(required = false) Long projectId,
            @RequestParam(required = false) String code,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate dateFrom,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate dateTo,
            @RequestParam(required = false) Long authorId) {
        return ApiResponse.success(records.list(FieldRecordKind.fromPath(kind), pageNum, pageSize,
                projectId, code, status, dateFrom, dateTo, authorId));
    }

    /** 安全日志继续使用独立工作流，只新增只读列表别名。 */
    @GetMapping("/records/safety-logs")
    public ApiResponse<?> safetyList(@RequestParam(defaultValue = "1") int pageNum,
            @RequestParam(defaultValue = "20") int pageSize,
            @RequestParam(required = false) Long projectId,
            @RequestParam(required = false) String code,
            @RequestParam(required = false) String status) {
        return ApiResponse.success(safetyLogs.list(pageNum, pageSize, projectId, code, status));
    }

    @GetMapping("/field/summary")
    public ApiResponse<Map<String, Object>> summary(@RequestParam Long projectId,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {
        return ApiResponse.success(records.summary(projectId, date));
    }

    @GetMapping("/field/diary-day-workbench")
    public ApiResponse<Map<String, Object>> diaryDayWorkbench(@RequestParam Long projectId,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {
        return ApiResponse.success(diaryAttachments.dailyWorkbench(projectId, date));
    }

    @GetMapping("/field/diary-source")
    public ApiResponse<Map<String, Object>> diarySource(@RequestParam Long projectId,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {
        return ApiResponse.success(records.diarySource(projectId, date));
    }

    @GetMapping("/field/diary-prefill")
    public ApiResponse<Map<String, String>> diaryPrefill(@RequestParam Long projectId,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {
        return ApiResponse.success(records.diaryPrefill(projectId, date));
    }

    @GetMapping("/field/projects/{projectId}/member-options")
    public ApiResponse<?> memberOptions(@PathVariable Long projectId) { return ApiResponse.success(access.memberOptions(projectId)); }

    @GetMapping("/projects/{projectId}/members")
    public ApiResponse<?> members(@PathVariable Long projectId) { return ApiResponse.success(access.members(projectId)); }

    public record MemberRequest(@NotNull Long userId, boolean enabled, boolean canReview) {}

    @PutMapping("/projects/{projectId}/members")
    public ApiResponse<ProjectMember> member(@PathVariable Long projectId, @Valid @RequestBody MemberRequest request) {
        return ApiResponse.success(access.setMember(projectId, request.userId(), request.enabled(), request.canReview()));
    }
}
