package com.supervision.service;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONArray;
import com.alibaba.fastjson2.JSONObject;
import com.supervision.entity.Project;
import com.supervision.entity.SafetyLog;
import com.supervision.entity.User;
import com.supervision.util.DocxWriter;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 监理安全日志 Word 排版器。
 *
 * <p>按工程监理行业文书习惯编排：工程基本信息 → 记录与现场条件 → 监理人员信息 →
 * 施工部位及形象进度 → 巡视检查与验收 → 安全问题处理结果 → 重大事项 →
 * 整改闭环 → 现场照片及附件 → 签署确认。所有时间、人员信息均来自服务端数据，
 * 前端无法伪造，导出件可直接用于归档与外部报送。
 *
 * <p>本类不依赖仓储与登录态，便于单元测试直接校验 docx 结构。
 */
@Component
public class SafetyLogWordExporter {

    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd");
    private static final DateTimeFormatter DATETIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

    private static final String FILL_SECTION = "F7F9FC";
    private static final String FILL_ISSUE = "FFF7ED";
    private static final String FILL_REJECT = "FEF2F2";

    private static final int[] SUMMARY_WIDTHS = {700, 1900, 1300, 2870, 1200, 1100};
    private static final int[] CLOSURE_WIDTHS = {1400, 1600, 2000, 4070};
    private static final int[] ATTACHMENT_WIDTHS = {700, 1300, 7070};
    private static final int[] SIGN_WIDTHS = {3023, 3023, 3024};

    /** 单份日志导出。 */
    public byte[] buildSingle(SafetyLog record, Project project, Map<Long, User> users, String exportedBy) {
        String projectName = project == null ? "" : text(project.getName());
        String header = projectName.isBlank()
                ? "监理安全日志　|　" + text(record.getCode())
                : projectName + "　|　" + text(record.getCode());
        DocxWriter writer = new DocxWriter()
                .documentTitle("监理安全日志（" + text(record.getCode()) + "）")
                .header(header)
                .footerNote(generatedBy(exportedBy))
                .title("监 理 安 全 日 志")
                .subtitle("SUPERVISION SAFETY LOG")
                .meta(metaLine(record))
                .rule();
        appendRecord(writer, record, project, users);
        return writer.build();
    }

    /**
     * 批量导出：首页为封面与汇总台账，其后每份日志独立成页，便于装订与逐份归档。
     *
     * @param rangeText 导出范围说明（工程项目、状态、关键字、日期范围等）
     */
    public byte[] buildBatch(List<SafetyLog> records, Map<Long, Project> projects, Map<Long, User> users,
                             String rangeText, String exportedBy) {
        int total = records == null ? 0 : records.size();
        DocxWriter writer = new DocxWriter()
                .documentTitle("监理安全日志汇编（" + total + " 份）")
                .header("监理安全日志汇编　|　共 " + total + " 份")
                .footerNote(generatedBy(exportedBy))
                .title("监 理 安 全 日 志 汇 编")
                .subtitle("SAFETY SUPERVISION LOG COMPILATION")
                .meta("共 " + total + " 份记录　·　" + LocalDate.now().format(DATE))
                .rule();

        writer.heading("一、导出说明");
        writer.keyValues(List.of(
                new String[]{"导出范围", rangeText == null || rangeText.isBlank() ? "全部可见记录" : rangeText},
                new String[]{"记录份数", total + " 份"},
                new String[]{"导 出 人", text(exportedBy)},
                new String[]{"导出时间", LocalDateTime.now().format(DATETIME)}
        ));

        writer.heading("二、日志台账");
        List<List<String>> rows = new ArrayList<>();
        for (int i = 0; i < total; i++) {
            SafetyLog record = records.get(i);
            Project project = projectOf(projects, record.getProjectId());
            User author = userOf(users, record.getAuthorId());
            rows.add(List.of(
                    String.valueOf(i + 1),
                    text(record.getCode()),
                    record.getLogDate() == null ? "—" : record.getLogDate().format(DATE),
                    project == null ? "—" : text(project.getName()),
                    authorName(record, author),
                    statusText(record.getStatus())
            ));
        }
        writer.table(List.of("序号", "日志编号", "记录日期", "工程名称", "记录人", "状态"), rows, SUMMARY_WIDTHS);
        writer.paragraph("说明：本汇编按导出范围汇总台账，后续各页为单份日志全文，可按编号逐份归档。", true);

        for (int i = 0; i < total; i++) {
            SafetyLog record = records.get(i);
            Project project = projectOf(projects, record.getProjectId());
            writer.pageBreak();
            writer.heading("附件 " + (i + 1) + " / " + total + "　" + text(record.getCode()));
            appendRecord(writer, record, project, users);
        }
        return writer.build();
    }

