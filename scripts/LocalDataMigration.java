import com.sun.tools.attach.VirtualMachine;
import java.io.*;
import java.lang.instrument.Instrumentation;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import java.util.jar.*;
import java.util.regex.*;

/** 一次性本机迁移工具：只读导出旧 JVM 中已有的 H2 库，验证后还原到全新文件库。 */
public class LocalDataMigration {
    private static final String OPTIONS = ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;WRITE_DELAY=0";
    private static final Pattern FILE_URL = Pattern.compile("/api/uploads/[0-9]{8}/[a-zA-Z0-9._-]+");

    public static void main(String[] args) throws Exception {
        if (args.length < 3) throw new IllegalArgumentException("用法：export PID 备份目录 | inspect-local PID 核验目录 | prepare 备份目录 候选目录 | compare 备份目录 新快照目录 | activate 候选目录 数据目录");
        switch (args[0]) {
            case "export":
                export(args[1], Path.of(args[2]).toAbsolutePath(), false);
                break;
            case "inspect-local":
                export(args[1], Path.of(args[2]).toAbsolutePath(), true);
                break;
            case "prepare":
                prepare(Path.of(args[1]).toAbsolutePath(), Path.of(args[2]).toAbsolutePath());
                break;
            case "compare":
                Properties a = read(Path.of(args[1]).resolve("tables.properties"));
                Properties b = read(Path.of(args[2]).resolve("tables.properties"));
                if (!a.equals(b)) throw new IllegalStateException("源库已变化，必须重新导出和验证；旧服务不能停止");
                System.out.println("全部表的内容与序列一致");
                break;
            case "activate":
                activate(Path.of(args[1]).toAbsolutePath(), Path.of(args[2]).toAbsolutePath());
                break;
            default: throw new IllegalArgumentException("未知操作");
        }
    }

    private static void export(String pid, Path dir, boolean local) throws Exception {
        if (Files.exists(dir)) throw new IllegalStateException("拒绝覆盖已有备份：" + dir);
        Files.createDirectories(dir);
        Path agent = dir.resolve("export-agent.jar");
        Manifest mf = new Manifest();
        mf.getMainAttributes().putValue("Manifest-Version", "1.0");
        mf.getMainAttributes().putValue("Agent-Class", "LocalDataMigration");
        try (JarOutputStream out = new JarOutputStream(Files.newOutputStream(agent, StandardOpenOption.CREATE_NEW), mf);
             InputStream in = LocalDataMigration.class.getResourceAsStream("/LocalDataMigration.class")) {
            out.putNextEntry(new JarEntry("LocalDataMigration.class"));
            Objects.requireNonNull(in).transferTo(out);
            out.closeEntry();
        }
        VirtualMachine vm = VirtualMachine.attach(pid);
        try {
            Path remoteWorkingDirectory = Path.of(vm.getSystemProperties().getProperty("user.dir"));
            // Windows Attach 参数使用相对 ASCII 路径，避免 JVM 本机编码损坏中文路径。
            String relative = remoteWorkingDirectory.relativize(dir).toString();
            if (!StandardCharsets.US_ASCII.newEncoder().canEncode(relative)) throw new IllegalStateException("请使用 ASCII 备份目录名");
            vm.loadAgent(agent.toString(), (local ? "local|" : "") + relative);
        } finally { vm.detach(); }
        if (!Files.exists(dir.resolve("export.complete"))) throw new IllegalStateException("导出未完成，请查看备份目录中的 export-error.txt；不要停止旧服务");
        Properties source = read(dir.resolve("source.properties"));
        System.out.println((local ? "只读校验快照已生成（不含 SQL 备份），H2 " : "完整备份已导出，H2 ") + source.getProperty("h2Version") + "，目录：" + dir);
    }

