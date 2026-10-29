package com.supervision.util;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 轻量 DOCX（Office Open XML）生成器。
 *
 * <p>按 OOXML 规范直接拼装 word/document.xml 等部件，并用 JDK 自带的 ZipOutputStream 打包，
 * 不引入 Apache POI 等第三方依赖，保证内网离线环境可构建、可部署。
 *
 * <p>仅覆盖监理文书需要的排版能力：公文式标题、章节标题、正文段落、带底色与边框的表格、
 * 文本块、分页、页眉与“第 X 页 共 Y 页”页脚。所有格式均以直接格式（run/paragraph 属性）下发，
 * 不依赖 Styles 的继承关系，避免不同 Word 版本打开时样式漂移。
 */
public final class DocxWriter {

    /** docx 的标准 MIME 类型，供下载响应头使用。 */
    public static final String MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    private static final String NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    private static final String NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

    /** 正文中文字体（宋体），标题中文字体（黑体），西文统一 Times New Roman。 */
    private static final String FONT_BODY = "宋体";
    private static final String FONT_TITLE = "黑体";
    private static final String FONT_LATIN = "Times New Roman";

    private static final String COLOR_INK = "1F2937";
    private static final String COLOR_PRIMARY = "1E3A5F";
    private static final String COLOR_MUTED = "6B7280";
    private static final String BORDER_COLOR = "AEBBCB";
    private static final String LABEL_FILL = "F2F5FA";
    private static final String TITLE_FILL = "E4EBF5";

    /** A4 纸张 11906 缇，左右页边距各 1418 缇（2.5cm），正文可用宽度 9070 缇。 */
    private static final int CONTENT_WIDTH = 9070;

    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'");

    private final StringBuilder body = new StringBuilder();
    private String headerText = "";
    private String footerNote = "";
    private String documentTitle = "监理现场管理系统";

    /** 页眉右侧文字（通常为工程名称 + 记录编号）。 */
    public DocxWriter header(String text) {
        this.headerText = nz(text);
        return this;
    }

    /** 页脚页码下方的灰色说明行，可留空。 */
    public DocxWriter footerNote(String text) {
        this.footerNote = nz(text);
        return this;
    }

    /** 文档属性中的标题，写入 docProps/core.xml。 */
    public DocxWriter documentTitle(String text) {
        this.documentTitle = nz(text);
        return this;
    }

    /** 公文式主标题：居中、加粗、黑体 22 磅。 */
    public DocxWriter title(String text) {
        body.append(paragraph(run(text, 44, true, COLOR_PRIMARY, FONT_TITLE), "center", 0, 40, 240));
        return this;
    }

    /** 主标题下方的英文副标题（小字号、浅灰、字距加宽）。 */
    public DocxWriter subtitle(String text) {
        String run = "<w:r><w:rPr>" + rFonts(FONT_BODY) + "<w:color w:val=\"9AA3B2\"/>"
                + "<w:spacing w:val=\"60\"/><w:sz w:val=\"16\"/><w:szCs w:val=\"16\"/></w:rPr>"
                + "<w:t xml:space=\"preserve\">" + xml(nz(text)) + "</w:t></w:r>";
        body.append(paragraph(run, "center", 0, 60, 240));
        return this;
    }

    /** 标题下的元信息行（编号、日期、状态等），居中浅灰 9 磅。 */
    public DocxWriter meta(String text) {
        if (nz(text).isBlank()) return this;
        body.append(paragraph(run(text, 18, false, "4B5563", FONT_BODY), "center", 0, 60, 240));
        return this;
    }

    /** 标题下的双线分隔，提升公文观感。 */
    public DocxWriter rule() {
        body.append("<w:p><w:pPr><w:pBdr>"
                + "<w:bottom w:val=\"single\" w:sz=\"12\" w:space=\"1\" w:color=\"" + COLOR_PRIMARY + "\"/>"
                + "</w:pBdr><w:spacing w:before=\"0\" w:after=\"200\" w:line=\"240\" w:lineRule=\"auto\"/>"
                + "</w:pPr></w:p>");
        return this;
    }

    /** 章节标题：黑体 13 磅、深蓝、带浅色下划线。 */
    public DocxWriter heading(String text) {
        String pPr = "<w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"2\" w:color=\"C9D4E3\"/></w:pBdr>"
                + "<w:spacing w:before=\"260\" w:after=\"120\" w:line=\"280\" w:lineRule=\"auto\"/>"
                + "<w:keepNext/>";
        body.append("<w:p><w:pPr>" + pPr + "</w:pPr>"
                + run(text, 26, true, COLOR_PRIMARY, FONT_TITLE) + "</w:p>");
        return this;
    }

