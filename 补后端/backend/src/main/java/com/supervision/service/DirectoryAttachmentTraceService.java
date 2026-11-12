package com.supervision.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.supervision.common.FieldRecordKind;
import com.supervision.entity.*;
import com.supervision.exception.BusinessException;
import jakarta.persistence.EntityManager;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.PropertyAccessorFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;
import java.util.stream.Collectors;

/** 从各业务附件快照反查目录引用，目录树统计与详情共用同一套匹配口径。 */
@Service
@RequiredArgsConstructor
public class DirectoryAttachmentTraceService {
    private final EntityManager em;
    private final ObjectMapper mapper;
    private final FieldRecordVisibility visibility;
    private final DiaryAttachmentService diaryAttachments;

    private record SourceSpec(String type, String name, Class<? extends BaseEntity> entity, String dateField,
                              String titleField, String page, FieldRecordKind kind) { }
    private static final SourceSpec DIRECT = new SourceSpec("project-documents", "直接上传", ProjectDocument.class,
            "uploadDate", "name", "project-data-upload.html", null);
    private static final List<SourceSpec> SOURCES = List.of(
            DIRECT,
            new SourceSpec("supervision-notices", "监理通知单", SupervisionNotice.class, "noticeDate", "title", "supervision-notice.html", null),
            new SourceSpec("work-contacts", "工作联系单", WorkContact.class, "contactDate", "title", "work-contact.html", null),
            new SourceSpec("supervision-diaries", "监理日记", SupervisionDiary.class, "diaryDate", "construction", "supervision-diary.html", FieldRecordKind.DIARY),
            new SourceSpec("supervision-logs", "监理日志", SupervisionLog.class, "logDate", "content", "supervision-log.html", FieldRecordKind.LOG),
            new SourceSpec("safety-logs", "监理安全日志", SafetyLog.class, "logDate", "content", "safety-log.html", null),
            new SourceSpec("meeting-minutes", "会议纪要", MeetingMinutes.class, "meetingDate", "title", "meeting-minutes.html", null),
            new SourceSpec("supervision-monthly-reports", "监理月报", SupervisionMonthlyReport.class, "reportMonth", "content", "supervision-monthly-report.html", null),
            new SourceSpec("daily-inspections", "日常巡检", DailyInspection.class, "inspectionDate", "location", "daily-inspection.html", FieldRecordKind.DAILY),
            new SourceSpec("sideline-inspections", "旁站检查", SidelineInspection.class, "inspectionDate", "location", "sideline-inspection.html", FieldRecordKind.SIDELINE)
    );

    private static final class FileEntry {
        private String url;
        private String name;
        private Object size;
        private String stage;
        private final Set<Long> directoryIds = new LinkedHashSet<>();
    }
    private record SourceRecord(SourceSpec spec, BaseEntity record, List<FileEntry> files) { }
    private static final class MutableStat {
        private int attachments;
        private int records;
    }

    @Transactional(readOnly = true)
    public Map<Long, Map<String, Object>> treeStats(List<SubItemDatabase> all) {
        if (all.isEmpty()) return Map.of();
        Long projectId = all.get(0).getProjectId();
        DirectoryIndex index = index(all);
        List<SourceRecord> records = loadRecords(projectId, index);
        Map<Long, Map<String, Object>> result = new LinkedHashMap<>();
        for (SubItemDatabase directory : all) {
            result.put(directory.getId(), stats(subtreeIds(directory.getId(), all), records, index));
        }
        return result;
    }

    @Transactional(readOnly = true)
    public Map<String, Object> detail(SubItemDatabase selected, List<SubItemDatabase> all) {
        DirectoryIndex index = index(all);
        Set<Long> directoryIds = subtreeIds(selected.getId(), all);
        List<SourceRecord> records = loadRecords(selected.getProjectId(), index);
        diaryAttachments.fillDocumentMetadata(records.stream().filter(entry -> entry.spec() == DIRECT)
                .map(entry -> (ProjectDocument) entry.record()).toList());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("directoryId", selected.getId());
        result.put("directoryName", selected.getName());
        result.put("directoryPath", index.paths().get(selected.getId()));
        result.put("projectId", selected.getProjectId());
        result.put("includeDescendants", true);
        result.putAll(stats(directoryIds, records, index));

        List<Map<String, Object>> groups = new ArrayList<>();
        for (SourceSpec spec : SOURCES) {
            List<Map<String, Object>> rows = new ArrayList<>();
            int attachments = 0;
            for (SourceRecord entry : records) {
                if (entry.spec() != spec) continue;
                List<FileEntry> matched = matchedFiles(entry.files(), directoryIds);
                if (matched.isEmpty()) continue;
                attachments += matched.size();
                rows.add(recordMap(entry, matched, directoryIds, index));
            }
            if (rows.isEmpty()) continue;
            Map<String, Object> group = new LinkedHashMap<>();
            group.put("sourceType", spec.type());
            group.put("sourceName", spec.name());
            group.put("attachmentCount", attachments);
            group.put("recordCount", rows.size());
            group.put("records", rows);
            groups.add(group);
        }
        result.put("sources", groups);
        return result;
    }