    public static void agentmain(String directory, Instrumentation instrumentation) {
        boolean local = directory.startsWith("local|");
        Path dir = Path.of(local ? directory.substring(6) : directory);
        try {
            String command = System.getProperty("sun.java.command", "");
            String profile = local ? "local" : "e2e";
            if (!command.contains("supervision-site-management") || !command.contains("--spring.profiles.active=" + profile))
                throw new IllegalStateException("只允许读取已确认的本机后端 profile=" + profile);
            if (command.contains("--spring.datasource") || command.contains("--app.upload.dir") || System.getenv("SPRING_DATASOURCE_URL") != null)
                throw new IllegalStateException("存在额外数据路径覆盖，必须人工核验后再迁移");
            Class<?> driverClass = Arrays.stream(instrumentation.getAllLoadedClasses())
                    .filter(c -> c.getName().equals("org.h2.Driver")).findFirst().orElseThrow();
            Driver driver = (Driver) driverClass.getDeclaredConstructor().newInstance();
            Properties credentials = new Properties();
            credentials.setProperty("user", "sa");
            credentials.setProperty("password", "");
            String url = "jdbc:h2:mem:supervision;IFEXISTS=TRUE";
            Path localRoot = null;
            if (local) {
                Matcher dataPath = Pattern.compile("--app\\.local\\.data-dir=(.+?)(?= --|$)").matcher(command);
                if (!dataPath.find()) throw new IllegalStateException("无法确定留存目录，停止只读核验");
                Path root = Path.of(dataPath.group(1)).toAbsolutePath().normalize();
                if (!Files.isRegularFile(root.resolve("db/supervision.mv.db"))) throw new IllegalStateException("留存数据库不存在");
                localRoot = root;
                url = fileUrl(root) + ";IFEXISTS=TRUE";
            }
            try (Connection connection = driver.connect(url, credentials)) {
                if (connection == null) throw new IllegalStateException("无法连接现有 H2 内存库");
                Properties source = new Properties();
                source.setProperty("pid", Long.toString(ProcessHandle.current().pid()));
                source.setProperty("startTime", Long.toString(ManagementFactory.getRuntimeMXBean().getStartTime()));
                source.setProperty("workingDirectory", System.getProperty("user.dir"));
                String uploadDir = System.getProperty("app.upload.dir", System.getenv().getOrDefault("APP_UPLOAD_DIR", "uploads"));
                source.setProperty("uploadDirectory", (local ? localRoot.resolve("uploads") : Path.of(uploadDir).toAbsolutePath().normalize()).toString());
                source.setProperty("inspectionOnly", Boolean.toString(local));
                source.setProperty("h2Version", connection.getMetaData().getDatabaseProductVersion());
                Set<String> urls = new TreeSet<>();
                Properties before = snapshot(connection, urls);
                if (!local) {
                    try (Statement s = connection.createStatement()) {
                        s.execute("SCRIPT TO '" + sqlPath(dir.resolve("database.sql")) + "'");
                    }
                }
                Properties after = snapshot(connection, new TreeSet<>());
                if (!before.equals(after)) throw new IllegalStateException("导出期间数据库发生变化，请暂停录入后重试");
                store(dir.resolve("source.properties"), source);
                store(dir.resolve("tables.properties"), before);
                Files.write(dir.resolve("file-urls.txt"), urls, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW);
                Files.writeString(dir.resolve("export.complete"), "OK", StandardOpenOption.CREATE_NEW);
            }
        } catch (Throwable e) {
            try (PrintWriter out = new PrintWriter(Files.newBufferedWriter(dir.resolve("export-error.txt"), StandardCharsets.UTF_8))) { e.printStackTrace(out); }
            catch (IOException ignored) { }
        }
    }

