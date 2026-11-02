package com.supervision.controller;

import com.supervision.common.ApiResponse;
import com.supervision.service.DiaryResourceResolver;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;
import java.time.LocalDate;

@RestController
@RequiredArgsConstructor
public class DiaryResourceController {
    private final DiaryResourceResolver resources;
    @GetMapping("/field/diary-resources")
    public ApiResponse<?> list(@RequestParam Long projectId, @RequestParam String sourceType,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate dateFrom,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate dateTo,
            @RequestParam(required = false) String keyword, @RequestParam(defaultValue = "1") int pageNum,
            @RequestParam(defaultValue = "20") int pageSize) {
        return ApiResponse.success(resources.list(projectId, sourceType, date, dateFrom, dateTo, keyword, pageNum, pageSize));
    }
}
