package com.supervision;

import com.supervision.common.ApiResponse;
import com.supervision.controller.FileUploadController;
import com.supervision.exception.BusinessException;
import com.supervision.service.AttachmentAccessService;
import static org.mockito.Mockito.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;

import java.io.File;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * FileUploadController 安全加固单元测试。
 * 直接构造控制器（构造注入配置），上传目录使用 JUnit 临时目录，
 * 覆盖：扩展名白名单拒绝、路径遍历文件名处理、正常上传响应契约断言。
 */
@DisplayName("FileUploadController 文件上传安全加固单元测试")
class FileUploadControllerTest {

    private static final String DEFAULT_EXTENSIONS =
            "jpg,jpeg,png,gif,bmp,pdf,doc,docx,xls,xlsx,ppt,pptx,txt,zip,rar";

    @TempDir
    Path tempDir;

    private FileUploadController controller;
    private AttachmentAccessService attachmentAccess;

    @BeforeEach
    void setUp() {
        // 上传目录指向测试临时目录，避免污染工作目录
        attachmentAccess = mock(AttachmentAccessService.class);
        controller = new FileUploadController(tempDir.toString(), DEFAULT_EXTENSIONS, attachmentAccess);
    }

    private MockMultipartFile file(String originalFilename) {
        return new MockMultipartFile("file", originalFilename, null, "test-content".getBytes());
    }

    @Test
    @DisplayName("白名单外扩展名（exe）应抛 BusinessException")
    void testRejectNotAllowedExtension() {
        BusinessException e = assertThrows(BusinessException.class,
                () -> controller.upload(file("virus.exe")));
        assertEquals("不支持的文件类型: exe", e.getMessage());
    }

    @Test
    @DisplayName("扩展名大小写不敏感：JPG 应允许上传")
    void testExtensionCaseInsensitive() throws Exception {
        ApiResponse<Map<String, Object>> resp = controller.upload(file("photo.JPG"));
        assertEquals(200, resp.getCode());
        assertTrue(((String) resp.getData().get("url")).endsWith(".jpg"));
    }

    @Test
    @DisplayName("路径遍历文件名（../../evil.jpg）只取文件名部分，文件落在上传目录内")
    void testPathTraversalFilenameSanitized() throws Exception {
        ApiResponse<Map<String, Object>> resp = controller.upload(file("../../evil.jpg"));
        assertEquals(200, resp.getCode());
        String url = (String) resp.getData().get("url");
        assertTrue(url.startsWith("/api/uploads/"));
        assertFalse(url.contains(".."));
        // 物理文件必须位于上传目录（含日期子目录）内，未逃逸到上级目录
        String dateDir = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
        String storedName = url.substring(url.lastIndexOf('/') + 1);
        File stored = new File(new File(tempDir.toFile(), dateDir), storedName);
        assertTrue(stored.exists());
        assertFalse(new File(tempDir.getParent().getParent().toFile(), "evil.jpg").exists());
    }

    @Test
    @DisplayName("提取后仍含 .. 的非法文件名应抛 BusinessException")
    void testFilenameContainingDotDotRejected() {
        BusinessException e = assertThrows(BusinessException.class,
                () -> controller.upload(file("a..b.jpg")));
        assertTrue(e.getMessage().contains("非法的文件名"));
    }

    @Test
    @DisplayName("正常上传：响应契约 { url, name, size } 且 url 前缀 /api/uploads/")
    void testNormalUploadContract() throws Exception {
        MockMultipartFile mock = file("报告.pdf");
        ApiResponse<Map<String, Object>> resp = controller.upload(mock);
        assertEquals(200, resp.getCode());
        Map<String, Object> data = resp.getData();
        String dateDir = LocalDate.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
        String url = (String) data.get("url");
        // url 前缀与日期子目录
        assertTrue(url.startsWith("/api/uploads/" + dateDir + "/"));
        // UUID(32 位去横线) + ".pdf"
        String storedName = url.substring(url.lastIndexOf('/') + 1);
        assertTrue(storedName.matches("[0-9a-f]{32}\\.pdf"));
        // name 为原始文件名，size 为原始字节数
        verify(attachmentAccess).register(url);
        assertEquals("报告.pdf", data.get("name"));
        assertEquals(mock.getSize(), data.get("size"));
        // 物理文件存在
        assertTrue(new File(new File(tempDir.toFile(), dateDir), storedName).exists());
    }

    @Test
    @DisplayName("空文件应抛 BusinessException 而非 500")
    void testEmptyFileRejected() {
        MockMultipartFile empty = new MockMultipartFile("file", "a.jpg", null, new byte[0]);
        BusinessException e = assertThrows(BusinessException.class, () -> controller.upload(empty));
        assertEquals("上传文件不能为空", e.getMessage());
    }

    @Test
    @DisplayName("无扩展名文件应抛 BusinessException 而非 StringIndexOutOfBounds")
    void testNoExtensionRejected() {
        BusinessException e = assertThrows(BusinessException.class,
                () -> controller.upload(file("noextension")));
        assertEquals("文件缺少扩展名，无法识别文件类型", e.getMessage());
    }

    @Test
    @DisplayName("UTF-8 中文文本声明字符集且原件字节不变")
    void utf8TextKeepsOriginalBytesAndDeclaresCharset() throws Exception {
        byte[] bytes = "中文原件".repeat(2000).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Path path = java.nio.file.Files.write(tempDir.resolve("utf8.txt"), bytes);
        when(attachmentAccess.content("ticket", "signature")).thenReturn(path);
        var response = controller.content("ticket", "signature");
        assertEquals(java.nio.charset.StandardCharsets.UTF_8, response.getHeaders().getContentType().getCharset());
        assertTrue(response.getHeaders().getFirst("Content-Disposition").startsWith("inline"));
        assertArrayEquals(bytes, response.getBody().getContentAsByteArray());
    }

    @Test
    @DisplayName("非 UTF-8 文本不强制错误字符集且保留原件")
    void legacyTextKeepsOriginalBytesWithoutGuessingCharset() throws Exception {
        byte[] bytes = "中文原件".getBytes(java.nio.charset.Charset.forName("GB18030"));
        Path path = java.nio.file.Files.write(tempDir.resolve("legacy.txt"), bytes);
        when(attachmentAccess.content("ticket", "signature")).thenReturn(path);
        var response = controller.content("ticket", "signature");
        assertNull(response.getHeaders().getContentType().getCharset());
        assertArrayEquals(bytes, response.getBody().getContentAsByteArray());
    }

    @Test
    @DisplayName("自定义白名单可覆盖默认值：仅允许 png 时拒绝 jpg")
    void testCustomWhitelistOverride() {
        FileUploadController pngOnly = new FileUploadController(tempDir.toString(), "png", attachmentAccess);
        BusinessException e = assertThrows(BusinessException.class,
                () -> pngOnly.upload(file("photo.jpg")));
        assertEquals("不支持的文件类型: jpg", e.getMessage());
    }
}
