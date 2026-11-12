package com.supervision.service;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import com.supervision.exception.BusinessException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import java.util.*;

/** 巡视检查明细是记录快照，不依赖模板，也不代表整改闭环。 */
@Component
@RequiredArgsConstructor
public class InspectionChecklist {
    private final ObjectMapper mapper;
    private static final Set<String> RESULTS = Set.of("unchecked", "compliant", "noncompliant");
    private static final Set<String> TYPES = Set.of("质量问题", "安全问题", "人员问题", "工艺问题", "环保问题", "程序问题", "其他问题");

    private BusinessException invalid(String message) { return new BusinessException(400, message); }

    public ObjectNode parse(String raw) {
        if (raw == null || raw.isBlank()) {
            ObjectNode empty = mapper.createObjectNode(); empty.put("version", 1); empty.putArray("items"); return empty;
        }
        if (raw.length() > 60000) throw invalid("检查明细不能超过 60000 字符");
        try {
            JsonNode root = mapper.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(raw);
            if (!root.isObject() || !root.path("version").isIntegralNumber() || !root.path("version").canConvertToInt() || root.path("version").asInt() != 1
                    || !root.path("items").isArray() || root.path("items").size() > 100)
                throw invalid("检查明细格式或版本不正确，最多 100 项；请保留原始草稿");
            Set<String> ids = new HashSet<>(), problemIds = new HashSet<>();
            int problems = 0, files = 0;
            for (JsonNode item : root.path("items")) {
                checkId(item, ids);
                for (String key : List.of("category", "content", "method", "standard")) checkText(item, key);
                if (!RESULTS.contains(item.path("result").asText())
                        || !item.path("problems").isArray() || item.path("problems").size() > 20)
                    throw invalid("检查项的结果或问题列表无效（每项最多 20 个问题）");
                // 检查项现场照片：可选，旧记录无此字段；与问题附件共用每份 50 个附件的上限
                JsonNode itemPhotos = item.path("photos");
                if (!itemPhotos.isMissingNode()) {
                    if (!itemPhotos.isArray() || itemPhotos.size() > 10) throw invalid("检查项照片必须为列表且最多 10 张");
                    for (JsonNode file : itemPhotos) {
                        checkFile(file, "检查项照片尚未上传或格式无效");
                        files++;
                    }
                }
                for (JsonNode problem : item.path("problems")) {
                    checkId(problem, problemIds);
                    for (String key : List.of("name", "type", "description")) checkText(problem, key);
                    // 问题名称与类型已下线：仅保留说明；历史数据的类型仍校验，新记录可不带
                    if (problem.has("type") && !TYPES.contains(problem.path("type").asText())) throw invalid("问题类型无效");
                    if (!problem.path("attachments").isArray()) throw invalid("问题附件必须为列表");
                    for (JsonNode file : problem.path("attachments")) {
                        if (!file.isObject() || !file.path("url").isTextual() || file.path("url").asText().isBlank())
                            throw invalid("问题附件尚未上传或格式无效");
                        checkText(file, "name");
                        if (file.has("size") && (!file.path("size").isIntegralNumber() || !file.path("size").canConvertToLong() || file.path("size").asLong() < 0 || file.path("size").asLong() > 9007199254740991L))
                            throw invalid("附件大小无效");
                        files++;
                    }
                    problems++;
                }
            }
            if (problems > 200 || files > 50) throw invalid("每份巡视最多 200 个问题、50 个附件（含检查项照片与问题附件）");
            return (ObjectNode) root;
        } catch (BusinessException e) { throw e; }
        catch (Exception e) { throw invalid("检查明细无法解析，请保留原始草稿"); }
    }

    private void checkId(JsonNode node, Set<String> seen) {
        if (!node.isObject() || !node.path("id").isTextual()
                || !node.path("id").asText().matches("[a-zA-Z0-9_-]{1,100}") || !seen.add(node.path("id").asText()))
            throw invalid("检查项或问题 ID 无效或重复");
    }