    private static Properties snapshot(Connection c, Set<String> urls) throws Exception {
        Properties result = new Properties();
        List<String> tables = new ArrayList<>();
        try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='public' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME")) {
            while (r.next()) tables.add(r.getString(1));
        }
        if (!tables.contains("sys_user") || !tables.contains("biz_uploaded_file")) throw new IllegalStateException("不是预期的监理数据库");
        for (String table : tables) {
            List<String> rows = new ArrayList<>();
            try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT * FROM \"" + table.replace("\"", "\"\"") + "\"")) {
                int count = r.getMetaData().getColumnCount();
                while (r.next()) {
                    MessageDigest md = MessageDigest.getInstance("SHA-256");
                    for (int i = 1; i <= count; i++) {
                        String v = r.getString(i);
                        if (v != null) {
                            Matcher matcher = FILE_URL.matcher(v);
                            while (matcher.find()) urls.add(matcher.group());
                        }
                        byte[] bytes = v == null ? new byte[0] : v.getBytes(StandardCharsets.UTF_8);
                        md.update((v == null ? "null:" : bytes.length + ":").getBytes(StandardCharsets.UTF_8));
                        md.update(bytes);
                    }
                    rows.add(HexFormat.of().formatHex(md.digest()));
                }
            }
            Collections.sort(rows);
            result.setProperty(table + ".count", Integer.toString(rows.size()));
            result.setProperty(table + ".sha256", hash(String.join("\n", rows).getBytes(StandardCharsets.UTF_8)));
        }
        try (Statement s = c.createStatement(); ResultSet r = s.executeQuery("SELECT TABLE_NAME,COLUMN_NAME,IDENTITY_BASE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='public' AND IS_IDENTITY='YES' ORDER BY TABLE_NAME,COLUMN_NAME")) {
            while (r.next()) result.setProperty(r.getString(1) + ".sequence." + r.getString(2), r.getString(3));
        }
        return result;
    }

    private static void prepare(Path backup, Path candidate) throws Exception {
        if (!Files.isRegularFile(backup.resolve("database.sql"))) throw new IllegalStateException("只读校验快照不能用于还原，必须提供完整 SQL 备份");
        if (!Files.exists(backup.resolve("export.complete"))) throw new IllegalStateException("缺少导出完成标记");
        if (Files.exists(candidate)) throw new IllegalStateException("拒绝覆盖候选库");
        Files.createDirectories(candidate.resolve("db"));
        Properties source = read(backup.resolve("source.properties"));
        Path backend = Path.of(source.getProperty("workingDirectory"));
        Path workspace = backend.getParent().getParent();
        Path activeUploads = Path.of(source.getProperty("uploadDirectory"));
        // 原目录分开归档；合并时不同内容绝不相互覆盖。
        archive(workspace.resolve("uploads"), backup.resolve("original-uploads/root"));
        archive(backend.resolve("uploads"), backup.resolve("original-uploads/backend"));
        archive(activeUploads, backup.resolve("original-uploads/active"));
        Properties files = new Properties();
        merge(workspace.resolve("uploads"), candidate.resolve("uploads"), files);
        merge(backend.resolve("uploads"), candidate.resolve("uploads"), files);
        merge(activeUploads, candidate.resolve("uploads"), files);
        for (String url : Files.readAllLines(backup.resolve("file-urls.txt"), StandardCharsets.UTF_8)) {
            String relative = url.substring("/api/uploads/".length());
            if (!Files.isRegularFile(activeUploads.resolve(relative))) throw new IllegalStateException("当前上传目录缺少引用文件：" + relative);
            if (!Files.isRegularFile(candidate.resolve("uploads").resolve(relative))) throw new IllegalStateException("候选目录缺少引用文件：" + relative);
        }
        store(backup.resolve("files.properties"), files);
        try (Connection c = DriverManager.getConnection(fileUrl(candidate), "sa", "")) {
            if (!source.getProperty("h2Version").equals(c.getMetaData().getDatabaseProductVersion())) throw new IllegalStateException("H2 版本不一致");
            try (Statement s = c.createStatement()) { s.execute("RUNSCRIPT FROM '" + sqlPath(backup.resolve("database.sql")) + "'"); }
            Properties restored = snapshot(c, new TreeSet<>());
            if (!read(backup.resolve("tables.properties")).equals(restored)) throw new IllegalStateException("还原后的逐表数据或自增序列不一致");
            store(candidate.resolve("tables.properties"), restored);
        }
        Files.writeString(candidate.resolve("verified.properties"), "backup=" + backup.toUri() + "\n", StandardOpenOption.CREATE_NEW);
        System.out.println("还原验证通过：全部表内容、自增序列、文件引用均一致；保全文件 " + files.size() + " 个");
    }

    private static void activate(Path candidate, Path target) throws Exception {
        if (!Files.exists(candidate.resolve("verified.properties"))) throw new IllegalStateException("候选库尚未验证");
        if (Files.exists(target.resolve("db")) || Files.exists(target.resolve("uploads"))) throw new IllegalStateException("目标目录已存在数据，禁止覆盖");
        archive(candidate.resolve("db"), target.resolve("db"));
        archive(candidate.resolve("uploads"), target.resolve("uploads"));
        Files.copy(candidate.resolve("verified.properties"), target.resolve("migration.properties"));
        System.out.println("已复制经过验证的数据库与附件到：" + target + "；原始备份及候选库均保留");
    }

    private static void archive(Path from, Path to) throws Exception {
        if (!Files.exists(from)) return;
        if (Files.exists(to)) throw new IllegalStateException("备份目标已存在：" + to);
        try (var paths = Files.walk(from)) {
            for (Path p : paths.toList()) {
                if (Files.isSymbolicLink(p)) throw new IllegalStateException("不迁移符号链接：" + p);
                Path dest = to.resolve(from.relativize(p));
                if (Files.isDirectory(p)) Files.createDirectories(dest);
                else {
                    Files.copy(p, dest, StandardCopyOption.COPY_ATTRIBUTES);
                    if (!hash(Files.readAllBytes(p)).equals(hash(Files.readAllBytes(dest)))) throw new IOException("复制校验失败：" + p);
                }
            }
        }
    }

    private static void merge(Path from, Path to, Properties manifest) throws Exception {
        Files.createDirectories(to);
        if (!Files.exists(from)) return;
        try (var paths = Files.walk(from)) {
            for (Path p : paths.toList()) {
                if (Files.isSymbolicLink(p)) throw new IllegalStateException("不迁移符号链接：" + p);
                if (!Files.isRegularFile(p)) continue;
                Path relative = from.relativize(p), dest = to.resolve(relative);
                String digest = hash(Files.readAllBytes(p));
                if (Files.exists(dest)) {
                    if (!digest.equals(hash(Files.readAllBytes(dest)))) throw new IllegalStateException("附件同名但内容不同：" + relative);
                } else {
                    Files.createDirectories(dest.getParent());
                    Files.copy(p, dest, StandardCopyOption.COPY_ATTRIBUTES);
                }
                manifest.setProperty(relative.toString().replace('\\', '/'), digest);
            }
        }
    }

    private static String fileUrl(Path root) { return "jdbc:h2:file:" + root.resolve("db/supervision").toString().replace('\\', '/') + OPTIONS; }
    private static String sqlPath(Path path) { return path.toString().replace('\\', '/').replace("'", "''"); }
    private static String hash(byte[] bytes) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    private static Properties read(Path path) throws IOException {
        Properties p = new Properties();
        try (Reader r = Files.newBufferedReader(path, StandardCharsets.UTF_8)) { p.load(r); }
        return p;
    }
    private static void store(Path path, Properties values) throws IOException {
        try (Writer w = Files.newBufferedWriter(path, StandardCharsets.UTF_8, StandardOpenOption.CREATE_NEW)) { values.store(w, "Local data verification"); }
    }
}
