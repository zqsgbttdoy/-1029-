package com.supervision.service;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.supervision.common.*;
import com.supervision.entity.*;
import com.supervision.exception.BusinessException;
import jakarta.persistence.EntityManager;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.time.Instant;
import java.util.*;

/** 原始路径只作存库标识。文件通过按人授权的短时链接访问，不暴露登录令牌。 */
@Service
public class AttachmentAccessService {
    private final EntityManager em;
    private final ProjectAccessService access;
    private final ObjectMapper mapper;
    private final Path root;
    private final byte[] signingKey = new byte[32];

    public AttachmentAccessService(EntityManager em, ProjectAccessService access, ObjectMapper mapper,
                                   @Value("${app.upload.dir:uploads}") String uploadDir,
                                   @Value("${app.upload.signing-secret:}") String secret) {
        this.em = em;
        this.access = access;
        this.mapper = mapper;
        this.root = Path.of(uploadDir).toAbsolutePath().normalize();
        if (secret.isBlank()) new SecureRandom().nextBytes(signingKey);
        else {
            if (secret.length() < 32) throw new IllegalStateException("附件签名密钥至少 32 字符");
            try { System.arraycopy(MessageDigest.getInstance("SHA-256").digest(secret.getBytes(StandardCharsets.UTF_8)), 0, signingKey, 0, signingKey.length); }
            catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
        }
    }

    @Transactional
    public void register(String url) {
        UploadedFile file = new UploadedFile();
        file.setUrl(normalize(url));
        file.setOwnerId(access.currentUser().getId());
        em.persist(file);
    }

    public String normalize(String url) {
        if (url != null) {
            url = url.replace('\\', '/');
            if (url.startsWith("uploads/")) url = "/api/" + url;
            else if (url.startsWith("/uploads/")) url = "/api" + url;
        }
        if (url == null || !url.matches("/api/uploads/(?:[0-9]{8}/)?[a-zA-Z0-9_-]+\\.[a-zA-Z0-9]+"))
            throw new BusinessException(400, "附件路径无效，请重新上传");
        return url;
    }

    public Set<String> urls(String json) {
        Set<String> result = new LinkedHashSet<>();
        if (json == null || json.isBlank()) return result;
        try {
            JsonNode array = mapper.readTree(json);
            if (!array.isArray() || array.size() > 50) throw new IllegalArgumentException();
            for (JsonNode item : array) {
                String url = item.isTextual() ? item.asText() : item.path("url").asText();
                result.add(normalize(url));
            }
        } catch (Exception e) { throw new BusinessException(400, "附件必须为有效的文件列表，最多 50 个"); }
        return result;
    }

    @Transactional
    public void bind(FieldRecord record) { bind(record.getProjectId(), record.getPhotos(), record.getAttachments()); }

    @Transactional
    public void bind(Long projectId, String photos, String attachments) {
        access.requireRead(projectId);
        Set<String> references = new TreeSet<>(urls(photos));
        references.addAll(urls(attachments));
        for (String url : references) {
            UploadedFile file = em.createQuery("select f from UploadedFile f where f.url=:url", UploadedFile.class)
                    .setParameter("url", url).setLockMode(jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)
                    .getResultStream().findFirst().orElse(null);
            authorize(url);
            if (file != null) {
                if (file.getProjectId() != null && !file.getProjectId().equals(projectId))
                    throw new BusinessException(403, "不可将其他项目附件绑定到本项目");
                file.setProjectId(projectId);
            }
        }
    }

    @Transactional
    public String bindDocument(Long projectId, String url) {
        if (url == null || url.isBlank()) return url;
        url = normalize(url);
        bind(projectId, "[\"" + url + "\"]", null);
        return url;
    }

    /**
     * 绑定回复附件并合并进原附件列表。
     *
     * <p>通知单/联系单的回复附件复用 attachments 字段保存（无需新增表字段），
     * 以 source=reply 标记来源，保证授权校验与历史数据兼容。
     *
     * @param projectId    记录所属项目
     * @param existingJson 原 attachments JSON（可为空）
     * @param replyJson    本次回复附件 JSON（元素支持字符串或 { url, name, size }）
     * @return 合并后的 attachments JSON；回复为空时原样返回
     */
    @Transactional
    public String bindReply(Long projectId, String existingJson, String replyJson) {
        return mergeAttachments(projectId, existingJson, replyJson, "reply");
    }

