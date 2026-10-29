package com.supervision;

import com.supervision.config.LocalDataConfiguration;
import com.supervision.config.LocalDataInitializer;
import com.supervision.controller.LocalStatusController;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** 真正关闭并重建 Spring/H2 上下文，验证数据留存，不接触手工数据库。 */
class LocalPersistenceTest {
    @TempDir Path temp;

    private ConfigurableApplicationContext start(Path root) {
        return new SpringApplicationBuilder(SupervisionApplication.class).web(WebApplicationType.NONE).run(
                "--spring.profiles.active=local", "--app.local.data-dir=" + root.toString().replace('\\', '/'),
                "--spring.main.banner-mode=off", "--logging.level.root=WARN");
    }

    @Test void restartKeepsRecordsFilesPasswordAndSequences() throws Exception {
        Path root = temp.resolve("persistent");
        List<Map<String, Object>> departments;
        String password = new BCryptPasswordEncoder().encode("Local-Test-Changed-9!");
        long id;
        try (var app = start(root)) {
            JdbcTemplate db = app.getBean(JdbcTemplate.class);
            assertTrue(app.getBean(LocalStatusController.class).status().getBody().get("ready").equals(true));
            assertEquals(2, db.queryForObject("select count(*) from sys_user", Integer.class));
            db.update("update sys_user set password=? where name='admin'", password);
            db.update("update sys_department set name='手工修改部门' where id=1");
            db.update("insert into biz_project(name,code,status,manager_id) values ('留存项目','PERSIST-01','active',1)");
            long project = db.queryForObject("select id from biz_project where code='PERSIST-01'", Long.class);
            Files.createDirectories(root.resolve("uploads/20261022"));
            Files.writeString(root.resolve("uploads/20261022/persist.txt"), "重启后附件原文保留");
            String url = "/api/uploads/20261022/persist.txt";
            db.update("insert into biz_uploaded_file(url,owner_id,project_id) values (?,1,?)", url, project);
            db.update("insert into biz_supervision_notice(code,project_id,notice_date,title,content,status,attachments) values ('KEEP-01',?,'2026-10-22','留存通知','手工正文','issued',?)", project, "[{\"url\":\"" + url + "\"}]");
            id = db.queryForObject("select id from biz_supervision_notice where code='KEEP-01'", Long.class);
            departments = db.queryForList("select id,name from sys_department order by id");
        }
        assertTrue(Files.isRegularFile(root.resolve("db/supervision.mv.db")));
        assertTrue(Files.isRegularFile(root.resolve("initialized.marker")));
        for (int attempt = 0; attempt < 2; attempt++) {
            try (var app = start(root)) {
                JdbcTemplate db = app.getBean(JdbcTemplate.class);
                assertEquals(password, db.queryForObject("select password from sys_user where name='admin'", String.class));
                assertEquals(departments, db.queryForList("select id,name from sys_department order by id"));
                assertEquals(2, db.queryForObject("select count(*) from sys_user", Integer.class));
                assertEquals("手工正文", db.queryForObject("select content from biz_supervision_notice where id=?", String.class, id));
                assertEquals("issued", db.queryForObject("select status from biz_supervision_notice where id=?", String.class, id));
                assertEquals(1, db.queryForObject("select count(*) from biz_uploaded_file", Integer.class));
                assertEquals("重启后附件原文保留", Files.readString(root.resolve("uploads/20261022/persist.txt")));
                db.update("insert into sys_department(name,status) values (?,'active')", "重启新增" + attempt);
                assertTrue(db.queryForObject("select max(id) from sys_department", Long.class) > 2);
                departments = db.queryForList("select id,name from sys_department order by id");
            }
        }
    }

    @Test void existingPartialDataIsNeverReseeded() throws Exception {
        Path root = temp.resolve("partial");
        try (var app = start(root)) {
            JdbcTemplate db = app.getBean(JdbcTemplate.class);
            db.update("delete from sys_user_role where user_id=2");
            db.update("delete from sys_user where id=2");
            app.getBean(LocalDataInitializer.class).run(null);
            assertEquals(1, db.queryForObject("select count(*) from sys_user", Integer.class));
        }
        try (var app = start(root)) {
            assertEquals(1, app.getBean(JdbcTemplate.class).queryForObject("select count(*) from sys_user", Integer.class));
        }
    }

    private MockEnvironment environment(Path root) {
        MockEnvironment env = new MockEnvironment();
        env.setActiveProfiles("local");
        String path = root.toString().replace('\\', '/');
        return env.withProperty("app.local.data-dir", path)
                .withProperty("spring.datasource.url", "jdbc:h2:file:" + path + "/db/supervision;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;WRITE_DELAY=0")
                .withProperty("spring.jpa.hibernate.ddl-auto", "update")
                .withProperty("spring.sql.init.mode", "never")
                .withProperty("server.address", "127.0.0.1")
                .withProperty("spring.datasource.driver-class-name", "org.h2.Driver")
                .withProperty("spring.jpa.properties.hibernate.dialect", "org.hibernate.dialect.H2Dialect")
                .withProperty("app.upload.dir", path + "/uploads");
    }

    @ParameterizedTest
    @CsvSource({"spring.jpa.hibernate.ddl-auto,create", "spring.jpa.hibernate.ddl-auto,create-drop", "spring.sql.init.mode,always", "spring.datasource.url,jdbc:h2:mem:wrong", "server.address,0.0.0.0", "app.upload.dir,wrong", "app.security.admin-bootstrap,false", "spring.jpa.properties.hibernate.hbm2ddl.auto,create", "spring.jpa.properties.jakarta.persistence.schema-generation.database.action,drop-and-create", "spring.jpa.properties.javax.persistence.schema-generation.database.action,drop-and-create", "spring.jpa.properties.hibernate.connection.url,jdbc:h2:mem:wrong", "spring.datasource.hikari.jdbc-url,jdbc:h2:mem:wrong"})
    void unsafeOverridesFailBeforeOpeningDatabase(String property, String value) {
        Path root = temp.resolve("guard");
        MockEnvironment env = environment(root).withProperty(property, value);
        assertThrows(IllegalStateException.class, () -> LocalDataConfiguration.validate(env));
        assertFalse(Files.exists(root.resolve("db/supervision.mv.db")));
    }

    @Test void missingDatabaseWithMarkerDoesNotCreateEmptyDatabase() throws Exception {
        Path root = temp.resolve("missing");
        Files.createDirectories(root);
        Files.writeString(root.resolve("initialized.marker"), "persistent-local-v1");
        assertThrows(IllegalStateException.class, () -> LocalDataConfiguration.validate(environment(root)));
        assertFalse(Files.exists(root.resolve("db")));
    }

    @Test void corruptDatabaseIsNotReplacedWithEmptyDatabase() throws Exception {
        Path root = temp.resolve("corrupt");
        Files.createDirectories(root.resolve("db"));
        byte[] corrupt = new byte[8192];
        java.util.Arrays.fill(corrupt, (byte) 19);
        Path database = root.resolve("db/supervision.mv.db");
        Files.write(database, corrupt);
        assertThrows(Exception.class, () -> { try (var ignored = start(root)) { fail("损坏数据库不得启动成功"); } });
        assertArrayEquals(corrupt, Files.readAllBytes(database));
        assertFalse(Files.exists(root.resolve("initialized.marker")));
    }

    @Test void mixedProfilesAreRejected() {
        MockEnvironment env = environment(temp.resolve("mixed"));
        env.setActiveProfiles("local", "e2e");
        assertThrows(IllegalStateException.class, () -> LocalDataConfiguration.validate(env));
    }
}