    /** 逐份日志的正文板块。 */
    private void appendRecord(DocxWriter writer, SafetyLog record, Project project,
                              Map<Long, User> users) {
        User author = userOf(users, record.getAuthorId());
        User reviewer = userOf(users, record.getReviewerId());
        User manager = project == null ? null : userOf(users, project.getManagerId());

        writer.heading("一、工程基本信息");
        List<String[]> projectRows = new ArrayList<>();
        projectRows.add(new String[]{"工程名称", project == null ? "—" : text(project.getName())});
        projectRows.add(new String[]{"项目编号", project == null ? "—" : text(project.getCode())});
        projectRows.add(new String[]{"建设单位", project == null ? "—" : text(project.getBuildUnit())});
        projectRows.add(new String[]{"工程地址", project == null ? "—" : text(project.getAddress())});
        projectRows.add(new String[]{"工程类型", project == null ? "—" : text(project.getType())});
        projectRows.add(new String[]{"计划工期", duration(project)});
        projectRows.add(new String[]{"项目总监", manager == null ? "—" : text(manager.getName())});
        if (project != null && !text(project.getDescription()).isBlank()) {
            projectRows.add(new String[]{"工程概况", project.getDescription()});
        }
        writer.keyValues(projectRows);

        writer.heading("二、记录与现场条件");
        writer.keyValues(List.of(
                new String[]{"日志编号", text(record.getCode())},
                new String[]{"记录日期", record.getLogDate() == null ? "—" : record.getLogDate().format(DATE)},
                new String[]{"天气情况", orDash(record.getWeather())},
                new String[]{"风力", orDash(record.getWind())},
                new String[]{"气温", orDash(record.getTemperature())},
                new String[]{"记录版本", "V" + (record.getVersion() == null ? 1 : record.getVersion()) + ".0"},
                new String[]{"记录状态", statusText(record.getStatus())}
        ));

        writer.heading("三、监理人员信息");
        List<String[]> peopleRows = new ArrayList<>();
        peopleRows.add(new String[]{"记录人", authorName(record, author)});
        peopleRows.add(new String[]{"岗位", author == null ? "—" : orDash(author.getPosition())});
        peopleRows.add(new String[]{"执业资格/证书编号", author == null ? "—" : orDash(author.getCertNo())});
        peopleRows.add(new String[]{"审核人", reviewer == null ? "—" : text(reviewer.getName())});
        peopleRows.add(new String[]{"提交时间", stamp(record.getSubmittedAt())});
        peopleRows.add(new String[]{"审核时间", stamp(record.getReviewedAt())});
        if ("rejected".equals(record.getStatus())) {
            String rejectedBy = text(record.getRejectedBy()).isBlank()
                    ? (reviewer == null ? "—" : text(reviewer.getName()))
                    : record.getRejectedBy();
            peopleRows.add(new String[]{"驳回人 / 驳回时间", rejectedBy + " / " + stamp(record.getRejectedAt())});
        }
        writer.keyValues(peopleRows);

        writer.heading("四、施工部位及形象进度");
        writer.block(record.getContent(), FILL_SECTION);

        writer.heading("五、巡视检查内容、资料审核及验收情况");
        writer.block(record.getInspection(), FILL_SECTION);

        writer.heading("六、存在的安全问题及处理结果");
        writer.block(record.getSafety(), FILL_ISSUE);

        writer.heading("七、重大事项");
        writer.block(record.getMajorIssue(), FILL_SECTION);

        writer.heading("八、整改闭环情况");
        writer.table(List.of("环节", "责任人", "时间", "结论 / 说明"), closureRows(record, author, reviewer), CLOSURE_WIDTHS);
        writer.paragraph("闭环结论：" + closureConclusion(record), false);
        if ("rejected".equals(record.getStatus()) && !text(record.getRejectReason()).isBlank()) {
            writer.block("驳回原因：" + record.getRejectReason(), FILL_REJECT);
        }

        writer.heading("九、现场照片及附件清单");
        writer.table(List.of("序号", "类别", "文件名称"), attachmentRows(record), ATTACHMENT_WIDTHS);
        writer.paragraph("说明：现场照片与附件原件存放于系统附件库，可凭日志编号 " + text(record.getCode())
                + " 在“监理安全日志”页面在线查阅或下载，本页仅登记清单。", true);

        writer.heading("十、签署确认");
        writer.table(List.of("编制人（签字）", "审核人（签字）", "记录日期"),
                List.of(List.of(
                        authorName(record, author),
                        reviewer == null ? "—" : text(reviewer.getName()),
                        record.getLogDate() == null ? "—" : record.getLogDate().format(DATE))),
                SIGN_WIDTHS);
        writer.paragraph("本文件由监理现场管理系统依据系统内记录自动生成，导出时间 "
                + LocalDateTime.now().format(DATETIME) + "；打印件经签署后与电子记录具有同等效力。", true);
    }

