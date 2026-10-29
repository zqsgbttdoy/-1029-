package com.supervision.config;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.init.DatabasePopulatorUtils;
import org.springframework.jdbc.datasource.init.ResourceDatabasePopulator;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/** 只给全新空库播种；迁移库和已有手工数据永不覆盖。 */
@Slf4j
@Component
@Profile("local")
@Order(Ordered.HIGHEST_PRECEDENCE)
@RequiredArgsConstructor
public class LocalDataInitializer implements ApplicationRunner {
    private final JdbcTemplate jdbc;
    private final DataSource dataSource;
    @Value("${app.local.data-dir}")
    private String dataDir;

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        List<String> tables = jdbc.queryForList("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='public' AND TABLE_TYPE='BASE TABLE'", String.class);
        if (!tables.contains("sys_user")) throw new IllegalStateException("本地数据库表结构不完整");
        for (String table : tables) {
            Long count = jdbc.queryForObject("SELECT COUNT(*) FROM \"" + table.replace("\"", "\"\"") + "\"", Long.class);
            if (count != null && count > 0) {
                log.info("已检测到本地留存数据，跳过初始种子，不覆盖用户或业务记录");
                return;
            }
        }
        Path root = Path.of(dataDir);
        if (Files.exists(root.resolve("initialized.marker")) || Files.exists(root.resolve("migration.properties")))
            throw new IllegalStateException("已有数据目录变为空库，请恢复备份；不会重新播种");
        ResourceDatabasePopulator populator = new ResourceDatabasePopulator(new ClassPathResource("data-e2e.sql"));
        populator.setSqlScriptEncoding("UTF-8");
        DatabasePopulatorUtils.execute(populator, dataSource);
        log.info("全新本地空库初始化完成；后续启动只保留现有数据");
    }
}
