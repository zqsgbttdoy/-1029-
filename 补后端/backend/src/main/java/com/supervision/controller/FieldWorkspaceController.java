package com.supervision.controller;

import com.supervision.common.ApiResponse;
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

    @GetMapping("/field/summary")
    public ApiResponse<Map<String, Object>> summary(@RequestParam Long projectId,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {
        return ApiResponse.success(records.summary(projectId, date));
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

    @GetMapping("/projects/{projectId}/members")
    public ApiResponse<?> members(@PathVariable Long projectId) { return ApiResponse.success(access.members(projectId)); }

    public record MemberRequest(@NotNull Long userId, boolean enabled, boolean canReview) {}

    @PutMapping("/projects/{projectId}/members")
    public ApiResponse<ProjectMember> member(@PathVariable Long projectId, @Valid @RequestBody MemberRequest request) {
        return ApiResponse.success(access.setMember(projectId, request.userId(), request.enabled(), request.canReview()));
    }
}
