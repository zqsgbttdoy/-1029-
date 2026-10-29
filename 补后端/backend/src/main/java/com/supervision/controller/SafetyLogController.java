package com.supervision.controller;

import com.supervision.common.ApiResponse;
import com.supervision.common.DocxFile;
import com.supervision.common.PageResult;
import com.supervision.dto.ApproveDTO;
import com.supervision.dto.SafetyLogDTO;
import com.supervision.entity.SafetyLog;
import com.supervision.service.SafetyLogExportService;
import com.supervision.service.SafetyLogService;
import com.supervision.util.DocxWriter;
import jakarta.validation.Valid;
import lombok.AllArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.CacheControl;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.nio.charset.StandardCharsets;
import java.time.LocalDate;

@RestController
@RequestMapping("/safety-logs")
@AllArgsConstructor
public class SafetyLogController {

    private final SafetyLogService safetyLogService;
    private final SafetyLogExportService safetyLogExportService;

    @GetMapping
    public ApiResponse<PageResult<SafetyLog>> list(
            @RequestParam(defaultValue = "1") int pageNum,
            @RequestParam(defaultValue = "10") int pageSize,
            @RequestParam(required = false) Long projectId,
            @RequestParam(required = false) String code,
            @RequestParam(required = false) String status) {
        return ApiResponse.success(safetyLogService.list(pageNum, pageSize, projectId, code, status));
    }

    @GetMapping("/{id}")
    public ApiResponse<SafetyLog> getById(@PathVariable Long id) {
        return ApiResponse.success(safetyLogService.getById(id));
    }

    /**
     * 单份日志导出 Word：当前查看的详情（含审核与整改闭环信息）一键生成 .docx。
     * 与详情接口同权限：服务端按项目数据权限校验，越权直接 403。
     */
    @GetMapping("/{id}/export")
    public ResponseEntity<byte[]> exportOne(@PathVariable Long id) {
        return docx(safetyLogExportService.exportSingle(id));
    }

    /**
     * 按列表筛选条件批量导出 Word：一次查询取齐（上限 200 份），首页附台账汇总、
     * 其后每份日志独立成页，适合装订归档或报送建设单位。
     */
    @GetMapping("/export")
    public ResponseEntity<byte[]> exportBatch(
            @RequestParam(required = false) Long projectId,
            @RequestParam(required = false) String code,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate dateFrom,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate dateTo) {
        return docx(safetyLogExportService.exportBatch(projectId, code, status, dateFrom, dateTo));
    }

    @PostMapping
    public ApiResponse<SafetyLog> create(@Valid @RequestBody SafetyLogDTO dto) {
        return ApiResponse.success(safetyLogService.create(dto));
    }

    @PutMapping("/{id}")
    public ApiResponse<SafetyLog> update(@PathVariable Long id, @Valid @RequestBody SafetyLogDTO dto) {
        return ApiResponse.success(safetyLogService.update(id, dto));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        safetyLogService.delete(id);
        return ApiResponse.success(null);
    }

    // 审批权限由服务端按项目审核授权（ProjectAccessService.requireReview，数据库实时）判定，
    // 不再依赖令牌内嵌角色声明，项目总监/被授权审核人无需 admin 角色即可审批。
    @PostMapping("/{id}/approve")
    public ApiResponse<SafetyLog> approve(@PathVariable Long id, @Valid @RequestBody ApproveDTO dto) {
        dto.setId(id);
        return ApiResponse.success(safetyLogService.approve(dto));
    }

    /** 统一回写 docx 下载响应：中文文件名按 RFC 5987（filename*）编码。 */
    private static ResponseEntity<byte[]> docx(DocxFile file) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.parseMediaType(DocxWriter.MIME_TYPE));
        headers.setContentDisposition(ContentDisposition.attachment()
                .filename(file.fileName(), StandardCharsets.UTF_8).build());
        headers.setCacheControl(CacheControl.noStore().getHeaderValue());
        headers.setContentLength(file.content().length);
        return new ResponseEntity<>(file.content(), headers, HttpStatus.OK);
    }
}