    /** 正文段落（1.5 倍行距），small=true 时用 9 磅灰色小字。 */
    public DocxWriter paragraph(String text, boolean small) {
        if (nz(text).isBlank()) return this;
        if (small) {
            body.append(paragraph(run(text, 18, false, COLOR_MUTED, FONT_BODY), "left", 60, 60, 300));
        } else {
            body.append(paragraph(run(text, 24, false, COLOR_INK, FONT_BODY), "both", 40, 60, 360));
        }
        return this;
    }

    /** 带边框与底色的文本块，用于大段描述性内容，避免满屏裸露文字。 */
    public DocxWriter block(String text, String fill) {
        StringBuilder sb = new StringBuilder();
        sb.append("<w:tbl><w:tblPr><w:tblW w:w=\"").append(CONTENT_WIDTH).append("\" w:type=\"dxa\"/>")
                .append("<w:tblLayout w:type=\"fixed\"/>")
                .append("<w:tblBorders>").append(borders("6")).append("</w:tblBorders>")
                .append(cellMargins(120, 160)).append("</w:tblPr>")
                .append("<w:tblGrid><w:gridCol w:w=\"").append(CONTENT_WIDTH).append("\"/></w:tblGrid>")
                .append("<w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc>")
                .append("<w:tcPr><w:tcW w:w=\"").append(CONTENT_WIDTH).append("\" w:type=\"dxa\"/>")
                .append(shading(fill)).append("</w:tcPr>");
        List<String> contentLines = lines(text);
        if (contentLines.isEmpty()) {
            sb.append(cellParagraph("（未填写）", 22, false, "9AA3B2", "left", 320));
        } else {
            for (String line : contentLines) {
                sb.append(cellParagraph(line, 22, false, COLOR_INK, "left", 320));
            }
        }
        sb.append("</w:tc></w:tr></w:tbl>");
        sb.append(emptyParagraph());
        body.append(sb);
        return this;
    }

    /** 两列“字段名 / 字段值”信息表，字段名列带浅色底纹。 */
    public DocxWriter keyValues(List<String[]> pairs) {
        int[] widths = fitWidths(new int[]{1900, 7170});
        StringBuilder sb = new StringBuilder(tableOpen(widths, "4"));
        for (String[] pair : pairs) {
            if (pair == null || pair.length < 2) continue;
            sb.append("<w:tr><w:trPr><w:cantSplit/></w:trPr>")
                    .append(cell(nz(pair[0]), widths[0], true, LABEL_FILL, "left", "center"))
                    .append(cell(nz(pair[1]).isBlank() ? "—" : pair[1], widths[1], false, null, "left", "center"))
                    .append("</w:tr>");
        }
        sb.append("</w:tbl>").append(emptyParagraph());
        body.append(sb);
        return this;
    }

    /** 通用表格：首行为表头（浅蓝底纹、加粗居中、跨页重复）。 */
    public DocxWriter table(List<String> headers, List<List<String>> rows, int[] widths) {
        int columns = headers == null ? 0 : headers.size();
        if (columns == 0) return this;
        int[] fitted = fitWidths(widths);
        StringBuilder sb = new StringBuilder(tableOpen(fitted, "4"));
        sb.append("<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>");
        for (int i = 0; i < columns; i++) {
            sb.append(cell(nz(headers.get(i)), fitted[i], true, TITLE_FILL, "center", "center"));
        }
        sb.append("</w:tr>");
        if (rows != null) {
            for (List<String> row : rows) {
                sb.append("<w:tr><w:trPr><w:cantSplit/></w:trPr>");
                for (int i = 0; i < columns; i++) {
                    String value = row != null && i < row.size() ? nz(row.get(i)) : "";
                    String align = i == 0 && columns > 3 ? "center" : "left";
                    sb.append(cell(value.isBlank() ? "—" : value, fitted[i], false, null, align, "center"));
                }
                sb.append("</w:tr>");
            }
        }
        sb.append("</w:tbl>").append(emptyParagraph());
        body.append(sb);
        return this;
    }