    // ==================== 业务字段拼装 ====================

    private static List<List<String>> closureRows(SafetyLog record, User author, User reviewer) {
        String status = text(record.getStatus());
        List<List<String>> rows = new ArrayList<>();
        rows.add(List.of("记录编制", authorName(record, author), stamp(record.getCreateTime()),
                "已编制（" + ("draft".equals(status) ? "草稿" : "已提交归档") + "）"));
        if (!"draft".equals(status)) {
            String submitter = text(record.getSubmittedBy()).isBlank() ? authorName(record, author) : record.getSubmittedBy();
            rows.add(List.of("提交审核", submitter, stamp(record.getSubmittedAt()), "已提交项目审核"));
        }
        if ("approved".equals(status)) {
            rows.add(List.of("审核结论", reviewer == null ? "—" : text(reviewer.getName()),
                    stamp(record.getReviewedAt()), "审核通过，问题处理结果已确认"));
        } else if ("rejected".equals(status)) {
            String rejectedBy = text(record.getRejectedBy()).isBlank()
                    ? (reviewer == null ? "—" : text(reviewer.getName()))
                    : record.getRejectedBy();
            rows.add(List.of("审核结论", rejectedBy, stamp(record.getRejectedAt()), "驳回，限期整改"));
            rows.add(List.of("整改反馈", authorName(record, author), "待整改", "按驳回意见整改后重新提交审核"));
        } else if ("submitted".equals(status) || "pending".equals(status)) {
            rows.add(List.of("审核结论", reviewer == null ? "待指定" : text(reviewer.getName()), "待审核",
                    "等待项目审核人审核"));
        } else if ("inactive".equals(status)) {
            rows.add(List.of("记录状态", "—", "—", "记录已作废，不参与闭环统计"));
        }
        return rows;
    }

    private static String closureConclusion(SafetyLog record) {
        String status = text(record.getStatus());
        return switch (status) {
            case "approved" -> "已闭环。本记录经项目审核人审核通过，安全巡视发现的问题已按“安全问题及处理结果”落实，闭环完成。";
            case "rejected" -> "未闭环。本记录被驳回，需按驳回原因整改后重新提交并再次审核。";
            case "submitted", "pending" -> "未闭环。本记录已提交，尚待项目审核人审核确认。";
            case "draft" -> "未闭环。本记录仍为草稿，尚未提交审核。";
            case "inactive" -> "已作废。本记录已删除，不纳入闭环管理。";
            default -> "状态未知，请核实记录流转情况。";
        };
    }

