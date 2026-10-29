package com.supervision.common;

/**
 * 导出文件载体：下载文件名 + 二进制内容。
 * 文件名含中文，由控制器按 RFC 5987（filename*）编码后写入响应头。
 */
public record DocxFile(String fileName, byte[] content) {
}
