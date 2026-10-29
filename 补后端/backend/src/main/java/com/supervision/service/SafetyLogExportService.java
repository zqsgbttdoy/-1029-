package com.supervision.service;

import com.supervision.common.DocxFile;
import com.supervision.entity.Project;
import com.supervision.entity.SafetyLog;
import com.supervision.entity.User;
import com.supervision.exception.BusinessException;
import com.supervision.repository.ProjectRepository;
import com.supervision.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 监理安全日志 Word 导出编排。
 *
 * <p>权限口径与列表/详情接口完全一致：单份走 {@link SafetyLogService#getById} 的阅读校验，
 * 批量走与列表相同的项目范围 Specification，因此导出内容不会越过当前账号的数据权限。
 *
 * <p>批量导出为一次查询 + 一次内存排版，单次上限 {@value #MAX_BATCH_SIZE} 份，
 * 避免超大文档与长事务；超出时提示缩小筛选范围，而不是静默截断。
 */
@Service
@Transactional(readOnly = true)
@RequiredArgsConstructor
public class SafetyLogExportService {

    /** 单次批量导出的记录数上限。 */
    public static final int MAX_BATCH_SIZE = 200;

    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd");
    private static final DateTimeFormatter FILE_STAMP = DateTimeFormatter.ofPattern("yyyyMMdd_HHmm");

    private final SafetyLogService safetyLogService;
    private final ProjectRepository projectRepository;
    private final UserRepository userRepository;
    private final ProjectAccessService access;
    private final SafetyLogWordExporter exporter;

    /** 导出单份日志。 */
    public DocxFile exportSingle(Long id) {
        SafetyLog record = safetyLogService.getById(id);
        Map<Long, Project> projects = projectIndex(record.getProjectId() == null
                ? List.of()
                : projectRepository.findAllById(List.of(record.getProjectId())));
        Map<Long, User> users = userIndex(record);
        String fileName = "监理安全日志_"
                + (isBlank(record.getCode()) ? ("ID" + record.getId()) : safeName(record.getCode()))
                + "_" + (record.getLogDate() == null ? LocalDate.now().format(DATE) : record.getLogDate().format(DATE))
                + ".docx";
        byte[] content = exporter.buildSingle(record, projects.get(record.getProjectId()), users, currentUserName());
        return new DocxFile(fileName, content);
    }

    /**
     * 按当前列表筛选条件批量导出（每份日志独立成页，首页附台账汇总）。
     *
     * @param dateFrom 记录日期下限（含），可空
     * @param dateTo   记录日期上限（含），可空
     */
    public DocxFile exportBatch(Long projectId, String code, String status,
                                LocalDate dateFrom, LocalDate dateTo) {
        if (projectId != null) {
            access.requireRead(projectId);
        }
        List<SafetyLog> records = safetyLogService.listForExport(
                projectId, code, status, dateFrom, dateTo, MAX_BATCH_SIZE + 1);
        if (records.isEmpty()) {
            throw new BusinessException(400, "当前筛选条件下没有可导出的监理安全日志");
        }
        if (records.size() > MAX_BATCH_SIZE) {
            throw new BusinessException(400,
                    "单次最多导出 " + MAX_BATCH_SIZE + " 份记录，请缩小筛选范围（如限定工程或日期区间）后重试");
        }
        Set<Long> projectIds = new LinkedHashSet<>();
        for (SafetyLog record : records) {
            if (record.getProjectId() != null) projectIds.add(record.getProjectId());
        }
        Map<Long, Project> projects = projectIndex(projectRepository.findAllById(projectIds));
        Map<Long, User> users = new LinkedHashMap<>();
        for (SafetyLog record : records) {
            collectUsers(record, null, users);
        }
        for (Project project : projects.values()) {
            collectUsers(null, project.getManagerId(), users);
        }
        String range = describeRange(projectId, projects, status, code, dateFrom, dateTo);
        byte[] content = exporter.buildBatch(records, projects, users, range, currentUserName());
        String fileName = "监理安全日志汇编_" + LocalDateTime.now().format(FILE_STAMP) + ".docx";
        return new DocxFile(fileName, content);
    }

    // ==================== 辅助 ====================

    private Map<Long, User> userIndex(SafetyLog record) {
        Map<Long, User> users = new LinkedHashMap<>();
        collectUsers(record, null, users);
        if (record.getProjectId() != null) {
            Project project = projectRepository.findById(record.getProjectId()).orElse(null);
            if (project != null) collectUsers(null, project.getManagerId(), users);
        }
        return users;
    }

    /** 补齐记录涉及的人员（记录人、审核人、项目总监）名称与岗位，供文档展示。 */
    private void collectUsers(SafetyLog record, Long extraUserId, Map<Long, User> users) {
        Set<Long> ids = new LinkedHashSet<>();
        if (record != null) {
            if (record.getAuthorId() != null) ids.add(record.getAuthorId());
            if (record.getReviewerId() != null) ids.add(record.getReviewerId());
        }
        if (extraUserId != null) ids.add(extraUserId);
        ids.removeAll(users.keySet());
        if (ids.isEmpty()) return;
        userRepository.findAllById(ids).forEach(user -> users.put(user.getId(), user));
    }

    private static Map<Long, Project> projectIndex(List<Project> projects) {
        Map<Long, Project> index = new LinkedHashMap<>();
        if (projects == null) return index;
        for (Project project : projects) {
            if (project != null && project.getId() != null) index.put(project.getId(), project);
        }
        return index;
    }

    private static String describeRange(Long projectId, Map<Long, Project> projects, String status,
                                        String code, LocalDate dateFrom, LocalDate dateTo) {
        List<String> parts = new ArrayList<>();
        parts.add(projectId == null
                ? "全部在管工程（按当前账号数据权限）"
                : "工程：" + projectName(projects.get(projectId)));
        parts.add(isBlank(status) ? "全部状态" : "状态：" + statusText(status));
        if (!isBlank(code)) parts.add("编号关键字：" + code.trim());
        if (dateFrom != null || dateTo != null) {
            parts.add("日期：" + (dateFrom == null ? "不限" : dateFrom.format(DATE))
                    + " 至 " + (dateTo == null ? "不限" : dateTo.format(DATE)));
        }
        return String.join("；", parts);
    }

    private static String statusText(String status) {
        if (isBlank(status)) return "全部状态";
        return switch (status) {
            case "draft" -> "草稿";
            case "submitted", "pending" -> "待审核";
            case "approved" -> "审核通过";
            case "rejected" -> "驳回";
            case "inactive" -> "已作废";
            default -> status;
        };
    }

    private String currentUserName() {
        User user = access.currentUser();
        return user == null ? "" : user.getName();
    }

    private static String projectName(Project project) {
        return project == null || isBlank(project.getName()) ? "—" : project.getName();
    }

    private static String safeName(String value) {
        String text = value == null ? "" : value.trim();
        return text.replaceAll("[\\\\/:*?\"<>|\\s]+", "_");
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