    private Map<String, Object> stats(Set<Long> directoryIds, List<SourceRecord> records, DirectoryIndex index) {
        Map<SourceSpec, MutableStat> bySource = new LinkedHashMap<>();
        int attachments = 0;
        int recordCount = 0;
        for (SourceRecord entry : records) {
            int matched = (int) entry.files().stream().filter(file -> !Collections.disjoint(file.directoryIds, directoryIds)).count();
            if (matched == 0) continue;
            attachments += matched;
            recordCount++;
            bySource.computeIfAbsent(entry.spec(), ignored -> new MutableStat());
            MutableStat stat = bySource.get(entry.spec());
            stat.attachments += matched;
            stat.records++;
        }
        List<Map<String, Object>> distribution = new ArrayList<>();
        for (SourceSpec spec : SOURCES) {
            MutableStat stat = bySource.get(spec);
            if (stat == null) continue;
            distribution.add(sourceStat(spec, stat.attachments, stat.records));
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("attachmentCount", attachments);
        result.put("recordCount", recordCount);
        result.put("sourceDistribution", distribution);
        return result;
    }

    private Map<String, Object> sourceStat(SourceSpec spec, int attachments, int records) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("sourceType", spec.type());
        item.put("sourceName", spec.name());
        item.put("attachmentCount", attachments);
        item.put("recordCount", records);
        return item;
    }

    private Map<String, Object> recordMap(SourceRecord entry, List<FileEntry> files, Set<Long> selectedIds, DirectoryIndex index) {
        BaseEntity record = entry.record();
        SourceSpec spec = entry.spec();
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("id", record.getId());
        item.put("code", record instanceof ProjectDocument ? "" : text(record, "code"));
        item.put("title", text(record, spec.titleField()));
        item.put("date", value(record, spec.dateField()));
        item.put("status", record instanceof ProjectDocument ? "uploaded" : text(record, "status"));
        String route = record instanceof ProjectDocument document
                ? spec.page() + "?projectId=" + document.getProjectId() + "&subItemId=" + document.getSubItemId() + "&id=" + record.getId()
                : spec.page() + "?id=" + record.getId() + "&readonly=true";
        item.put("route", route);
        if (record instanceof ProjectDocument document) {
            item.put("relatedDiary", document.getRelatedDiary());
            item.put("diaryRoute", document.getRelatedDiary() == null ? null : document.getRelatedDiary().get("route"));
        }
        List<Map<String, Object>> attachments = new ArrayList<>();
        for (FileEntry file : files) {
            Map<String, Object> attachment = new LinkedHashMap<>();
            attachment.put("url", file.url);
            attachment.put("name", file.name);
            if (file.size != null) attachment.put("size", file.size);
            if (file.stage != null && !file.stage.isBlank()) attachment.put("source", file.stage);
            List<String> paths = file.directoryIds.stream().filter(selectedIds::contains)
                    .map(index.paths()::get).filter(Objects::nonNull).toList();
            attachment.put("directoryPaths", paths);
            attachments.add(attachment);
        }
        item.put("attachments", attachments);
        return item;
    }

    private List<FileEntry> matchedFiles(List<FileEntry> files, Set<Long> directoryIds) {
        return files.stream().filter(file -> !Collections.disjoint(file.directoryIds, directoryIds)).toList();
    }

    private List<SourceRecord> loadRecords(Long projectId, DirectoryIndex index) {
        List<SourceRecord> result = new ArrayList<>();
        List<ProjectDocument> documents = em.createQuery("select d from ProjectDocument d where d.projectId=:projectId", ProjectDocument.class)
                .setParameter("projectId", projectId).getResultList();
        for (ProjectDocument document : documents) {
            FileEntry file = new FileEntry();
            file.url = document.getFilePath();
            file.name = document.getName();
            file.size = document.getFileSize();
            if (index.byId().containsKey(document.getSubItemId())) file.directoryIds.add(document.getSubItemId());
            if (!file.directoryIds.isEmpty()) result.add(new SourceRecord(DIRECT, document, List.of(file)));
        }
        for (SourceSpec spec : SOURCES) {
            if (spec == DIRECT) continue;
            List<? extends BaseEntity> records = em.createQuery("select r from " + spec.entity().getSimpleName()
                            + " r where r.projectId=:projectId and r.status <> 'inactive'", spec.entity())
                    .setParameter("projectId", projectId).getResultList();
            for (BaseEntity record : records) {
                if (spec.kind() != null) {
                    try { visibility.require(spec.kind(), (FieldRecord) record); }
                    catch (BusinessException denied) { continue; }
                }
                Set<Long> recordDirectories = new LinkedHashSet<>();
                if (record instanceof SupervisionNotice notice && notice.getDocumentDirectoryIds() != null) {
                    notice.getDocumentDirectoryIds().stream().filter(index.byId()::containsKey).forEach(recordDirectories::add);
                }
                Map<String, FileEntry> files = new LinkedHashMap<>();
                appendFiles(files, text(record, "photos"), recordDirectories, index);
                appendFiles(files, text(record, "attachments"), recordDirectories, index);
                List<FileEntry> matched = files.values().stream().filter(file -> !file.directoryIds.isEmpty()).toList();
                if (!matched.isEmpty()) result.add(new SourceRecord(spec, record, matched));
            }
        }
        return result;
    }