    private void checkText(JsonNode node, String key) {
        if (node.has(key) && (!node.path(key).isTextual() || node.path(key).asText().length() > 10000))
            throw invalid("检查明细字段 " + key + " 必须为文本且不超过 10000 字符");
    }

    /** 检查项照片与问题附件共用的文件基本校验：必须有 url，name 为文本，size 为非负整数。 */
    private void checkFile(JsonNode file, String message) {
        if (!file.isObject() || !file.path("url").isTextual() || file.path("url").asText().isBlank()) throw invalid(message);
        checkText(file, "name");
        if (file.has("size") && (!file.path("size").isIntegralNumber() || !file.path("size").canConvertToLong()
                || file.path("size").asLong() < 0 || file.path("size").asLong() > 9007199254740991L))
            throw invalid("附件大小无效");
    }

    public String normalize(String raw, String previous, Long uid, String userName) {
        if (raw == null || raw.isBlank()) return previous;
        ObjectNode root = parse(raw);
        Map<String, JsonNode> old = new HashMap<>();
        for (JsonNode item : parse(previous).path("items")) for (JsonNode problem : item.path("problems"))
            old.put(problem.path("id").asText(), problem);
        ObjectNode result = mapper.createObjectNode(); result.put("version", 1);
        ArrayNode items = result.putArray("items");
        for (JsonNode item : root.path("items")) {
            ObjectNode target = items.addObject();
            for (String key : List.of("id", "content", "result")) target.put(key, item.path(key).asText());
            ArrayNode photos = target.putArray("photos");
            for (JsonNode file : item.path("photos")) {
                ObjectNode f = photos.addObject(); f.put("url", file.path("url").asText()); f.put("name", file.path("name").asText());
                if (file.has("size")) f.set("size", file.get("size"));
            }
            ArrayNode problemList = target.putArray("problems");
            for (JsonNode problem : item.path("problems")) {
                ObjectNode p = problemList.addObject();
                p.put("id", problem.path("id").asText());
                // 历史记录的名称与类型原样保留，新建记录仅存说明
                if (problem.hasNonNull("name")) p.put("name", problem.path("name").asText());
                if (problem.hasNonNull("type")) p.put("type", problem.path("type").asText());
                p.put("description", problem.path("description").asText());
                JsonNode saved = old.get(problem.path("id").asText());
                p.put("foundById", saved != null && saved.hasNonNull("foundById") ? saved.path("foundById").asLong() : uid);
                p.put("foundByName", saved != null && saved.hasNonNull("foundByName") ? saved.path("foundByName").asText() : userName);
                ArrayNode fs = p.putArray("attachments");
                for (JsonNode file : problem.path("attachments")) {
                    ObjectNode f = fs.addObject(); f.put("url", file.path("url").asText()); f.put("name", file.path("name").asText());
                    if (file.has("size")) f.set("size", file.get("size"));
                }
            }
        }
        String normalized = result.toString();
        if (normalized.length() > 60000) throw invalid("检查明细含人员信息后超过 60000 字符，请减少内容");
        return normalized;
    }

    public void validateForSubmit(String raw) {
        int n = 0;
        for (JsonNode item : parse(raw).path("items")) {
            n++;
            if (item.path("content").asText().isBlank()) throw invalid("请填写第 " + n + " 项检查内容");
            if ("unchecked".equals(item.path("result").asText()))
                throw invalid("请选择第 " + n + " 项（" + item.path("content").asText() + "）的检查结果");
        }
    }

    public String fileJson(String raw) {
        ArrayNode files = mapper.createArrayNode();
        for (JsonNode item : parse(raw).path("items")) {
            item.path("photos").forEach(files::add);
            for (JsonNode problem : item.path("problems")) problem.path("attachments").forEach(files::add);
        }
        return files.toString();
    }
}