    /**
     * 把后续阶段新增的附件合并进既有列表（附件与照片共用）。
     *
     * <p>先对新元素做上传归属绑定，再按 URL 去重追加，保证原有元素既不丢失也不重复。
     *
     * @param projectId    记录所属项目，用于校验文件归属
     * @param existingJson 既有列表 JSON，可为空
     * @param incomingJson 本次新增列表 JSON，为空时原样返回既有值
     * @param source       来源标记（reply / verify），写入元素 source 字段
     * @return 合并后的 JSON 数组字符串
     */
    @Transactional
    public String mergeAttachments(Long projectId, String existingJson, String incomingJson, String source) {
        if (incomingJson == null || incomingJson.isBlank()) return existingJson;
        bind(projectId, null, incomingJson);
        ArrayNode merged = mapper.createArrayNode();
        Set<String> seen = new LinkedHashSet<>();
        appendAttachments(merged, seen, existingJson, null);
        appendAttachments(merged, seen, incomingJson, source);
        return merged.toString();
    }

    private void appendAttachments(ArrayNode target, Set<String> seen, String json, String source) {
        if (json == null || json.isBlank()) return;
        JsonNode array;
        try { array = mapper.readTree(json); }
        catch (Exception e) { throw new BusinessException(400, "附件必须为有效的文件列表，最多 50 个"); }
        if (!array.isArray() || array.size() > 50) throw new BusinessException(400, "附件必须为有效的文件列表，最多 50 个");
        for (JsonNode item : array) {
            String raw = item.isTextual() ? item.asText() : item.path("url").asText();
            String url = normalize(raw);
            if (!seen.add(url)) continue;
            ObjectNode node = item.isObject() ? ((ObjectNode) item).deepCopy() : mapper.createObjectNode();
            node.put("url", url);
            if (source != null && !node.has("source")) node.put("source", source);
            target.add(node);
        }
    }

    private UploadedFile find(String url) {
        return em.createQuery("select f from UploadedFile f where f.url=:url", UploadedFile.class)
                .setParameter("url", url).getResultStream().findFirst().orElse(null);
    }

