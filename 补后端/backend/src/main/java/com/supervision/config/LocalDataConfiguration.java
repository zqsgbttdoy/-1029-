package com.supervision.config;

import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

/** 在数据源、Hibernate 创建前检查，禁止错误配置把手工库清空或切换到空库。 */
@Configuration
@Profile("local")
public class LocalDataConfiguration {
    @Bean
    static BeanFactoryPostProcessor localStorageGuard(Environment env) {
        return factory -> validate(env);
    }

    public static void validate(Environment env) {
        if (Arrays.stream(env.getActiveProfiles()).anyMatch(p -> p.equals("e2e") || p.equals("prod")))
            throw new IllegalStateException("local 不得与 e2e/prod 同时启用");
        Path root = Path.of(env.getRequiredProperty("app.local.data-dir"));
        if (!root.isAbsolute()) throw new IllegalStateException("本地数据目录必须是绝对路径");
        root = root.normalize();
        String expected = "jdbc:h2:file:" + root.toString().replace('\\', '/')
                + "/db/supervision;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;WRITE_DELAY=0";
        String actual = env.getRequiredProperty("spring.datasource.url").replace('\\', '/');
        for (String override : new String[]{"spring.jpa.properties.hibernate.hbm2ddl.auto",
                "spring.jpa.properties.jakarta.persistence.schema-generation.database.action",
                "spring.jpa.properties.javax.persistence.schema-generation.database.action",
                "spring.jpa.properties.hibernate.connection.url", "spring.datasource.hikari.jdbc-url"}) {
            if (env.containsProperty(override)) throw new IllegalStateException("本地模式不允许底层数据源或建表策略覆盖：" + override);
        }
        if (!expected.equals(actual) || !"update".equals(env.getProperty("spring.jpa.hibernate.ddl-auto"))
                || !"never".equals(env.getProperty("spring.sql.init.mode"))
                || !"127.0.0.1".equals(env.getProperty("server.address"))
                || !"org.h2.Driver".equals(env.getProperty("spring.datasource.driver-class-name"))
                || !"org.hibernate.dialect.H2Dialect".equals(env.getProperty("spring.jpa.properties.hibernate.dialect"))
                || !env.getProperty("app.security.admin-bootstrap", Boolean.class, true)
                || !root.resolve("uploads").equals(Path.of(env.getRequiredProperty("app.upload.dir")).toAbsolutePath().normalize()))
            throw new IllegalStateException("本地留存配置冲突，拒绝启动；不会重建或清空数据库");
        if ((Files.exists(root.resolve("initialized.marker")) || Files.exists(root.resolve("migration.properties")))
                && !Files.isRegularFile(root.resolve("db/supervision.mv.db")))
            throw new IllegalStateException("已有数据标记但数据库文件缺失，请恢复备份，禁止创建空库");
        try {
            Files.createDirectories(root.resolve("db"));
            Files.createDirectories(root.resolve("uploads"));
        } catch (Exception e) { throw new IllegalStateException("无法访问本地数据目录", e); }
    }
}