    /** 垂直留白，单位缇（1 磅 = 20 缇）。 */
    public DocxWriter spacer(int twips) {
        body.append("<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"").append(Math.max(twips, 0))
                .append("\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr></w:p>");
        return this;
    }

    /** 强制分页，用于批量导出时每份日志独立成页。 */
    public DocxWriter pageBreak() {
        body.append("<w:p><w:pPr><w:spacing w:after=\"0\"/></w:pPr><w:r><w:br w:type=\"page\"/></w:r></w:p>");
        return this;
    }

    /** 生成 docx 字节内容。 */
    public byte[] build() {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        try (ZipOutputStream zip = new ZipOutputStream(out)) {
            // 文档属性时间按 W3CDTF 规范使用 UTC，避免不同时区打开时元数据偏移
            String stamp = LocalDateTime.now(java.time.ZoneOffset.UTC).format(STAMP);
            put(zip, "[Content_Types].xml", contentTypes());
            put(zip, "_rels/.rels", rootRels());
            put(zip, "docProps/core.xml", coreProps(stamp));
            put(zip, "docProps/app.xml", appProps());
            put(zip, "word/document.xml", document());
            put(zip, "word/_rels/document.xml.rels", documentRels());
            put(zip, "word/styles.xml", styles());
            put(zip, "word/header1.xml", headerPart());
            put(zip, "word/footer1.xml", footerPart());
        } catch (IOException e) {
            throw new UncheckedIOException("生成 Word 文档失败", e);
        }
        return out.toByteArray();
    }

    // ==================== 文档部件 ====================

    private String document() {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                + "<w:document xmlns:w=\"" + NS_W + "\" xmlns:r=\"" + NS_R + "\"><w:body>"
                + body
                + "<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"0\"/></w:pPr></w:p>"
                + "<w:sectPr>"
                + "<w:headerReference w:type=\"default\" r:id=\"rId2\"/>"
                + "<w:footerReference w:type=\"default\" r:id=\"rId3\"/>"
                + "<w:pgSz w:w=\"11906\" w:h=\"16838\"/>"
                + "<w:pgMar w:top=\"1247\" w:right=\"1418\" w:bottom=\"1247\" w:left=\"1418\""
                + " w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/>"
                + "<w:cols w:space=\"720\"/><w:docGrid w:type=\"lines\" w:linePitch=\"312\"/>"
                + "</w:sectPr></w:body></w:document>";
    }

    private String headerPart() {
        String text = headerText.isBlank() ? "监理现场管理系统" : headerText;
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                + "<w:hdr xmlns:w=\"" + NS_W + "\">"
                + "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"" + BORDER_COLOR + "\"/></w:pBdr>"
                + "<w:jc w:val=\"right\"/><w:spacing w:before=\"0\" w:after=\"80\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>"
                + run(text, 16, false, COLOR_MUTED, FONT_BODY) + "</w:p></w:hdr>";
    }

    private String footerPart() {
        StringBuilder sb = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n")
                .append("<w:ftr xmlns:w=\"").append(NS_W).append("\">")
                .append("<w:p><w:pPr><w:jc w:val=\"center\"/><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>")
                .append(run("第 ", 16, false, COLOR_MUTED, FONT_BODY))
                .append(field("PAGE", "1"))
                .append(run(" 页  共 ", 16, false, COLOR_MUTED, FONT_BODY))
                .append(field("NUMPAGES", "1"))
                .append(run(" 页", 16, false, COLOR_MUTED, FONT_BODY))
                .append("</w:p>");
        if (!footerNote.isBlank()) {
            sb.append("<w:p><w:pPr><w:jc w:val=\"center\"/><w:spacing w:before=\"40\" w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>")
                    .append(run(footerNote, 14, false, "9AA3B2", FONT_BODY))
                    .append("</w:p>");
        }
        return sb.append("</w:ftr>").toString();
    }

    private static String field(String name, String placeholder) {
        return "<w:r><w:rPr>" + rPr(16, false, COLOR_MUTED, FONT_BODY) + "</w:rPr><w:fldChar w:fldCharType=\"begin\"/></w:r>"
                + "<w:r><w:rPr>" + rPr(16, false, COLOR_MUTED, FONT_BODY) + "</w:rPr>"
                + "<w:instrText xml:space=\"preserve\"> " + name + " </w:instrText></w:r>"
                + "<w:r><w:rPr>" + rPr(16, false, COLOR_MUTED, FONT_BODY) + "</w:rPr><w:fldChar w:fldCharType=\"separate\"/></w:r>"
                + run(placeholder, 16, false, COLOR_MUTED, FONT_BODY)
                + "<w:r><w:rPr>" + rPr(16, false, COLOR_MUTED, FONT_BODY) + "</w:rPr><w:fldChar w:fldCharType=\"end\"/></w:r>";
    }

    private static String contentTypes() {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                + "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
                + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
                + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
                + "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>"
                + "<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>"
                + "<Override PartName=\"/word/header1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml\"/>"
                + "<Override PartName=\"/word/footer1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml\"/>"
                + "<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>"
                + "<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>"
                + "</Types>";
    }

    private static String rootRels() {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>"
                + "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>"
                + "<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/>"
                + "</Relationships>";
    }

    private static String documentRels() {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                + "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>"
                + "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/header\" Target=\"header1.xml\"/>"
                + "<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer\" Target=\"footer1.xml\"/>"
                + "</Relationships>";
    }

    private String coreProps(String stamp) {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                + "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\""
                + " xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\""
                + " xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">"
                + "<dc:title>" + xml(documentTitle) + "</dc:title>"
                + "<dc:creator>监理现场管理系统</dc:creator>"
                + "<cp:lastModifiedBy>监理现场管理系统</cp:lastModifiedBy>"
                + "<dcterms:created xsi:type=\"dcterms:W3CDTF\">" + stamp + "</dcterms:created>"
                + "<dcterms:modified xsi:type=\"dcterms:W3CDTF\">" + stamp + "</dcterms:modified>"
                + "</cp:coreProperties>";
    }

    private static String appProps() {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                + "<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\""
                + " xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\">"
                + "<Application>监理现场管理系统</Application><Company>监理单位</Company>"
                + "</Properties>";
    }

    private static String styles() {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n"
                + "<w:styles xmlns:w=\"" + NS_W + "\">"
                + "<w:docDefaults><w:rPrDefault><w:rPr>" + rFonts(FONT_BODY)
                + "<w:sz w:val=\"24\"/><w:szCs w:val=\"24\"/></w:rPr></w:rPrDefault>"
                + "<w:pPrDefault><w:pPr><w:spacing w:line=\"360\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>"
                + "<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>"
                + "<w:style w:type=\"table\" w:styleId=\"TableNormal\"><w:name w:val=\"Normal Table\"/>"
                + "<w:tblPr><w:tblCellMar><w:top w:w=\"0\" w:type=\"dxa\"/><w:left w:w=\"108\" w:type=\"dxa\"/>"
                + "<w:bottom w:w=\"0\" w:type=\"dxa\"/><w:right w:w=\"108\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr></w:style>"
                + "</w:styles>";
    }

    // ==================== 排版片段 ====================

    private static String tableOpen(int[] widths, String borderSize) {
        StringBuilder sb = new StringBuilder();
        sb.append("<w:tbl><w:tblPr><w:tblW w:w=\"").append(CONTENT_WIDTH).append("\" w:type=\"dxa\"/>")
                .append("<w:tblLayout w:type=\"fixed\"/>")
                .append("<w:tblBorders>").append(borders(borderSize)).append("</w:tblBorders>")
                .append(cellMargins(60, 120)).append("</w:tblPr><w:tblGrid>");
        for (int width : widths) {
            sb.append("<w:gridCol w:w=\"").append(width).append("\"/>");
        }
        return sb.append("</w:tblGrid>").toString();
    }

    private static String cell(String text, int width, boolean bold, String fill, String align, String vAlign) {
        StringBuilder sb = new StringBuilder();
        sb.append("<w:tc><w:tcPr><w:tcW w:w=\"").append(width).append("\" w:type=\"dxa\"/>")
                .append(shading(fill));
        if (vAlign != null) sb.append("<w:vAlign w:val=\"").append(vAlign).append("\"/>");
        sb.append("</w:tcPr>");
        List<String> lines = lines(text);
        if (lines.isEmpty()) lines = List.of("");
        for (String line : lines) {
            sb.append(cellParagraph(line, 21, bold, COLOR_INK, align, 300));
        }
        return sb.append("</w:tc>").toString();
    }

    private static String cellParagraph(String text, int size, boolean bold, String color, String align, int line) {
        String pPr = "<w:spacing w:before=\"20\" w:after=\"20\" w:line=\"" + line + "\" w:lineRule=\"auto\"/>"
                + "<w:jc w:val=\"" + (align == null ? "left" : align) + "\"/>";
        return "<w:p><w:pPr>" + pPr + "</w:pPr>"
                + (nz(text).isEmpty() ? "" : run(text, size, bold, color, FONT_BODY)) + "</w:p>";
    }

    private static String paragraph(String run, String align, int before, int after, int line) {
        String pPr = "<w:spacing w:before=\"" + before + "\" w:after=\"" + after + "\" w:line=\"" + line + "\" w:lineRule=\"auto\"/>"
                + "<w:jc w:val=\"" + (align == null ? "left" : align) + "\"/>";
        return "<w:p><w:pPr>" + pPr + "</w:pPr>" + nz(run) + "</w:p>";
    }

    private static String emptyParagraph() {
        return "<w:p><w:pPr><w:spacing w:before=\"0\" w:after=\"0\" w:line=\"120\" w:lineRule=\"auto\"/></w:pPr></w:p>";
    }

    private static String run(String text, int size, boolean bold, String color, String eastAsiaFont) {
        return "<w:r><w:rPr>" + rPr(size, bold, color, eastAsiaFont) + "</w:rPr>"
                + "<w:t xml:space=\"preserve\">" + xml(text) + "</w:t></w:r>";
    }

    private static String rPr(int size, boolean bold, String color, String eastAsiaFont) {
        StringBuilder sb = new StringBuilder(rFonts(eastAsiaFont));
        if (bold) sb.append("<w:b/><w:bCs/>");
        if (color != null) sb.append("<w:color w:val=\"").append(color).append("\"/>");
        sb.append("<w:sz w:val=\"").append(size).append("\"/><w:szCs w:val=\"").append(size).append("\"/>");
        return sb.toString();
    }

    private static String rFonts(String eastAsiaFont) {
        return "<w:rFonts w:ascii=\"" + FONT_LATIN + "\" w:hAnsi=\"" + FONT_LATIN
                + "\" w:eastAsia=\"" + eastAsiaFont + "\" w:cs=\"" + FONT_LATIN + "\"/>";
    }

    private static String borders(String size) {
        String one = "<w:%s w:val=\"single\" w:sz=\"" + size + "\" w:space=\"0\" w:color=\"" + BORDER_COLOR + "\"/>";
        return String.format(one, "top") + String.format(one, "left") + String.format(one, "bottom")
                + String.format(one, "right") + String.format(one, "insideH") + String.format(one, "insideV");
    }

    private static String cellMargins(int topBottom, int leftRight) {
        return "<w:tblCellMar><w:top w:w=\"" + topBottom + "\" w:type=\"dxa\"/>"
                + "<w:left w:w=\"" + leftRight + "\" w:type=\"dxa\"/>"
                + "<w:bottom w:w=\"" + topBottom + "\" w:type=\"dxa\"/>"
                + "<w:right w:w=\"" + leftRight + "\" w:type=\"dxa\"/></w:tblCellMar>";
    }

    private static String shading(String fill) {
        return fill == null || fill.isBlank() ? "" : "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"" + fill + "\"/>";
    }

    private int[] fitWidths(int[] widths) {
        if (widths == null || widths.length == 0) return new int[]{CONTENT_WIDTH};
        int sum = 0;
        for (int width : widths) sum += Math.max(width, 1);
        int[] fitted = new int[widths.length];
        int accumulated = 0;
        for (int i = 0; i < widths.length; i++) {
            fitted[i] = (int) Math.round(Math.max(widths[i], 1) * (double) CONTENT_WIDTH / sum);
            accumulated += fitted[i];
        }
        fitted[fitted.length - 1] += CONTENT_WIDTH - accumulated;
        return fitted;
    }

    private static List<String> lines(String text) {
        String value = nz(text).replace("\r\n", "\n").replace('\r', '\n');
        if (value.isEmpty()) return List.of();
        return List.of(value.split("\n", -1));
    }

    private static void put(ZipOutputStream zip, String name, String content) throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(content.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }

    private static String nz(String value) {
        return value == null ? "" : value;
    }

    /** 转义 XML 文本节点：过滤 XML 1.0 非法控制符，避免 Word 打开时报文件损坏。 */
    static String xml(String value) {
        String text = nz(value);
        StringBuilder sb = new StringBuilder(text.length() + 16);
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\t' || c == '\n') {
                sb.append(c);
            } else if (c >= 0x20 && c != 0x7F && c != 0xFFFE && c != 0xFFFF) {
                sb.append(c);
            }
        }
        return sb.toString().replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }
}
