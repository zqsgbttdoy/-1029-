package com.supervision;

import com.fasterxml.jackson.databind.*;
import com.supervision.common.*;
import com.supervision.entity.*;
import com.supervision.exception.BusinessException;
import com.supervision.service.*;
import com.supervision.util.JwtUtil;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.*;
import org.springframework.test.web.servlet.*;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** 每次运行使用全新 H2 与上传目录，不访问既有实例或存量数据库。 */
@SpringBootTest
@ActiveProfiles("e2e")
@AutoConfigureMockMvc(print = org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint.NONE)
class DiaryReferenceIntegrationTest {
    static final String RUN = UUID.randomUUID().toString();
    @DynamicPropertySource static void isolated(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.url", () -> "jdbc:h2:mem:diarylinks" + RUN + ";MODE=MySQL;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=15000");
        properties.add("app.upload.dir", () -> "target/diary-links-uploads-" + RUN);
    }
    @Autowired MockMvc mvc;
    @Autowired ObjectMapper json;
    @Autowired JdbcTemplate db;
    @Autowired JwtUtil jwt;
    @SpyBean DiaryReferenceService references;
    @SpyBean DiaryResourceResolver resolver;
    static final AtomicLong IDS = new AtomicLong(200000);
    long author, reviewer, peer, outsider, project, otherProject, folder;
    String file;
    JsonNode document;
    @BeforeEach void prepare() throws Exception {
        author = IDS.incrementAndGet(); reviewer = IDS.incrementAndGet(); peer = IDS.incrementAndGet(); outsider = IDS.incrementAndGet();
        project = IDS.incrementAndGet(); otherProject = IDS.incrementAndGet(); folder = IDS.incrementAndGet();
        for (long id : List.of(author, reviewer, peer, outsider)) db.update("insert into sys_user(id,name,status) values (?,?,'active')", id, "引用测试" + id);
        db.update("insert into biz_project(id,name,code,status,manager_id) values (?,? ,?,'active',?)", project, "引用项目", "DR" + project, reviewer);
        db.update("insert into biz_project(id,name,code,status,manager_id) values (?,? ,?,'active',?)", otherProject, "其他项目", "DR" + otherProject, outsider);
        db.update("update sys_user set project_id=? where id in (?,?)", project, author, peer);
        db.update("insert into biz_sub_item_database(id,project_id,name,status) values (?,?,?,'active')", folder, project, "分项工程");
        file = upload(author);
        document = create(author, "project-documents", Map.of("projectId", project, "subItemId", folder, "name", "中文(原件)[A]\\复核.jpg", "filePath", file));
        db.update("update biz_project_document set upload_date='2026-10-30' where id=?", document.path("id").asLong());
    }
    @AfterEach void clear() { reset(references, resolver); AuthContext.clear(); }
    String token(long user) { return "Bearer " + jwt.generateToken(user, "测试", List.of()); }
    JsonNode call(long user, MockHttpServletRequestBuilder request, int status) throws Exception {
        MvcResult result = mvc.perform(request.header("Authorization", token(user))).andExpect(status().is(status)).andReturn();
        return json.readTree(result.getResponse().getContentAsByteArray()).path("data");
    }
    MockHttpServletRequestBuilder body(MockHttpServletRequestBuilder request, Object value) throws Exception {
        return request.contentType("application/json").content(json.writeValueAsString(value));
    }
    String upload(long user) throws Exception {
        return call(user, multipart("/files/upload").file(new MockMultipartFile("file", "原件.jpg", "image/jpeg", new byte[]{1, 2, 3})), 200).path("url").asText();
    }
    JsonNode create(long user, String type, Object value) throws Exception {
        return call(user, body(post("/" + type).header("Idempotency-Key", UUID.randomUUID().toString()), value), 200);
    }
    Map<String, Object> diary(String text) { return new LinkedHashMap<>(Map.of("projectId", project, "diaryDate", "2026-10-30", "weather", "晴", "construction", text, "photos", "[\"" + file + "\"]")); }
    String link(String type, JsonNode record) { return DiaryLinkCodec.format(new DiaryLinkCodec.Link(type, record.path("id").asLong(), file, "中文(原件)[A]\\复核.jpg")); }
    String link() { return link("project-documents", document); }
    String path(JsonNode record) { return "/supervision-diaries/" + record.path("id").asLong(); }
    JsonNode update(JsonNode record, Object value) throws Exception { return call(author, body(put(path(record)).header("X-Record-Version", record.path("lockVersion").asLong()), value), 200); }
    long rows(boolean active) { return db.queryForObject("select count(*) from biz_diary_reference where project_id=?" + (active ? " and active=true" : ""), Long.class, project); }
    void count(long user, long expected) throws Exception {
        JsonNode list = call(user, get("/project-documents").param("projectId", "" + project), 200);
        JsonNode doc = null;
        for (JsonNode item : list.path("list")) if (item.path("id").equals(document.path("id"))) doc = item;
        assertNotNull(doc); assertEquals(expected, doc.path("diaryReferenceCount").asLong());
        assertEquals(expected, call(user, get("/project-documents/" + document.path("id").asLong() + "/diary-references"), 200).path("total").asLong());
    }
    JsonNode source(String type, String attachments) throws Exception {
        Map<String, Object> input = new LinkedHashMap<>(Map.of("projectId", project, "code", "SRC-" + UUID.randomUUID(), "photos", "[]", "attachments", attachments));
        if (type.endsWith("inspections")) { input.put("inspectionDate", "2026-10-30"); input.put("location", "一层"); input.put("content", "检查原文"); }
        else { input.put(type.equals("supervision-notices") ? "noticeDate" : "contactDate", "2026-10-30"); input.put("title", "来源标题"); input.put("content", "原文"); }
        return create(author, type, input);
    }
    JsonNode resources(long user, String type) throws Exception {
        return call(user, get("/field/diary-resources").param("projectId", "" + project).param("sourceType", type).param("date", "2026-10-30"), 200);
    }
    JsonNode access(long user, String type, JsonNode record, String raw, int status) throws Exception {
        return call(user, get("/files/reference-access").param("sourceType", type).param("sourceId", record.path("id").asText()).param("file", raw), status);
    }