    @Transactional(readOnly = true)
    public void authorize(String url) {
        url = normalize(url);
        User user = access.currentUser();
        Long uid = user.getId();
        UploadedFile file = find(url);
        if (file != null && file.getProjectId() != null) access.requireRead(file.getProjectId());
        if (file != null && uid.equals(file.getOwnerId())) return;
        if (user.getAvatar() != null && !user.getAvatar().isBlank()) {
            try { if (url.equals(normalize(user.getAvatar()))) return; } catch (BusinessException ignored) { }
        }
        // 兼容存量附件：必须确实被有权查看的业务记录引用，不能仅凭文件名访问。
        String candidate = "%" + url.substring(url.lastIndexOf('/') + 1).replace("_", "!_") + "%";
        List<Long> ids = access.projectIds(false);
        if (ids.isEmpty()) throw new BusinessException(403, "没有附件访问权限");
        for (FieldRecordKind kind : FieldRecordKind.values()) {
            List<? extends FieldRecord> records = em.createQuery("select r from " + kind.getEntityClass().getSimpleName()
                    + " r where r.projectId in :ids and r.status <> 'inactive' and (r.photos like :url escape '!' or r.attachments like :url escape '!')", kind.getEntityClass())
                    .setParameter("ids", ids).setParameter("url", candidate).getResultList();
            for (FieldRecord record : records) {
                Object author = org.springframework.beans.PropertyAccessorFactory.forBeanPropertyAccess(record).getPropertyValue(kind.getAuthorField());
                boolean visible = uid.equals(author) || !"draft".equals(record.getStatus()) && access.canReview(record.getProjectId())
                        || List.of("approved", "recorded", "fixed").contains(record.getStatus());
                if (visible && (references(record.getPhotos(), url) || references(record.getAttachments(), url))) return;
            }
        }
        for (ProjectDocument document : em.createQuery("select d from ProjectDocument d where d.projectId in :ids", ProjectDocument.class)
                .setParameter("ids", ids).getResultList()) {
            try { if (url.equals(normalize(document.getFilePath()))) return; } catch (BusinessException ignored) { }
        }
        for (FieldRecordEvent event : em.createQuery("select e from FieldRecordEvent e where e.snapshot like :url escape '!'", FieldRecordEvent.class)
                .setParameter("url", candidate).getResultList()) {
            try {
                FieldRecordKind kind = FieldRecordKind.fromPath(event.getRecordType());
                FieldRecord current = em.find(kind.getEntityClass(), event.getRecordId());
                if (current == null || !ids.contains(current.getProjectId()) || "inactive".equals(current.getStatus())) continue;
                Object author = org.springframework.beans.PropertyAccessorFactory.forBeanPropertyAccess(current).getPropertyValue(kind.getAuthorField());
                boolean visible = uid.equals(author) || !"draft".equals(current.getStatus()) && access.canReview(current.getProjectId())
                        || List.of("approved", "recorded", "fixed").contains(current.getStatus());
                JsonNode snapshot = mapper.readTree(event.getSnapshot());
                if (visible && (references(snapshot.path("photos").asText(), url) || references(snapshot.path("attachments").asText(), url))) return;
            } catch (java.io.IOException ignored) { }
        }
        // 非现场单据保留原项目可见范围，仍检查精确引用。
        for (Class<?> type : List.of(SafetyLog.class, MeetingMinutes.class, SupervisionMonthlyReport.class, SupervisionNotice.class, WorkContact.class)) {
            for (Object record : em.createQuery("select r from " + type.getSimpleName()
                    + " r where r.projectId in :ids and r.status <> 'inactive' and (r.photos like :url escape '!' or r.attachments like :url escape '!')", type)
                    .setParameter("ids", ids).setParameter("url", candidate).getResultList()) {
                var bean = org.springframework.beans.PropertyAccessorFactory.forBeanPropertyAccess(record);
                if (references((String) bean.getPropertyValue("photos"), url) || references((String) bean.getPropertyValue("attachments"), url)) return;
            }
        }
        throw new BusinessException(403, "没有附件访问权限");
    }

    private boolean references(String json, String url) {
        try { return urls(json).contains(url); }
        catch (BusinessException ignored) { return false; }
    }

    @Transactional(readOnly = true)
    public Map<String, Object> link(String url) {
        url = normalize(url);
        authorize(url);
        long expires = Instant.now().getEpochSecond() + 120;
        String payload = access.currentUser().getId() + "\n" + expires + "\n" + url;
        String ticket = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(StandardCharsets.UTF_8));
        return Map.of("url", "/api/files/content?ticket=" + ticket + "&signature=" + sign(ticket), "expiresAt", expires);
    }

    @Transactional(readOnly = true)
    public Path content(String ticket, String signature) {
        if (ticket == null || ticket.length() > 1500 || signature == null || !MessageDigest.isEqual(
                sign(ticket).getBytes(StandardCharsets.US_ASCII), signature.getBytes(StandardCharsets.US_ASCII)))
            throw new BusinessException(403, "附件链接无效或已过期");
        AuthContext.CurrentUser previous = AuthContext.get();
        try {
            String[] values = new String(Base64.getUrlDecoder().decode(ticket), StandardCharsets.UTF_8).split("\n", -1);
            if (values.length != 3 || Long.parseLong(values[1]) < Instant.now().getEpochSecond()) throw new IllegalArgumentException();
            AuthContext.set(new AuthContext.CurrentUser(Long.valueOf(values[0]), "", List.of()));
            authorize(values[2]);
            Path file = root.resolve(normalize(values[2]).substring("/api/uploads/".length())).normalize();
            if (!file.startsWith(root) || !Files.isRegularFile(file) || !file.toRealPath().startsWith(root.toRealPath()))
                throw new BusinessException(404, "附件不存在");
            return file;
        } catch (BusinessException e) { throw e; }
        catch (Exception e) { throw new BusinessException(403, "附件链接无效或已过期"); }
        finally { if (previous == null) AuthContext.clear(); else AuthContext.set(previous); }
    }

    private String sign(String text) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(signingKey, "HmacSHA256"));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(text.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }
}
