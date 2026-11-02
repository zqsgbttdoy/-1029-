package com.supervision.common;

import com.supervision.exception.BusinessException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.regex.Pattern;

/** 受限正文语法；不解释 HTML，也不从任意历史 URL 推断引用。 */
public final class DiaryLinkCodec {
    private DiaryLinkCodec() { }
    public static final List<String> FIELDS = List.of("construction", "management", "inspection", "otherWork",
            "otherMatters", "morningMeeting", "newIssues", "materialInspection", "drawingReview");
    public static final Set<String> SOURCES = Set.of("daily-inspections", "sideline-inspections", "supervision-notices", "work-contacts", "project-documents");
    private static final Pattern LINK = Pattern.compile("\\[((?:\\\\[\\\\\\[\\]()]|[^\\]\\\\\\r\\n]){1,500})\\]\\((file-reference\\.html\\?[^\\s()]{1,2000})\\)");
    public record Link(String sourceType, Long sourceId, String file, String name) {
        public String identity() { return sourceType + ":" + sourceId + ":" + file; }
        public String url() { return stable(sourceType, sourceId, file); }
    }
    public static String normalize(String url) {
        if (url != null) {
            url = url.replace('\\', '/');
            if (url.startsWith("uploads/")) url = "/api/" + url;
            else if (url.startsWith("/uploads/")) url = "/api" + url;
        }
        if (url == null || !url.matches("/api/uploads/(?:[0-9]{8}/)?[a-zA-Z0-9_-]+\\.[a-zA-Z0-9]+") || url.length() > 500)
            throw new BusinessException(400, "附件路径无效，请重新上传");
        return url;
    }
    public static String stable(String type, Long id, String file) {
        if (!SOURCES.contains(type) || id == null || id <= 0) throw new BusinessException(400, "文件来源无效");
        return "file-reference.html?sourceType=" + type + "&sourceId=" + id + "&file=" + encode(normalize(file));
    }
    private static String encode(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20"); }
    public static Link target(String url, String name) {
        if (url == null || !url.startsWith("file-reference.html?") || url.contains("#"))
            throw new BusinessException(400, "仅支持本站文件关联链接");
        try {
            Map<String, String> args = new HashMap<>();
            for (String pair : url.substring("file-reference.html?".length()).split("&", -1)) {
                String[] kv = pair.split("=", 2);
                if (kv.length != 2 || args.put(URLDecoder.decode(kv[0], StandardCharsets.UTF_8), URLDecoder.decode(kv[1], StandardCharsets.UTF_8)) != null)
                    throw new IllegalArgumentException();
            }
            if (!args.keySet().equals(Set.of("sourceType", "sourceId", "file")) || !args.get("sourceId").matches("[1-9][0-9]{0,18}"))
                throw new IllegalArgumentException();
            String type = args.get("sourceType"), file = normalize(args.get("file"));
            Long id = Long.valueOf(args.get("sourceId"));
            stable(type, id, file);
            return new Link(type, id, file, name);
        } catch (Exception e) { throw new BusinessException(400, "文件关联链接格式无效"); }
    }
    public static List<Link> parse(String text) {
        List<Link> links = new ArrayList<>();
        if (text == null) return links;
        var matcher = LINK.matcher(text);
        while (matcher.find()) links.add(target(matcher.group(2), matcher.group(1).replaceAll("\\\\([\\\\\\[\\]()])", "$1")));
        return links;
    }
    public static String format(Link link) {
        return "[" + link.name().replaceAll("([\\\\\\[\\]()])", "\\\\$1") + "](" + link.url() + ")";
    }
    public static String hash(String file) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(normalize(file).getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
}