    @Test void codecSpecialNamesRoundTripAndDangerousText() {
        var parsed = DiaryLinkCodec.parse("前文\n" + link() + "\n后文");
        assertEquals(1, parsed.size()); assertEquals("中文(原件)[A]\\复核.jpg", parsed.get(0).name());
        assertEquals(file, parsed.get(0).file()); assertEquals(link(), DiaryLinkCodec.format(parsed.get(0)));
        assertTrue(DiaryLinkCodec.parse("<script>alert(1)</script>[危险](javascript:alert(1)) [外站](https://evil.invalid/" + parsed.get(0).url() + ")").isEmpty());
        assertThrows(BusinessException.class, () -> DiaryLinkCodec.target(parsed.get(0).url() + "&file=x", "x"));
        assertThrows(BusinessException.class, () -> DiaryLinkCodec.normalize("/api/uploads/../secret.txt"));
    }
    @Test void fiveSourcesExactFilesPermissionsAndEmptyItems() throws Exception {
        for (String type : List.of("daily-inspections", "sideline-inspections", "supervision-notices", "work-contacts")) {
            JsonNode record = source(type, json.writeValueAsString(List.of(Map.of("url", file, "name", "附件.jpg"))));
            source(type, "[]");
            JsonNode list = resources(author, type);
            assertEquals(2, list.path("total").asLong()); assertEquals(0, list.path("list").get(0).path("files").size());
            assertEquals(file, list.path("list").get(1).path("files").get(0).path("file").asText());
            access(author, type, record, file, 200); access(outsider, type, record, file, 403);
            access(author, type, record, "/api/uploads/nonexistent.jpg", 404);
            if (type.endsWith("inspections")) { assertEquals(0, resources(reviewer, type).path("total").asLong()); access(reviewer, type, record, file, 403); }
        }
        assertEquals(1, resources(author, "project-documents").path("total").asLong());
        assertEquals(0, rows(false));
        call(author, get("/field/diary-resources").param("projectId", "" + otherProject).param("sourceType", "project-documents"), 403);
    }
    @Test void dateKeywordAndPaginationAreServerSide() throws Exception {
        for (int i = 0; i < 23; i++) source("work-contacts", "[]");
        db.update("update biz_work_contact set contact_date='2026-09-01' where project_id=?", project);
        assertEquals(0, resources(author, "work-contacts").path("total").asLong());
        var request = get("/field/diary-resources").param("projectId", "" + project).param("sourceType", "work-contacts").param("dateFrom", "2026-09-01").param("dateTo", "2026-10-30").param("pageNum", "2").param("pageSize", "20").param("keyword", "来源");
        JsonNode page = call(author, request, 200); assertEquals(23, page.path("total").asLong()); assertEquals(3, page.path("list").size());
        call(author, get("/field/diary-resources").param("projectId", "" + project).param("sourceType", "work-contacts").param("date", "2026-02-30"), 400);
        call(author, get("/field/diary-resources").param("projectId", "" + project).param("sourceType", "work-contacts").param("dateFrom", "2026-10-30").param("dateTo", "2026-09-01"), 400);
        call(author, get("/field/diary-resources").param("projectId", "" + project).param("sourceType", "not-a-source"), 400);
    }
    @Test void draftDuplicatesRemovalAndDeleteAreAtomic() throws Exception {
        var input = diary("前文" + link() + "中间" + link() + "后文"); input.put("management", link());
        JsonNode record = create(author, "supervision-diaries", input);
        assertEquals(1, rows(true)); count(author, 1); count(reviewer, 0); count(peer, 0);
        record = update(record, Map.of("construction", link(), "management", "")); count(author, 1);
        record = update(record, Map.of("construction", "已移除所有文件链接")); count(author, 0); assertEquals(0, rows(false));
        record = update(record, Map.of("construction", link())); count(author, 1);
        call(author, delete(path(record)).header("X-Record-Version", record.path("lockVersion").asLong()), 200);
        count(author, 0); assertEquals(0, rows(false));
        assertTrue(db.queryForObject("select count(*) from biz_field_record_event where record_id=? and record_type='supervision-diaries'", Long.class, record.path("id").asLong()) >= 4);
    }
    @Test void savedDraftVisibilityMatchesListThroughReview() throws Exception {
        JsonNode record = create(author, "supervision-diaries", diary(link()));
        record = call(author, post(path(record) + "/submit").header("X-Record-Version", record.path("lockVersion").asLong()), 200);
        count(reviewer, 1); count(peer, 0);
        record = call(reviewer, body(post(path(record) + "/approve").header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("status", "approved")), 200);
        count(peer, 1);
        call(author, body(put(path(record)).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("construction", "覆盖")), 409);
        count(peer, 1);
        call(outsider, get("/project-documents/" + document.path("id").asText() + "/diary-references"), 403);
    }
    @Test void documentDeletionPreservesBodyAndRevokesAlreadyIssuedTicketForUploader() throws Exception {
        JsonNode record = create(author, "supervision-diaries", diary(link()));
        String ticketUrl = access(author, "project-documents", document, file, 200).path("url").asText();
        mvc.perform(get(ticketUrl.substring(4))).andExpect(status().isOk());
        call(author, delete("/project-documents/" + document.path("id").asText()), 200);
        mvc.perform(get(ticketUrl.substring(4))).andExpect(status().isNotFound());
        access(author, "project-documents", document, file, 404); assertEquals(0, rows(true)); assertEquals(1, rows(false));
        assertEquals(link(), call(author, get(path(record)), 200).path("construction").asText());
        record = update(record, Map.of("management", "删除来源后仍可补充无关文字"));
        assertEquals(link(), record.path("construction").asText()); assertEquals(0, rows(true));
        call(author, body(post("/supervision-diaries").header("Idempotency-Key", UUID.randomUUID().toString()), diary(link())), 404);
        call(author, get("/files/access").param("url", file), 200);
    }
    @Test void replaceAndReappendDoNotReviveOldReferences() throws Exception {
        JsonNode record = create(author, "supervision-diaries", diary(link()));
        String replacement = upload(author);
        Map<String, Object> dto = new LinkedHashMap<>(Map.of("projectId", project, "subItemId", folder, "name", "同名文件.jpg", "filePath", replacement));
        call(author, body(put("/project-documents/" + document.path("id").asText()), dto), 200);
        count(author, 0); access(author, "project-documents", document, file, 404);
        dto.put("filePath", file); call(author, body(put("/project-documents/" + document.path("id").asText()), dto), 200);
        update(record, Map.of("management", "无关修改")); count(author, 0);
        assertEquals(1, rows(false));
    }
    @Test void multipleSourcesOfOnePhysicalFileCountDistinctDiaries() throws Exception {
        JsonNode source = source("work-contacts", "[\"" + file + "\"]");
        JsonNode first = create(author, "supervision-diaries", diary(link() + link("work-contacts", source)));
        create(author, "supervision-diaries", diary(link("work-contacts", source))); count(author, 2); assertEquals(3, rows(true));
        call(author, delete("/work-contacts/" + source.path("id").asText()), 200);
        count(author, 1); assertEquals(1, rows(true));
        update(first, Map.of("construction", "移除剩余资料链接")); count(author, 0);
    }
    @Test void allSourceLifecycleHooksInvalidate() throws Exception {
        for (String type : List.of("daily-inspections", "sideline-inspections", "supervision-notices", "work-contacts")) {
            JsonNode source = source(type, "[\"" + file + "\"]");
            create(author, "supervision-diaries", diary(link(type, source))); assertEquals(1, rows(true));
            var request = delete("/" + type + "/" + source.path("id").asText());
            if (type.endsWith("inspections")) request.header("X-Record-Version", source.path("lockVersion").asLong());
            call(author, request, 200); assertEquals(0, rows(true)); access(author, type, source, file, 404);
        }
    }
    @Test void exactIdentityAndProjectCannotBeForged() throws Exception {
        String bad = DiaryLinkCodec.format(new DiaryLinkCodec.Link("project-documents", document.path("id").asLong(), upload(author), "同名.jpg"));
        call(author, body(post("/supervision-diaries").header("Idempotency-Key", UUID.randomUUID().toString()), diary(bad)), 404);
        db.update("insert into biz_project_member(project_id,user_id,enabled,can_review) values (?,?,true,false)", otherProject, author);
        var input = diary(link()); input.put("projectId", otherProject); input.put("photos", "[]");
        call(author, body(post("/supervision-diaries").header("Idempotency-Key", UUID.randomUUID().toString()), input), 403);
        assertEquals(0, rows(false));
    }
    @Test void idempotentReplayAndVersionConflictDoNotDuplicate() throws Exception {
        String key = UUID.randomUUID().toString(); var input = diary(link());
        JsonNode first = call(author, body(post("/supervision-diaries").header("Idempotency-Key", key), input), 200);
        assertEquals(first.path("id"), call(author, body(post("/supervision-diaries").header("Idempotency-Key", key), input), 200).path("id"));
        update(first, Map.of("management", "新文字"));
        call(author, body(put(path(first)).header("X-Record-Version", first.path("lockVersion").asLong()), Map.of("construction", "")), 409);
        count(author, 1); assertEquals(1, rows(false));
    }
    @Test void rollbackIncludesBodyRelationshipsAndEvent() throws Exception {
        JsonNode record = create(author, "supervision-diaries", diary("原文"));
        doAnswer(call -> { call.callRealMethod(); throw new BusinessException(400, "测试事务回滚"); }).when(references).sync(any());
        call(author, body(put(path(record)).header("X-Record-Version", record.path("lockVersion").asLong()), Map.of("construction", link())), 400);
        assertEquals(0, rows(false)); assertEquals("原文", call(author, get(path(record)), 200).path("construction").asText());
        assertEquals(1, db.queryForObject("select count(*) from biz_field_record_event where record_type='supervision-diaries' and record_id=?", Long.class, record.path("id").asLong()));
    }
    @Test void limitRefusesRatherThanTruncating() throws Exception {
        StringBuilder text = new StringBuilder();
        for (long i = 1; i <= 201; i++) text.append(DiaryLinkCodec.format(new DiaryLinkCodec.Link("project-documents", i, file, "文件")));
        call(author, body(post("/supervision-diaries").header("Idempotency-Key", UUID.randomUUID().toString()), diary(text.toString())), 400);
        assertEquals(0, rows(false));
    }
    @Test void revisionInheritsInactiveLinksButCopyCannotForgeProof() throws Exception {
        JsonNode original = create(author, "supervision-diaries", diary(link()));
        original = call(author, post(path(original) + "/submit").header("X-Record-Version", original.path("lockVersion").asLong()), 200);
        original = call(reviewer, body(post(path(original) + "/approve").header("X-Record-Version", original.path("lockVersion").asLong()), Map.of("status", "approved")), 200);
        call(author, delete("/project-documents/" + document.path("id").asText()), 200);
        var revision = diary(link()); revision.put("sourceRecordId", original.path("id").asLong());
        JsonNode saved = create(author, "supervision-diaries", revision);
        assertEquals(2, rows(false)); assertEquals(0, rows(true)); assertEquals(link(), saved.path("construction").asText());
        call(peer, body(post("/supervision-diaries").header("Idempotency-Key", UUID.randomUUID().toString()), revision), 403);
        call(author, body(post("/supervision-diaries").header("Idempotency-Key", UUID.randomUUID().toString()), diary(link())), 404);
    }
    @Test void rejectedRevisionThroughEndpointKeepsRealFileLinksAndOriginal() throws Exception {
        JsonNode original = create(author, "supervision-diaries", diary(link()));
        original = call(author, post(path(original) + "/submit").header("X-Record-Version", original.path("lockVersion").asLong()), 200);
        original = call(reviewer, body(post(path(original) + "/approve").header("X-Record-Version", original.path("lockVersion").asLong()),
                Map.of("status", "rejected", "rejectReason", "补充现场说明")), 200);
        original = call(author, get(path(original)), 200);
        JsonNode revision = call(author, post(path(original) + "/new-version"), 200);
        assertEquals(2, revision.path("version").asInt());
        assertEquals(original.path("id"), revision.path("sourceRecordId"));
        assertEquals(link(), revision.path("construction").asText());
        assertEquals(2, rows(false)); assertEquals(2, rows(true)); count(author, 2);
        assertEquals(revision.path("id"), call(author, post(path(original) + "/new-version"), 200).path("id"));
        assertEquals(original, call(author, get(path(original)), 200));
    }
    @Test void currentPermissionIsCheckedAgainWhenTicketIsRead() throws Exception {
        String url = access(author, "project-documents", document, file, 200).path("url").asText();
        db.update("insert into biz_project_member(project_id,user_id,enabled,can_review) values (?,?,false,false)", project, author);
        mvc.perform(get(url.substring(4))).andExpect(status().isForbidden());
        assertEquals(0, rows(false));
    }
    @Test void removingAttachmentsFromEverySourceInvalidatesWithoutChangingDiary() throws Exception {
        for (String type : List.of("daily-inspections", "sideline-inspections", "supervision-notices", "work-contacts")) {
            JsonNode source = source(type, "[\"" + file + "\"]");
            JsonNode diary = create(author, "supervision-diaries", diary(link(type, source)));
            var input = json.convertValue(source, new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {});
            input.put("attachments", "[]"); input.put("photos", "[]");
            var request = put("/" + type + "/" + source.path("id").asText());
            if (type.endsWith("inspections")) request.header("X-Record-Version", source.path("lockVersion").asLong());
            call(author, body(request, input), 200);
            assertEquals(0, rows(true)); assertEquals(link(type, source), call(author, get(path(diary)), 200).path("construction").asText());
        }
    }
    @Test void checklistProblemFilesAreRealResourcesAndRemovalInvalidates() throws Exception {
        var input = Map.of("projectId", project, "inspectionDate", "2026-10-30", "location", "一层", "content", "检查",
            "checklist", json.writeValueAsString(Map.of("version", 1, "items", List.of(Map.of("id", "i1", "content", "检查项", "result", "noncompliant", "required", false,
                "problems", List.of(Map.of("id", "p1", "name", "问题", "type", "安全问题", "attachments", List.of(Map.of("url", file, "name", "问题附件.jpg")))))))));
        JsonNode source = create(author, "daily-inspections", input);
        assertEquals(file, resources(author, "daily-inspections").path("list").get(0).path("files").get(0).path("file").asText());
        create(author, "supervision-diaries", diary(link("daily-inspections", source))); count(author, 1);
        call(author, body(put("/daily-inspections/" + source.path("id").asText()).header("X-Record-Version", source.path("lockVersion").asLong()), Map.of("checklist", "{\"version\":1,\"items\":[]}")), 200);
        count(author, 0);
    }
    @Test void noticeReplyFilesBecomeCandidatesWithoutAutomaticReferences() throws Exception {
        JsonNode source = source("supervision-notices", "[]");
        var input = json.convertValue(source, new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {}); input.put("status", "issued");
        call(author, body(put("/supervision-notices/" + source.path("id").asText()), input), 200);
        call(author, body(post("/supervision-notices/" + source.path("id").asText() + "/reply"), Map.of("replyContent", "已整改", "attachments", "[\"" + file + "\"]")), 200);
        assertEquals(file, resources(author, "supervision-notices").path("list").get(0).path("files").get(0).path("file").asText());
        assertEquals(0, rows(false)); create(author, "supervision-diaries", diary(link("supervision-notices", source))); count(author, 1);
    }
    @Test void reversePaginationCountsVisibleDistinctDiariesNotEvents() throws Exception {
        for (int i = 0; i < 12; i++) { JsonNode d = create(author, "supervision-diaries", diary(link() + link())); update(d, Map.of("management", "追加历史")); }
        create(peer, "supervision-diaries", diary(link())); count(author, 12); count(peer, 1); count(reviewer, 0);
        JsonNode page = call(author, get("/project-documents/" + document.path("id").asText() + "/diary-references").param("pageNum", "2").param("pageSize", "10"), 200);
        assertEquals(12, page.path("total").asInt()); assertEquals(2, page.path("list").size());
    }
    @Test void replacementHoldingSourceLockDoesNotDeadlockOnDiaryOwnAttachment() throws Exception {
        JsonNode record = create(author, "supervision-diaries", diary(link()));
        CountDownLatch locked = new CountDownLatch(1), release = new CountDownLatch(1);
        doAnswer(call -> {
            Object result = call.callRealMethod();
            if (Thread.currentThread().getName().equals("replace-source")) { locked.countDown(); assertTrue(release.await(10, TimeUnit.SECONDS)); }
            return result;
        }).when(resolver).load(eq("project-documents"), eq(document.path("id").asLong()), eq(true));
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<?> replace = pool.submit(() -> { Thread.currentThread().setName("replace-source"); try {
                call(author, body(put("/project-documents/" + document.path("id").asText()), Map.of("projectId", project, "subItemId", folder, "name", "替换名称", "filePath", file)), 200);
            } catch (Exception e) { throw new RuntimeException(e); } });
            assertTrue(locked.await(10, TimeUnit.SECONDS));
            Future<?> save = pool.submit(() -> { try { update(record, Map.of("management", "并发正文")); } catch (Exception e) { throw new RuntimeException(e); } });
            release.countDown(); replace.get(15, TimeUnit.SECONDS); save.get(15, TimeUnit.SECONDS); count(author, 1);
        } finally { release.countDown(); pool.shutdownNow(); }
    }
    @Test void deletionRacingSaveCannotRestoreActiveReference() throws Exception {
        JsonNode record = create(author, "supervision-diaries", diary(link()));
        CountDownLatch locked = new CountDownLatch(1), release = new CountDownLatch(1);
        doAnswer(call -> { call.callRealMethod(); locked.countDown(); assertTrue(release.await(10, TimeUnit.SECONDS)); return null; })
                .when(references).invalidate(eq("project-documents"), any(), eq(true));
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<?> remove = pool.submit(() -> { try { call(author, delete("/project-documents/" + document.path("id").asText()), 200); } catch (Exception e) { throw new RuntimeException(e); } });
            assertTrue(locked.await(10, TimeUnit.SECONDS));
            Future<?> save = pool.submit(() -> { try { update(record, Map.of("management", "并发保存文字")); } catch (Exception e) { throw new RuntimeException(e); } });
            release.countDown(); remove.get(15, TimeUnit.SECONDS); save.get(15, TimeUnit.SECONDS);
            assertEquals(0, rows(true)); assertEquals(1, rows(false));
            assertEquals(link(), call(author, get(path(record)), 200).path("construction").asText());
        } finally { release.countDown(); pool.shutdownNow(); }
    }
}
