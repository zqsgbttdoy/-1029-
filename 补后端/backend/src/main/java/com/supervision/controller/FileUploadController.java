package com.supervision.controller;

import com.supervision.common.ApiResponse;
import com.supervision.exception.BusinessException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.File;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * 文件上传接口（安全加固版）。
 *
 * <p>安全策略：
 * <ul>
 *   <li>扩展名白名单校验（可通过配置项 app.upload.allowed-extensions 覆盖）；</li>
 *   <li>防路径遍历：仅取原始文件名的文件名部分，拒绝包含 ../ 等路径穿越片段；</li>
 *   <li>存储命名使用 UUID，避免时间戳并发碰撞与原始文件名注入；</li>
 *   <li>按日期（yyyyMMdd）建子目录，物理根目录由 app.upload.dir 配置（默认 uploads），按绝对路径处理。</li>
 * </ul>
 *
 * <p>响应契约（前端依赖，不可变更）：data 为 { url, name, size }，
 * 其中 url 前缀固定为 "/api/uploads/"。
 */
@RestController
@RequestMapping("/files")
public class FileUploadController {

    private final com.supervision.service.FileStorageService storage;
    private final com.supervision.service.AttachmentAccessService attachmentAccess;

    @org.springframework.beans.factory.annotation.Autowired
    public FileUploadController(com.supervision.service.FileStorageService storage,
                                com.supervision.service.AttachmentAccessService attachmentAccess) {
        this.storage = storage;
        this.attachmentAccess = attachmentAccess;
    }

    /**
     * 构造注入上传配置。
     *
     * @param uploadDir         上传根目录，配置项 app.upload.dir，默认 uploads
     * @param allowedExtensions 扩展名白名单（逗号分隔），配置项 app.upload.allowed-extensions
     */
    public FileUploadController(
            @Value("${app.upload.dir:uploads}") String uploadDir,
            @Value("${app.upload.allowed-extensions:jpg,jpeg,png,gif,bmp,pdf,doc,docx,xls,xlsx,ppt,pptx,txt,zip,rar}")
            String allowedExtensions,
            com.supervision.service.AttachmentAccessService attachmentAccess) {
        this(new com.supervision.service.FileStorageService(uploadDir, allowedExtensions, attachmentAccess), attachmentAccess);
    }

    /**
     * 上传单个文件。
     *
     * <p>校验流程：非空校验 → 文件名安全提取（防路径遍历）→ 扩展名白名单校验，
     * 通过后以 UUID 命名存储至 {uploadDir}/{yyyyMMdd}/ 目录。
     *
     * @param file 待上传文件（multipart 参数名 file）
     * @return { url: "/api/uploads/{yyyyMMdd}/{uuid}.{ext}", name: 原始文件名, size: 字节数 }
     * @throws BusinessException 文件为空、文件名非法或扩展名不在白名单时抛出（400）
     */
    @PostMapping("/upload")
    public ApiResponse<Map<String, Object>> upload(@RequestParam("file") MultipartFile file) throws Exception {
        return ApiResponse.success(storage.upload(file));
    }

    /**
     * 提取安全的文件名：仅保留最后一个路径分隔符之后的文件名部分，
     * 并拒绝仍包含路径穿越片段（..）的非法文件名。
     *
     * @param originalFilename 客户端提交的原始文件名（可能携带路径）
     * @return 纯文件名部分
     * @throws BusinessException 文件名为空或含非法路径片段
     */
    private String extractSafeFilename(String originalFilename) {
        if (originalFilename == null || originalFilename.trim().isEmpty()) {
            throw new BusinessException("文件名不能为空");
        }
        // 兼容 Windows 与 Unix 路径分隔符，只取文件名部分
        String name = originalFilename.replace('\\', '/');
        int lastSlash = name.lastIndexOf('/');
        if (lastSlash >= 0) {
            name = name.substring(lastSlash + 1);
        }
        if (name.trim().isEmpty() || name.contains("..")) {
            throw new BusinessException("非法的文件名: " + originalFilename);
        }
        return name;
    }

    /**
     * 提取小写扩展名（不含点）。
     *
     * @param filename 纯文件名
     * @return 小写扩展名
     * @throws BusinessException 无扩展名时抛出
     */
    @org.springframework.web.bind.annotation.GetMapping("/access")
    public ApiResponse<Map<String, Object>> access(@RequestParam String url) {
        return ApiResponse.success(attachmentAccess.link(url));
    }

    @org.springframework.web.bind.annotation.GetMapping("/content")
    public org.springframework.http.ResponseEntity<org.springframework.core.io.Resource> content(
            @RequestParam String ticket, @RequestParam String signature) throws java.io.IOException {
        java.nio.file.Path path = attachmentAccess.content(ticket, signature);
        String type = java.nio.file.Files.probeContentType(path);
        // 图片/PDF/纯文本允许浏览器内联预览，其余类型强制下载；文件名来自 UUID 白名单扩展名，无注入风险。
        boolean previewable = type != null
                && (type.startsWith("image/") || type.startsWith("text/") || "application/pdf".equals(type));
        String disposition = previewable ? "inline" : "attachment";
        return org.springframework.http.ResponseEntity.ok()
                .header("Cache-Control", "private, no-store")
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Security-Policy", "sandbox")
                .header("Content-Disposition", disposition + "; filename=\"" + path.getFileName() + "\"")
                .contentType(org.springframework.http.MediaType.parseMediaType(type == null ? "application/octet-stream" : type))
                .body(new org.springframework.core.io.FileSystemResource(path));
    }

    private String extractExtension(String filename) {
        int dotIndex = filename.lastIndexOf('.');
        if (dotIndex < 0 || dotIndex == filename.length() - 1) {
            throw new BusinessException("文件缺少扩展名，无法识别文件类型");
        }
        return filename.substring(dotIndex + 1).toLowerCase(Locale.ROOT);
    }
}