    private static List<List<String>> attachmentRows(SafetyLog record) {
        List<String> photos = namesOf(record.getPhotos());
        List<String> attachments = namesOf(record.getAttachments());
        List<List<String>> rows = new ArrayList<>();
        int index = 1;
        for (String name : photos) {
            rows.add(List.of(String.valueOf(index++), "现场照片", name));
        }
        for (String name : attachments) {
            rows.add(List.of(String.valueOf(index++), "附件材料", name));
        }
        if (rows.isEmpty()) {
            rows.add(List.of("—", "—", "未上传现场照片及附件材料"));
        }
        return rows;
    }

    /** 解析 photos/attachments 字段中的 JSON 数组，兼容纯字符串元素与 {url,name} 对象。 */
    private static List<String> namesOf(String json) {
        List<String> names = new ArrayList<>();
        if (text(json).isBlank()) return names;
        try {
            JSONArray array = JSON.parseArray(json);
            for (int i = 0; i < array.size(); i++) {
                Object item = array.get(i);
                if (item instanceof JSONObject object) {
                    String name = object.getString("name");
                    if (text(name).isBlank()) name = object.getString("url");
                    if (!text(name).isBlank()) names.add(name);
                } else if (item != null) {
                    String value = String.valueOf(item);
                    if (!value.isBlank()) names.add(value);
                }
            }
        } catch (Exception ignored) {
            // 历史脏数据（非 JSON）不影响导出，按空清单处理
        }
        return names;
    }

    private static String metaLine(SafetyLog record) {
        return "记录编号：" + orDash(record.getCode())
                + "　　记录日期：" + (record.getLogDate() == null ? "—" : record.getLogDate().format(DATE))
                + "　　状态：" + statusText(record.getStatus());
    }

    private static String generatedBy(String exportedBy) {
        return "监理现场管理系统自动生成　·　导出人：" + (text(exportedBy).isBlank() ? "系统" : exportedBy)
                + "　·　" + LocalDateTime.now().format(DATETIME);
    }

    private static String duration(Project project) {
        if (project == null) return "—";
        String start = project.getStartDate() == null ? "" : project.getStartDate().format(DATE);
        String end = project.getEndDate() == null ? "" : project.getEndDate().format(DATE);
        if (start.isBlank() && end.isBlank()) return "—";
        return (start.isBlank() ? "—" : start) + " 至 " + (end.isBlank() ? "—" : end);
    }

    private static String statusText(String status) {
        if (status == null || status.isBlank()) return "未知";
        return switch (status) {
            case "draft" -> "草稿（未提交）";
            case "submitted", "pending" -> "待审核";
            case "approved" -> "审核通过";
            case "rejected" -> "已驳回";
            case "inactive" -> "已作废";
            default -> status;
        };
    }

    private static String authorName(SafetyLog record, User author) {
        if (author != null && !text(author.getName()).isBlank()) {
            String position = text(author.getPosition());
            return position.isBlank() ? author.getName() : author.getName() + "（" + position + "）";
        }
        String submittedBy = text(record.getSubmittedBy());
        if (!submittedBy.isBlank()) return submittedBy;
        return record.getAuthorId() == null ? "—" : "用户#" + record.getAuthorId();
    }

    private static Project projectOf(Map<Long, Project> projects, Long projectId) {
        return projects == null || projectId == null ? null : projects.get(projectId);
    }

    private static User userOf(Map<Long, User> users, Long userId) {
        return users == null || userId == null ? null : users.get(userId);
    }

    private static String stamp(LocalDateTime time) {
        return time == null ? "—" : time.format(DATETIME);
    }

    private static String orDash(String value) {
        return text(value).isBlank() ? "—" : value;
    }

    private static String text(String value) {
        return value == null ? "" : value;
    }
}