    private void appendFiles(Map<String, FileEntry> target, String json, Set<Long> recordDirectories, DirectoryIndex index) {
        if (json == null || json.isBlank()) return;
        try {
            JsonNode array = mapper.readTree(json);
            if (!array.isArray()) return;
            for (JsonNode item : array) {
                String url = item.isTextual() ? item.asText() : item.path("url").asText("");
                if (url.isBlank()) continue;
                FileEntry file = target.computeIfAbsent(url, ignored -> new FileEntry());
                file.url = url;
                if (file.name == null) {
                    file.name = item.isObject() ? item.path("name").asText("") : "";
                    if (file.name.isBlank()) file.name = url.substring(url.lastIndexOf('/') + 1);
                }
                if (file.size == null && item.isObject() && item.has("size")) {
                    JsonNode size = item.get("size");
                    file.size = size.isNumber() ? size.numberValue() : size.asText();
                }
                if (file.stage == null && item.isObject() && item.path("source").isTextual()) file.stage = item.path("source").asText();
                file.directoryIds.addAll(recordDirectories);
                if (item.isObject() && item.path("dirs").isArray()) {
                    for (JsonNode path : item.path("dirs")) {
                        if (!path.isTextual()) continue;
                        file.directoryIds.addAll(index.pathIds().getOrDefault(normalizePath(path.asText()), Set.of()));
                    }
                }
            }
        } catch (Exception ignored) {
            // 遗留的异常附件 JSON 不应阻断整棵目录树；有效记录仍会正常参与追溯。
        }
    }

    private record DirectoryIndex(Map<Long, SubItemDatabase> byId, Map<Long, String> paths,
                                  Map<String, Set<Long>> pathIds) { }
    private DirectoryIndex index(List<SubItemDatabase> all) {
        Map<Long, SubItemDatabase> byId = all.stream().collect(Collectors.toMap(SubItemDatabase::getId, item -> item));
        Map<Long, String> paths = new LinkedHashMap<>();
        Map<String, Set<Long>> pathIds = new LinkedHashMap<>();
        for (SubItemDatabase item : all) {
            List<String> names = new ArrayList<>();
            Set<Long> visited = new LinkedHashSet<>();
            SubItemDatabase current = item;
            while (current != null && visited.add(current.getId())) {
                names.add(current.getName());
                current = current.getParentId() == null ? null : byId.get(current.getParentId());
            }
            Collections.reverse(names);
            String path = normalizePath(String.join(" / ", names));
            paths.put(item.getId(), path);
            pathIds.computeIfAbsent(path, ignored -> new LinkedHashSet<>()).add(item.getId());
        }
        return new DirectoryIndex(byId, paths, pathIds);
    }

    private Set<Long> subtreeIds(Long selectedId, List<SubItemDatabase> all) {
        Map<Long, SubItemDatabase> byId = all.stream().collect(Collectors.toMap(SubItemDatabase::getId, item -> item));
        Set<Long> result = new LinkedHashSet<>();
        for (SubItemDatabase item : all) {
            Set<Long> visited = new HashSet<>();
            SubItemDatabase current = item;
            while (current != null && visited.add(current.getId())) {
                if (selectedId.equals(current.getId())) { result.add(item.getId()); break; }
                current = current.getParentId() == null ? null : byId.get(current.getParentId());
            }
        }
        return result;
    }

    private String normalizePath(String raw) {
        if (raw == null) return "";
        return Arrays.stream(raw.split("/")).map(String::trim).filter(part -> !part.isEmpty())
                .collect(Collectors.joining(" / "));
    }

    private Object value(Object record, String field) {
        return PropertyAccessorFactory.forBeanPropertyAccess(record).getPropertyValue(field);
    }
    private String text(Object record, String field) {
        return Objects.toString(value(record, field), "");
    }
}
