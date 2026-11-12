package com.supervision;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.supervision.common.AuthContext;
import com.supervision.common.DiaryLinkCodec;
import com.supervision.util.JwtUtil;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 使用独立 H2 和上传目录验证日记与直传资料的新绑定，不复用旧正文引用测试数据。 */
@SpringBootTest
@ActiveProfiles("e2e")
@AutoConfigureMockMvc(print = org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
class DiaryAttachmentIntegrationTest {
    private static final String RUN = UUID.randomUUID().toString();
    private static final String DATE = "2026-11-05";
    private static final AtomicLong IDS = new AtomicLong(300000);

    @DynamicPropertySource
    static void isolated(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.url", () -> "jdbc:h2:mem:diaryattachments" + RUN
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=15000");
        properties.add("app.upload.dir", () -> "target/diary-attachment-uploads-" + RUN);
    }

    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate db;
    @Autowired JwtUtil jwt;

    private long author;
    private long peer;
    private long reviewer;
    private long outsider;
    private long project;
    private long otherProject;
    private long root;
    private long folder;
    private long otherFolder;
    private String file;
    private JsonNode document;

    @BeforeEach
    void prepare() throws Exception {
        author = IDS.incrementAndGet();
        peer = IDS.incrementAndGet();
        reviewer = IDS.incrementAndGet();
        outsider = IDS.incrementAndGet();
        project = IDS.incrementAndGet();
        otherProject = IDS.incrementAndGet();
        root = IDS.incrementAndGet();
        folder = IDS.incrementAndGet();
        otherFolder = IDS.incrementAndGet();
        for (long id : List.of(author, peer, reviewer, outsider)) {
            db.update("insert into sys_user(id,name,status) values (?,?,'active')", id, "绑定测试" + id);
        }
        db.update("insert into biz_project(id,name,code,status,manager_id) values (?,?,?,'active',?)",
                project, "绑定项目", "DA" + project, reviewer);
        db.update("insert into biz_project(id,name,code,status,manager_id) values (?,?,?,'active',?)",
                otherProject, "绑定其他项目", "DA" + otherProject, outsider);
        db.update("update sys_user set project_id=? where id in (?,?)", project, author, peer);
        db.update("insert into biz_sub_item_database(id,project_id,name,status) values (?,?,?,'active')",
                root, project, "单位工程");
        db.update("insert into biz_sub_item_database(id,project_id,parent_id,name,status) values (?,?,?,?,'active')",
                folder, project, root, "分项工程");
        db.update("insert into biz_sub_item_database(id,project_id,name,status) values (?,?,?,'active')",
                otherFolder, otherProject, "其他项目目录");
        file = upload(author);
        document = document(author, project, folder, "当天直传资料.jpg", file);
    }

    @AfterEach
    void clearIdentity() {
        AuthContext.clear();
    }

    private String token(long user) {
        return "Bearer " + jwt.generateToken(user, "测试", List.of());
    }

    private JsonNode call(long user, MockHttpServletRequestBuilder request, int expected) throws Exception {
        MvcResult result = mvc.perform(request.header("Authorization", token(user)))
                .andExpect(status().is(expected)).andReturn();
        return json.readTree(result.getResponse().getContentAsByteArray()).path("data");
    }

    private MockHttpServletRequestBuilder body(MockHttpServletRequestBuilder request, Object value) throws Exception {
        return request.contentType("application/json").content(json.writeValueAsString(value));
    }

    private String upload(long user) throws Exception {
        return call(user, multipart("/files/upload").file(new MockMultipartFile(
                "file", "现场.jpg", "image/jpeg", new byte[]{1, 2, 3})), 200).path("url").asText();
    }

    private JsonNode create(long user, String type, Map<String, Object> value) throws Exception {
        return call(user, body(post("/" + type).header("Idempotency-Key", UUID.randomUUID().toString()), value), 200);
    }

    private JsonNode document(long user, long projectId, long folderId, String name, String path) throws Exception {
        JsonNode created = call(user, body(post("/project-documents"), Map.of(
                "projectId", projectId, "subItemId", folderId, "name", name, "filePath", path)), 200);
        db.update("update biz_project_document set upload_date=? where id=?", DATE, created.path("id").asLong());
        return call(user, get("/project-documents/" + created.path("id").asLong()), 200);
    }

    private Map<String, Object> diary(long projectId) {
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("projectId", projectId);
        input.put("diaryDate", DATE);
        input.put("weather", "晴");
        input.put("construction", "当天施工情况");
        input.put("photos", "[\"" + file + "\"]");
        input.put("attachments", "[]");
        return input;
    }

    private String diaryPath(JsonNode diary) {
        return "/supervision-diaries/" + diary.path("id").asLong();
    }

    private String attachPath(JsonNode diary, JsonNode doc) {
        return diaryPath(diary) + "/related-attachments/" + doc.path("id").asLong();
    }

    private JsonNode attach(long user, JsonNode diary, JsonNode doc, int status) throws Exception {
        return call(user, put(attachPath(diary, doc)), status);
    }

    private JsonNode detach(long user, JsonNode diary, JsonNode doc, int status) throws Exception {
        return call(user, delete(attachPath(diary, doc)), status);
    }

    private String relatedIds(long diaryId) {
        return db.queryForObject("select related_attachment_ids from biz_supervision_diary where id=?",
                String.class, diaryId);
    }

    private Long documentDiaryId(long documentId) {
        return db.queryForObject("select diary_id from biz_project_document where id=?", Long.class, documentId);
    }

    private JsonNode documentIn(long user, String filter, long documentId) throws Exception {
        JsonNode page = call(user, get("/project-documents").param("projectId", String.valueOf(project))
                .param("diaryFilter", filter), 200);
        for (JsonNode item : page.path("list")) {
            if (item.path("id").asLong() == documentId) return item;
        }
        return null;
    }

    @Test
    void workbenchFiltersBusinessStatusAndReturnsDocumentMetadata() throws Exception {
        String itemPhoto = upload(author);
        String ordinaryAttachment = upload(author);
        String checklist = json.writeValueAsString(Map.of("version", 1, "items", List.of(Map.of(
                "id", "ci-workbench-1", "content", "临边防护", "result", "compliant",
                "photos", List.of(Map.of("url", itemPhoto, "name", "检查项照片.jpg", "size", 20)), "problems", List.of()))));
        Map<String, Object> daily = new LinkedHashMap<>(Map.of(
                "projectId", project, "inspectionDate", DATE, "location", "一层",
                "content", "已保存巡检内容", "issues", "现场问题", "checklist", checklist,
                "photos", json.writeValueAsString(List.of(Map.of("url", file, "name", "整单照片.jpg"))),
                "attachments", json.writeValueAsString(List.of(Map.of("url", ordinaryAttachment, "name", "巡检真实附件.jpg")))));
        daily.put("startTime", "2026-11-05T08:30:00");
        daily.put("workerCount", 12);
        daily.put("manageCount", 3);
        JsonNode savedDaily = create(author, "daily-inspections", daily);
        call(author, post("/daily-inspections/" + savedDaily.path("id").asLong() + "/submit")
                .header("X-Record-Version", savedDaily.path("lockVersion").asLong()), 200);
        daily.put("content", "草稿巡检不应出现");
        create(author, "daily-inspections", daily);

        Map<String, Object> notice = new LinkedHashMap<>(Map.of(
                "projectId", project, "noticeDate", DATE, "code", "NOTICE-" + UUID.randomUUID(),
                "title", "已发出通知", "content", "通知关键内容", "photos", "[]", "attachments", "[]"));
        JsonNode noticeRecord = create(author, "supervision-notices", notice);
        notice.put("status", "issued");
        call(author, body(put("/supervision-notices/" + noticeRecord.path("id").asLong()), notice), 200);
        notice.put("code", "NOTICE-DRAFT-" + UUID.randomUUID());
        notice.put("status", "draft");
        create(author, "supervision-notices", notice);

        Map<String, Object> contact = new LinkedHashMap<>(Map.of(
                "projectId", project, "contactDate", DATE, "code", "CONTACT-" + UUID.randomUUID(),
                "title", "已发送联系单", "content", "联系单关键内容", "photos", "[]", "attachments", "[]"));
        JsonNode contactRecord = create(author, "work-contacts", contact);
        contact.put("status", "sent");
        call(author, body(put("/work-contacts/" + contactRecord.path("id").asLong()), contact), 200);
        contact.put("code", "CONTACT-OLD-" + UUID.randomUUID());
        contact.put("status", "sent");
        JsonNode inactive = create(author, "work-contacts", contact);
        db.update("update biz_work_contact set status='inactive' where id=?", inactive.path("id").asLong());

        JsonNode otherDate = document(author, project, folder, "非当天资料.jpg", upload(author));
        db.update("update biz_project_document set upload_date='2026-11-04' where id=?", otherDate.path("id").asLong());
        long inactiveFolder = IDS.incrementAndGet();
        db.update("insert into biz_sub_item_database(id,project_id,name,status) values (?,?,?,'active')",
                inactiveFolder, project, "待停用目录");
        document(author, project, inactiveFolder, "停用目录资料.jpg", upload(author));
        db.update("update biz_sub_item_database set status='inactive' where id=?", inactiveFolder);

        JsonNode result = call(author, get("/field/diary-day-workbench")
                .param("projectId", String.valueOf(project)).param("date", DATE), 200);
        assertEquals(1, result.path("dailyInspections").size());
        JsonNode workbenchDaily = result.path("dailyInspections").get(0);
        assertEquals("已保存巡检内容\n现场问题", workbenchDaily.path("content").asText());
        assertEquals("2026-11-05T08:30:00", workbenchDaily.path("startTime").asText());
        assertEquals(12, workbenchDaily.path("workerCount").asInt());
        assertEquals(3, workbenchDaily.path("manageCount").asInt());
        assertEquals("已保存巡检内容", workbenchDaily.path("inspectionContent").asText());
        assertEquals("现场问题", workbenchDaily.path("issues").asText());
        assertTrue(workbenchDaily.path("checklist").asText().contains("临边防护"));
        assertEquals(2, workbenchDaily.path("syncPhotos").size());
        assertEquals(file, workbenchDaily.path("syncPhotos").get(0).path("url").asText());
        assertEquals(itemPhoto, workbenchDaily.path("syncPhotos").get(1).path("url").asText());
        assertEquals("检查项照片.jpg", workbenchDaily.path("syncPhotos").get(1).path("name").asText());
        JsonNode dailyFile = workbenchDaily.path("attachments").get(1);
        assertEquals("巡检真实附件.jpg", dailyFile.path("name").asText());
        assertEquals(ordinaryAttachment, dailyFile.path("file").asText());
        assertTrue(dailyFile.path("url").asText().startsWith("file-reference.html?sourceType=daily-inspections"));
        assertEquals(1, result.path("supervisionNotices").size());
        assertEquals("已发出通知", result.path("supervisionNotices").get(0).path("title").asText());
        assertTrue(result.path("supervisionNotices").get(0).path("copyText").asText().contains("通知关键内容"));
        assertEquals(1, result.path("workContacts").size());
        assertEquals("已发送联系单", result.path("workContacts").get(0).path("title").asText());
        assertEquals(1, result.path("documents").size());
        JsonNode item = result.path("documents").get(0);
        assertEquals(document.path("id").asLong(), item.path("id").asLong());
        assertEquals("单位工程 / 分项工程", item.path("directoryPath").asText());
        assertEquals("绑定测试" + author, item.path("uploaderName").asText());
        assertFalse(item.has("relatedDiary"));
        call(outsider, get("/field/diary-day-workbench")
                .param("projectId", String.valueOf(project)).param("date", DATE), 403);
    }

    @Test
    void attachDetachAreRealtimeIdempotentAndOrdinarySaveCannotForge() throws Exception {
        Map<String, Object> forged = diary(project);
        forged.put("relatedAttachmentIds", "[" + document.path("id").asLong() + "]");
        JsonNode diary = create(author, "supervision-diaries", forged);
        assertEquals("[]", relatedIds(diary.path("id").asLong()));
        assertNull(documentDiaryId(document.path("id").asLong()));

        JsonNode attached = attach(author, diary, document, 200);
        assertEquals(1, attached.path("count").asInt());
        assertEquals(document.path("id").asLong(), attached.path("list").get(0).path("id").asLong());
        assertTrue(attached.path("diary").path("lockVersion").asLong() >= diary.path("lockVersion").asLong());
        assertEquals("[" + document.path("id").asLong() + "]", relatedIds(diary.path("id").asLong()));
        assertEquals(diary.path("id").asLong(), documentDiaryId(document.path("id").asLong()));

        JsonNode repeated = attach(author, diary, document, 200);
        assertEquals(1, repeated.path("count").asInt());
        assertEquals("[" + document.path("id").asLong() + "]", relatedIds(diary.path("id").asLong()));
        assertEquals(1, call(author, get(diaryPath(diary) + "/related-attachments"), 200).path("count").asInt());
        assertNotNull(documentIn(author, "linked", document.path("id").asLong()));
        assertNull(documentIn(author, "unlinked", document.path("id").asLong()));
        call(author, get("/project-documents").param("diaryFilter", "invalid"), 400);

        JsonNode current = attached.path("diary");
        JsonNode saved = call(author, body(put(diaryPath(diary))
                .header("X-Record-Version", current.path("lockVersion").asLong()), Map.of(
                "construction", "普通正文保存", "relatedAttachmentIds", "[]")), 200);
        assertEquals("普通正文保存", saved.path("construction").asText());
        assertEquals("[" + document.path("id").asLong() + "]", relatedIds(diary.path("id").asLong()));
        assertEquals(diary.path("id").asLong(), documentDiaryId(document.path("id").asLong()));

        JsonNode detached = detach(author, diary, document, 200);
        assertEquals(0, detached.path("count").asInt());
        assertEquals("[]", relatedIds(diary.path("id").asLong()));
        assertNull(documentDiaryId(document.path("id").asLong()));
        assertEquals(0, detach(author, diary, document, 200).path("count").asInt());
        assertNotNull(documentIn(author, "unlinked", document.path("id").asLong()));
    }

    @Test
    void rejectsCrossProjectCrossDateConflictsPermissionsAndFrozenDiaries() throws Exception {
        JsonNode diary = create(author, "supervision-diaries", diary(project));
        String otherFile = upload(outsider);
        JsonNode otherDocument = document(outsider, otherProject, otherFolder, "跨项目资料.jpg", otherFile);
        attach(author, diary, otherDocument, 400);

        JsonNode otherDate = document(author, project, folder, "跨日期资料.jpg", upload(author));
        db.update("update biz_project_document set upload_date='2026-11-04' where id=?", otherDate.path("id").asLong());
        attach(author, diary, otherDate, 400);
        attach(peer, diary, document, 403);
        attach(outsider, diary, document, 403);
        call(peer, get(diaryPath(diary) + "/related-attachments"), 403);

        attach(author, diary, document, 200);
        JsonNode second = create(author, "supervision-diaries", diary(project));
        attach(author, second, document, 409);
        detach(author, second, document, 409);

        long inactiveFolder = IDS.incrementAndGet();
        db.update("insert into biz_sub_item_database(id,project_id,name,status) values (?,?,?,'active')",
                inactiveFolder, project, "失效目录");
        JsonNode inactiveDocument = document(author, project, inactiveFolder, "失效目录资料.jpg", upload(author));
        db.update("update biz_sub_item_database set status='inactive' where id=?", inactiveFolder);
        JsonNode freeDiary = create(author, "supervision-diaries", diary(project));
        attach(author, freeDiary, inactiveDocument, 400);

        JsonNode freeDocument = document(author, project, folder, "冻结前另一份资料.jpg", upload(author));
        JsonNode submitted = call(author, post(diaryPath(diary) + "/submit")
                .header("X-Record-Version", db.queryForObject(
                        "select lock_version from biz_supervision_diary where id=?", Long.class, diary.path("id").asLong())), 200);
        assertEquals("submitted", submitted.path("status").asText());
        attach(author, diary, freeDocument, 409);
        detach(author, diary, document, 409);
    }

    @Test
    void documentAndDiaryDeletionClearBothSides() throws Exception {
        JsonNode second = document(author, project, folder, "第二份资料.jpg", upload(author));
        JsonNode diary = create(author, "supervision-diaries", diary(project));
        attach(author, diary, document, 200);
        attach(author, diary, second, 200);
        call(author, delete("/project-documents/" + document.path("id").asLong()), 200);
        assertEquals("[" + second.path("id").asLong() + "]", relatedIds(diary.path("id").asLong()));
        assertEquals(diary.path("id").asLong(), documentDiaryId(second.path("id").asLong()));
        assertEquals(1, call(author, get(diaryPath(diary) + "/related-attachments"), 200).path("count").asInt());

        JsonNode current = call(author, get(diaryPath(diary)), 200);
        call(author, delete(diaryPath(diary)).header("X-Record-Version", current.path("lockVersion").asLong()), 200);
        assertNull(documentDiaryId(second.path("id").asLong()));
        assertEquals("[]", relatedIds(diary.path("id").asLong()));
        call(author, get(diaryPath(diary) + "/related-attachments"), 404);
    }

    @Test
    void revisionDoesNotCopyOrStealOriginalBinding() throws Exception {
        JsonNode original = create(author, "supervision-diaries", diary(project));
        attach(author, original, document, 200);
        JsonNode current = call(author, get(diaryPath(original)), 200);
        current = call(author, post(diaryPath(original) + "/submit")
                .header("X-Record-Version", current.path("lockVersion").asLong()), 200);
        current = call(reviewer, body(post(diaryPath(original) + "/approve")
                .header("X-Record-Version", current.path("lockVersion").asLong()), Map.of("status", "approved")), 200);
        JsonNode revision = call(author, post(diaryPath(original) + "/new-version"), 200);
        assertEquals(2, revision.path("version").asInt());
        assertEquals("[]", relatedIds(revision.path("id").asLong()));
        assertEquals(original.path("id").asLong(), documentDiaryId(document.path("id").asLong()));
        attach(author, revision, document, 409);
        assertEquals(1, call(author, get(diaryPath(original) + "/related-attachments"), 200).path("count").asInt());
        assertEquals(0, call(author, get(diaryPath(revision) + "/related-attachments"), 200).path("count").asInt());
    }

    @Test
    void filtersTraceAndLegacyBodyReferencesRemainIndependent() throws Exception {
        String link = DiaryLinkCodec.format(new DiaryLinkCodec.Link(
                "project-documents", document.path("id").asLong(), file, "当天直传资料.jpg"));
        Map<String, Object> input = diary(project);
        input.put("construction", "正文保留历史链接\n" + link);
        JsonNode diary = create(author, "supervision-diaries", input);
        attach(author, diary, document, 200);
        JsonNode second = document(author, project, folder, "未绑定资料.jpg", upload(author));

        JsonNode linked = documentIn(author, "linked", document.path("id").asLong());
        assertNotNull(linked);
        assertEquals(1, linked.path("diaryReferenceCount").asLong());
        assertEquals(diary.path("id").asLong(), linked.path("relatedDiary").path("id").asLong());
        assertEquals(diary.path("code").asText(), linked.path("relatedDiary").path("code").asText());
        assertEquals(DATE, linked.path("relatedDiary").path("diaryDate").asText());
        assertNotNull(documentIn(author, "unlinked", second.path("id").asLong()));
        assertEquals(1, call(author, get("/project-documents/" + document.path("id").asLong()
                + "/diary-references"), 200).path("total").asInt());

        String contactAttachments = json.writeValueAsString(List.of(Map.of(
                "url", file, "name", "联系单附件", "dirs", List.of("单位工程 / 分项工程"))));
        Map<String, Object> contact = new LinkedHashMap<>(Map.of(
                "projectId", project, "contactDate", DATE, "code", "CONTACT-TRACE-" + UUID.randomUUID(),
                "title", "目录原值核对", "content", "内容", "attachments", contactAttachments));
        create(author, "work-contacts", contact);
        assertEquals(contactAttachments, db.queryForObject(
                "select attachments from biz_work_contact where project_id=?", String.class, project));

        JsonNode trace = call(author, get("/sub-item-databases/" + folder + "/attachment-sources"), 200);
        JsonNode direct = null;
        JsonNode contacts = null;
        for (JsonNode group : trace.path("sources")) {
            if ("project-documents".equals(group.path("sourceType").asText())) direct = group;
            if ("work-contacts".equals(group.path("sourceType").asText())) contacts = group;
        }
        assertNotNull(direct);
        assertNotNull(contacts);
        JsonNode directRecord = null;
        for (JsonNode record : direct.path("records")) {
            if (record.path("id").asLong() == document.path("id").asLong()) directRecord = record;
        }
        assertNotNull(directRecord);
        assertEquals(diary.path("id").asLong(), directRecord.path("relatedDiary").path("id").asLong());
        assertEquals(diaryPath(diary).replace("/supervision-diaries/", "supervision-diary.html?id=") + "&readonly=true",
                directRecord.path("diaryRoute").asText());
        assertFalse(contacts.path("records").get(0).has("relatedDiary"));
        assertEquals(contactAttachments, db.queryForObject(
                "select attachments from biz_work_contact where project_id=?", String.class, project));

        detach(author, diary, document, 200);
        assertEquals(0, call(author, get(diaryPath(diary) + "/related-attachments"), 200).path("count").asInt());
        assertEquals(1, call(author, get("/project-documents/" + document.path("id").asLong()
                + "/diary-references"), 200).path("total").asInt());
    }

    @Test
    void documentUpdateCannotChangeBindingThroughClientFields() throws Exception {
        JsonNode diary = create(author, "supervision-diaries", diary(project));
        attach(author, diary, document, 200);
        Map<String, Object> update = new LinkedHashMap<>();
        update.put("projectId", project);
        update.put("subItemId", folder);
        update.put("name", "资料改名");
        update.put("filePath", file);
        update.put("diaryId", null);
        call(author, body(put("/project-documents/" + document.path("id").asLong()), update), 200);
        assertEquals(diary.path("id").asLong(), documentDiaryId(document.path("id").asLong()));
        assertEquals("[" + document.path("id").asLong() + "]", relatedIds(diary.path("id").asLong()));
    }
}
