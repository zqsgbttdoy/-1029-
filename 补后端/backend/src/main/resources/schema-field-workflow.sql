-- 现场工作流升级：MySQL 8.0，使用具有 DDL 权限的维护账号执行。
-- 先备份数据库与上传目录、停止所有旧版写入，并在数据库副本演练。
-- mysql 客户端先 USE 正确数据库，再 SOURCE 本文件；不可用 --force 忽略错误。
-- DDL 会隐式提交，不能依靠 ROLLBACK 撤销；失败后按实际结构核对再重跑。
-- 不导入任何示例账号、不授予新的管理员权限、不推断历史审批结论。
-- 可重跑：只补缺失字段及本脚本命名的索引，不修改已有业务正文或状态。

CREATE TABLE IF NOT EXISTS biz_project_member (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    enabled BIT NOT NULL DEFAULT b'1',
    can_review BIT NOT NULL DEFAULT b'0',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_project_member (project_id, user_id),
    KEY idx_project_member_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_uploaded_file (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    url VARCHAR(500) NOT NULL,
    owner_id BIGINT NOT NULL,
    project_id BIGINT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_uploaded_file_url (url),
    KEY idx_uploaded_file_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS biz_field_record_event (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    record_type VARCHAR(40) NOT NULL,
    record_id BIGINT NOT NULL,
    actor_id BIGINT NOT NULL,
    actor_name VARCHAR(100),
    action VARCHAR(40) NOT NULL,
    reason VARCHAR(500),
    snapshot LONGTEXT NOT NULL,
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_field_event_record (record_type, record_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$
DROP PROCEDURE IF EXISTS migrate_field_workflow$$
CREATE PROCEDURE migrate_field_workflow()
BEGIN
    DECLARE n INT DEFAULT 0;
    DECLARE t VARCHAR(64);
    DECLARE d VARCHAR(32);
    IF DATABASE() IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Select the target database first';
    END IF;
    WHILE n < 4 DO
        SET t = ELT(n + 1, 'biz_supervision_diary', 'biz_supervision_log', 'biz_daily_inspection', 'biz_sideline_inspection');
        SET d = ELT(n + 1, 'diary_date', 'log_date', 'inspection_date', 'inspection_date');
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=t AND column_name='lock_version') THEN
            SET @ddl = CONCAT('ALTER TABLE ', t, ' ADD COLUMN lock_version BIGINT NOT NULL DEFAULT 0');
            PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=t AND column_name='request_key') THEN
            SET @ddl = CONCAT('ALTER TABLE ', t, ' ADD COLUMN request_key VARCHAR(64) NULL');
            PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=t AND column_name='request_hash') THEN
            SET @ddl = CONCAT('ALTER TABLE ', t, ' ADD COLUMN request_hash VARCHAR(64) NULL');
            PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=t AND column_name='source_record_id') THEN
            SET @ddl = CONCAT('ALTER TABLE ', t, ' ADD COLUMN source_record_id BIGINT NULL');
            PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=t AND index_name='uk_field_request') THEN
            SET @ddl = CONCAT('ALTER TABLE ', t, ' ADD UNIQUE INDEX uk_field_request (request_key)');
            PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=t AND index_name='idx_field_source') THEN
            SET @ddl = CONCAT('ALTER TABLE ', t, ' ADD INDEX idx_field_source (source_record_id, status)');
            PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=t AND index_name='idx_field_project_date_status') THEN
            SET @ddl = CONCAT('ALTER TABLE ', t, ' ADD INDEX idx_field_project_date_status (project_id, ', d, ', status)');
            PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;
        END IF;
        SET n = n + 1;
    END WHILE;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='biz_supervision_log' AND column_name='diary_sources') THEN
        ALTER TABLE biz_supervision_log ADD COLUMN diary_sources LONGTEXT NULL;
    END IF;
    -- 日志填写规范新增独立栏目，不从旧工作内容推断或拆分正文。
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='biz_supervision_log' AND column_name='construction') THEN
        ALTER TABLE biz_supervision_log ADD COLUMN construction TEXT NULL COMMENT '施工部位及形象进度';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='biz_supervision_log' AND column_name='safety_issues') THEN
        ALTER TABLE biz_supervision_log ADD COLUMN safety_issues TEXT NULL COMMENT '存在的安全问题及处理结果';
    END IF;
    -- 日记填写规范新增栏目只补空列，不拆分或覆盖历史正文。
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='biz_supervision_diary' AND column_name='other_work') THEN
        ALTER TABLE biz_supervision_diary ADD COLUMN other_work TEXT NULL COMMENT '其他工作';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='biz_supervision_diary' AND column_name='new_issues') THEN
        ALTER TABLE biz_supervision_diary ADD COLUMN new_issues TEXT NULL COMMENT '工作中的新问题';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='biz_supervision_diary' AND column_name='material_inspection') THEN
        ALTER TABLE biz_supervision_diary ADD COLUMN material_inspection TEXT NULL COMMENT '材料进场检查';
    END IF;
END$$
CALL migrate_field_workflow()$$
DROP PROCEDURE migrate_field_workflow$$
DELIMITER ;

-- 只初始化缺失的业务版本；旧请求没有幂等凭据，不伪造 request_key。
UPDATE biz_supervision_diary SET version=1 WHERE version IS NULL;
UPDATE biz_supervision_log SET version=1 WHERE version IS NULL;

-- 上线前人工核对输出：pending 兼容为待审核；recorded/fixed 仅存量只读。
-- active、NULL 或其他未知状态不能擅自映射为已通过，应由业务负责人核对后单独迁移。
SELECT 'diary' AS kind, status, COUNT(*) AS total FROM biz_supervision_diary GROUP BY status
UNION ALL SELECT 'log', status, COUNT(*) FROM biz_supervision_log GROUP BY status
UNION ALL SELECT 'daily', status, COUNT(*) FROM biz_daily_inspection GROUP BY status
UNION ALL SELECT 'sideline', status, COUNT(*) FROM biz_sideline_inspection GROUP BY status;

-- 检查四类记录的作者和项目缺失；有结果时先核对历史归属再开放使用。
SELECT 'diary' AS kind, id, project_id, author_id AS actor_id FROM biz_supervision_diary WHERE author_id IS NULL OR project_id IS NULL
UNION ALL SELECT 'log', id, project_id, author_id FROM biz_supervision_log WHERE author_id IS NULL OR project_id IS NULL
UNION ALL SELECT 'daily', id, project_id, inspector_id FROM biz_daily_inspection WHERE inspector_id IS NULL OR project_id IS NULL
UNION ALL SELECT 'sideline', id, project_id, inspector_id FROM biz_sideline_inspection WHERE inspector_id IS NULL OR project_id IS NULL;
