CREATE DATABASE IF NOT EXISTS supervision_db
    DEFAULT CHARACTER SET utf8mb4
    DEFAULT COLLATE utf8mb4_unicode_ci;

USE supervision_db;

-- ============================================================
-- 系统模块（sys_前缀）
-- ============================================================

-- 已有 MySQL 环境升级时也需建此表；演示 H2 由 Hibernate 自动创建。
CREATE TABLE IF NOT EXISTS sys_token_revocation (
    token_id    VARCHAR(36) NOT NULL COMMENT '已撤销的随机登录标识，不含令牌',
    expires_at  DATETIME(6) NOT NULL COMMENT '原令牌过期时间（UTC）',
    PRIMARY KEY (token_id),
    INDEX idx_token_revocation_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='登录会话撤销记录';

CREATE TABLE IF NOT EXISTS sys_department (
    id          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '部门ID',
    name        VARCHAR(100) NOT NULL                COMMENT '部门名称',
    parent_id   BIGINT                             COMMENT '上级部门ID',
    description VARCHAR(500)                        COMMENT '部门描述',
    leader      VARCHAR(50)                         COMMENT '负责人',
    sort_order  INT                                COMMENT '排序号',
    status      VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    create_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    INDEX idx_sys_department_parent_id (parent_id),
    INDEX idx_sys_department_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='部门表';

CREATE TABLE IF NOT EXISTS sys_user (
    id          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '用户ID',
    name        VARCHAR(50)  NOT NULL                COMMENT '姓名',
    gender      VARCHAR(10)                         COMMENT '性别',
    dept_id     BIGINT                              COMMENT '部门ID',
    position    VARCHAR(50)                         COMMENT '职位',
    cert_no     VARCHAR(50)                         COMMENT '证书编号',
    phone       VARCHAR(20)                         COMMENT '手机号',
    id_card     VARCHAR(20)                         COMMENT '身份证号',
    project_id  BIGINT                              COMMENT '所属项目ID',
    hire_date   DATE                                COMMENT '入职日期',
    status      VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    password    VARCHAR(100)                        COMMENT '密码(BCrypt)',
    avatar      VARCHAR(500)                        COMMENT '头像路径',
    create_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    INDEX idx_sys_user_dept_id (dept_id),
    INDEX idx_sys_user_project_id (project_id),
    INDEX idx_sys_user_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表';

CREATE TABLE IF NOT EXISTS sys_role (
    id          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '角色ID',
    name        VARCHAR(50)  NOT NULL                COMMENT '角色名称',
    code        VARCHAR(50)  NOT NULL                COMMENT '角色编码',
    description VARCHAR(500)                        COMMENT '角色描述',
    status      VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    create_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE INDEX uk_sys_role_code (code),
    INDEX idx_sys_role_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='角色表';

CREATE TABLE IF NOT EXISTS sys_permission (
    id          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '权限ID',
    name        VARCHAR(100) NOT NULL                COMMENT '权限名称',
    code        VARCHAR(100) NOT NULL                COMMENT '权限编码',
    module      VARCHAR(50)                         COMMENT '所属模块',
    description VARCHAR(500)                        COMMENT '权限描述',
    parent_id   BIGINT                              COMMENT '上级权限ID',
    sort_order  INT                                 COMMENT '排序号',
    create_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE INDEX uk_sys_permission_code (code),
    INDEX idx_sys_permission_parent_id (parent_id),
    INDEX idx_sys_permission_module (module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='权限表';

CREATE TABLE IF NOT EXISTS sys_role_permission (
    id             BIGINT   NOT NULL AUTO_INCREMENT COMMENT 'ID',
    role_id        BIGINT   NOT NULL                COMMENT '角色ID',
    permission_id  BIGINT   NOT NULL                COMMENT '权限ID',
    create_time    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time    DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    INDEX idx_sys_role_permission_role_id (role_id),
    INDEX idx_sys_role_permission_permission_id (permission_id),
    UNIQUE INDEX uk_sys_role_permission (role_id, permission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='角色权限关联表';

CREATE TABLE IF NOT EXISTS sys_user_role (
    id          BIGINT   NOT NULL AUTO_INCREMENT COMMENT 'ID',
    user_id     BIGINT   NOT NULL                COMMENT '用户ID',
    role_id     BIGINT   NOT NULL                COMMENT '角色ID',
    create_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    INDEX idx_sys_user_role_user_id (user_id),
    INDEX idx_sys_user_role_role_id (role_id),
    UNIQUE INDEX uk_sys_user_role (user_id, role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户角色关联表';

CREATE TABLE IF NOT EXISTS sys_operation_log (
    id          BIGINT      NOT NULL AUTO_INCREMENT COMMENT '日志ID',
    user_id     BIGINT      NOT NULL                COMMENT '操作用户ID',
    user_name   VARCHAR(50)                         COMMENT '操作用户名',
    action      VARCHAR(50)                         COMMENT '操作动作',
    module      VARCHAR(50)                         COMMENT '操作模块',
    detail      TEXT                                COMMENT '操作详情',
    ip          VARCHAR(50)                         COMMENT 'IP地址',
    create_time DATETIME    DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME    DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    INDEX idx_sys_operation_log_user_id (user_id),
    INDEX idx_sys_operation_log_module (module),
    INDEX idx_sys_operation_log_create_time (create_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='操作日志表';

CREATE TABLE IF NOT EXISTS sys_message (
    id           BIGINT       NOT NULL AUTO_INCREMENT COMMENT '消息ID',
    sender_id    BIGINT                              COMMENT '发送者ID',
    receiver_id  BIGINT       NOT NULL                COMMENT '接收者ID',
    title        VARCHAR(200)                        COMMENT '消息标题',
    content      TEXT                                COMMENT '消息内容',
    type         VARCHAR(30)                         COMMENT '消息类型',
    is_read      VARCHAR(10)                         COMMENT '是否已读',
    related_id   BIGINT                              COMMENT '关联业务ID',
    related_type VARCHAR(50)                         COMMENT '关联业务类型',
    create_time  DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time  DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    INDEX idx_sys_message_receiver_id (receiver_id),
    INDEX idx_sys_message_sender_id (sender_id),
    INDEX idx_sys_message_is_read (is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='消息表';

CREATE TABLE IF NOT EXISTS sys_work_standard_config (
    id          BIGINT       NOT NULL AUTO_INCREMENT COMMENT 'ID',
    name        VARCHAR(100) NOT NULL                COMMENT '配置名称',
    module      VARCHAR(50)                         COMMENT '所属模块',
    standard    VARCHAR(50)                         COMMENT '标准',
    description VARCHAR(500)                        COMMENT '描述',
    status      VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    create_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    INDEX idx_sys_work_standard_config_module (module),
    INDEX idx_sys_work_standard_config_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='工作标准配置表';

-- ============================================================
-- 业务模块（biz_前缀）
-- ============================================================

CREATE TABLE IF NOT EXISTS biz_project (
    id          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '项目ID',
    name        VARCHAR(200) NOT NULL                COMMENT '项目名称',
    code        VARCHAR(50)  NOT NULL                COMMENT '项目编码',
    build_unit  VARCHAR(200)                        COMMENT '建设单位（业主单位）',
    address     VARCHAR(500)                        COMMENT '项目地址',
    type        VARCHAR(50)                         COMMENT '项目类型',
    status      VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    start_date  DATE                                COMMENT '开始日期',
    end_date    DATE                                COMMENT '结束日期',
    description TEXT                                COMMENT '项目描述',
    manager_id  BIGINT                              COMMENT '项目经理ID',
    create_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE INDEX uk_biz_project_code (code),
    INDEX idx_biz_project_status (status),
    INDEX idx_biz_project_manager_id (manager_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='项目表';

CREATE TABLE IF NOT EXISTS biz_daily_inspection (
    id              BIGINT       NOT NULL AUTO_INCREMENT COMMENT 'ID',
    code            VARCHAR(50)  NOT NULL                COMMENT '巡检编号',
    project_id      BIGINT       NOT NULL                COMMENT '项目ID',
    inspection_date DATE         NOT NULL                COMMENT '巡检日期',
    inspector_id    BIGINT                              COMMENT '巡检人ID',
    location        VARCHAR(200)                        COMMENT '巡检位置',
    content         TEXT                                COMMENT '巡检内容',
    issues          TEXT                                COMMENT '发现问题',
    status          VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    photos          TEXT                                COMMENT '照片(JSON)',
    attachments     TEXT                                COMMENT '附件(JSON)',
    create_time     DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time     DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    lock_version BIGINT NOT NULL DEFAULT 0,
    request_key VARCHAR(64),
    request_hash VARCHAR(64),
    source_record_id BIGINT,
    UNIQUE INDEX uk_field_request (request_key),
    INDEX idx_field_source (source_record_id, status),
    INDEX idx_field_project_date_status (project_id, inspection_date, status),
    UNIQUE INDEX uk_biz_daily_inspection_code (code),
    INDEX idx_biz_daily_inspection_project_id (project_id),
    INDEX idx_biz_daily_inspection_inspection_date (inspection_date),
    INDEX idx_biz_daily_inspection_status (status),
    INDEX idx_biz_daily_inspection_inspector_id (inspector_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='日常巡检表';

CREATE TABLE IF NOT EXISTS biz_sideline_inspection (
    id              BIGINT       NOT NULL AUTO_INCREMENT COMMENT 'ID',
    code            VARCHAR(50)  NOT NULL                COMMENT '旁站编号',
    project_id      BIGINT       NOT NULL                COMMENT '项目ID',
    inspection_date DATE         NOT NULL                COMMENT '旁站日期',
    inspector_id    BIGINT                              COMMENT '旁站人ID',
    location        VARCHAR(200)                        COMMENT '旁站位置',
    content         TEXT                                COMMENT '旁站内容',
    start_time      DATETIME                            COMMENT '开始时间',
    end_time        DATETIME                            COMMENT '结束时间',
    status          VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    photos          TEXT                                COMMENT '照片(JSON)',
    attachments     TEXT                                COMMENT '附件(JSON)',
    create_time     DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time     DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    lock_version BIGINT NOT NULL DEFAULT 0,
    request_key VARCHAR(64),
    request_hash VARCHAR(64),
    source_record_id BIGINT,
    UNIQUE INDEX uk_field_request (request_key),
    INDEX idx_field_source (source_record_id, status),
    INDEX idx_field_project_date_status (project_id, inspection_date, status),
    UNIQUE INDEX uk_biz_sideline_inspection_code (code),
    INDEX idx_biz_sideline_inspection_project_id (project_id),
    INDEX idx_biz_sideline_inspection_inspection_date (inspection_date),
    INDEX idx_biz_sideline_inspection_status (status),
    INDEX idx_biz_sideline_inspection_inspector_id (inspector_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='旁站巡检表';

CREATE TABLE IF NOT EXISTS biz_supervision_notice (
    id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT 'ID',
    code          VARCHAR(50)  NOT NULL                COMMENT '通知编号',
    project_id    BIGINT       NOT NULL                COMMENT '项目ID',
    notice_date   DATE         NOT NULL                COMMENT '通知日期',
    author_id     BIGINT                              COMMENT '拟稿人ID',
    title         VARCHAR(200) NOT NULL                COMMENT '通知标题',
    content       TEXT                                COMMENT '通知内容',
    deadline      DATE                                COMMENT '整改截止日期',
    reply_content TEXT                                COMMENT '回复内容',
    reply_date    DATE                                COMMENT '回复日期',
    status        VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    priority      VARCHAR(20)                         COMMENT '优先级',
    photos        TEXT                                COMMENT '照片',
    attachments   TEXT                                COMMENT '附件',
    create_time   DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time   DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE INDEX uk_biz_supervision_notice_code (code),
    INDEX idx_biz_supervision_notice_project_id (project_id),
    INDEX idx_biz_supervision_notice_notice_date (notice_date),
    INDEX idx_biz_supervision_notice_status (status),
    INDEX idx_biz_supervision_notice_author_id (author_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='监理通知表';

CREATE TABLE IF NOT EXISTS biz_work_contact (
    id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT 'ID',
    code          VARCHAR(50)  NOT NULL                COMMENT '联系单编号',
    project_id    BIGINT       NOT NULL                COMMENT '项目ID',
    contact_date  DATE         NOT NULL                COMMENT '联系日期',
    author_id     BIGINT                              COMMENT '拟稿人ID',
    title         VARCHAR(200) NOT NULL                COMMENT '联系单标题',
    content       TEXT                                COMMENT '联系单内容',
    reply_content TEXT                                COMMENT '回复内容',
    reply_date    DATE                                COMMENT '回复日期',
    status        VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    priority      VARCHAR(20)                         COMMENT '优先级',
    photos        TEXT                                COMMENT '照片',
    attachments   TEXT                                COMMENT '附件',
    create_time   DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time   DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE INDEX uk_biz_work_contact_code (code),
    INDEX idx_biz_work_contact_project_id (project_id),
    INDEX idx_biz_work_contact_contact_date (contact_date),
    INDEX idx_biz_work_contact_status (status),
    INDEX idx_biz_work_contact_author_id (author_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='工作联系单表';

CREATE TABLE IF NOT EXISTS biz_supervision_diary (
    id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT 'ID',
    code          VARCHAR(50)  NOT NULL                COMMENT '日记编号',
    project_id    BIGINT       NOT NULL                COMMENT '项目ID',
    diary_date    DATE         NOT NULL                COMMENT '日记日期',
    author_id     BIGINT                              COMMENT '作者ID',
    weather       VARCHAR(30)                         COMMENT '天气',
    wind          VARCHAR(30)                         COMMENT '风力',
    temperature   VARCHAR(30)                         COMMENT '温度',
    construction  TEXT                                COMMENT '施工情况',
    management    TEXT                                COMMENT '管理情况',
    inspection    TEXT                                COMMENT '检查情况',
    other_matters TEXT                                COMMENT '其他事项',
    other_work    TEXT                                COMMENT '其他工作',
    new_issues    TEXT                                COMMENT '工作中的新问题',
    material_inspection TEXT                          COMMENT '材料进场检查',
    status        VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    version       INT                                 COMMENT '版本号',
    reject_reason VARCHAR(500)                        COMMENT '驳回原因',
    photos        TEXT                                COMMENT '照片(JSON)',
    attachments   TEXT                                COMMENT '附件(JSON)',
    morning_meeting TEXT                              COMMENT '晨会记录',
    drawing_review  TEXT                              COMMENT '图纸会审',
    reviewer_id     BIGINT                            COMMENT '审核人ID',
    reviewed_at     DATETIME                          COMMENT '审核时间',
    submitted_at    DATETIME                          COMMENT '提交时间',
    submitted_by    VARCHAR(50)                       COMMENT '提交人',
    rejected_at     DATETIME                          COMMENT '驳回时间',
    rejected_by     VARCHAR(50)                       COMMENT '驳回人',
    create_time   DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time   DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    lock_version BIGINT NOT NULL DEFAULT 0,
    request_key VARCHAR(64),
    request_hash VARCHAR(64),
    source_record_id BIGINT,
    UNIQUE INDEX uk_field_request (request_key),
    INDEX idx_field_source (source_record_id, status),
    INDEX idx_field_project_date_status (project_id, diary_date, status),
    UNIQUE INDEX uk_biz_supervision_diary_code (code),
    INDEX idx_biz_supervision_diary_project_id (project_id),
    INDEX idx_biz_supervision_diary_diary_date (diary_date),
    INDEX idx_biz_supervision_diary_status (status),
    INDEX idx_biz_supervision_diary_author_id (author_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='监理日记表';

CREATE TABLE IF NOT EXISTS biz_supervision_log (
    id              BIGINT       NOT NULL AUTO_INCREMENT COMMENT 'ID',
    code            VARCHAR(50)  NOT NULL                COMMENT '日志编号',
    project_id      BIGINT       NOT NULL                COMMENT '项目ID',
    log_date        DATE         NOT NULL                COMMENT '日志日期',
    week_start      DATE                                COMMENT '周开始日期',
    week_end        DATE                                COMMENT '周结束日期',
    author_id       BIGINT                              COMMENT '作者ID',
    content         TEXT                                COMMENT '工作内容',
    construction    TEXT                                COMMENT '施工部位及形象进度',
    safety_issues   TEXT                                COMMENT '存在的安全问题及处理结果',
    management      TEXT                                COMMENT '管理情况',
    inspection      TEXT                                COMMENT '检查情况',
    morning_meeting TEXT                                COMMENT '晨会记录',
    drawing_review  TEXT                                COMMENT '图纸会审',
    other_matters   TEXT                                COMMENT '其他事项',
    status          VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    version         INT                                 COMMENT '版本号',
    reject_reason   VARCHAR(500)                        COMMENT '驳回原因',
    photos          TEXT                                COMMENT '照片(JSON)',
    attachments     TEXT                                COMMENT '附件(JSON)',
    weather         VARCHAR(30)                         COMMENT '天气',
    wind            VARCHAR(30)                         COMMENT '风力',
    temperature     VARCHAR(30)                         COMMENT '温度',
    reviewer_id     BIGINT                              COMMENT '审核人ID',
    reviewed_at     DATETIME                            COMMENT '审核时间',
    submitted_at    DATETIME                            COMMENT '提交时间',
    submitted_by    VARCHAR(50)                         COMMENT '提交人',
    rejected_at     DATETIME                            COMMENT '驳回时间',
    rejected_by     VARCHAR(50)                         COMMENT '驳回人',
    create_time     DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time     DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    lock_version BIGINT NOT NULL DEFAULT 0,
    request_key VARCHAR(64),
    request_hash VARCHAR(64),
    source_record_id BIGINT,
    diary_sources LONGTEXT,
    UNIQUE INDEX uk_field_request (request_key),
    INDEX idx_field_source (source_record_id, status),
    INDEX idx_field_project_date_status (project_id, log_date, status),
    UNIQUE INDEX uk_biz_supervision_log_code (code),
    INDEX idx_biz_supervision_log_project_id (project_id),
    INDEX idx_biz_supervision_log_log_date (log_date),
    INDEX idx_biz_supervision_log_status (status),
    INDEX idx_biz_supervision_log_author_id (author_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='监理日志表';

CREATE TABLE IF NOT EXISTS biz_safety_log (
    id            BIGINT       NOT NULL AUTO_INCREMENT COMMENT 'ID',
    code          VARCHAR(50)  NOT NULL                COMMENT '日志编号',
    project_id    BIGINT       NOT NULL                COMMENT '项目ID',
    log_date      DATE         NOT NULL                COMMENT '日志日期',
    author_id     BIGINT                              COMMENT '作者ID',
    content       TEXT                                COMMENT '工作内容',
    inspection    TEXT                                COMMENT '检查情况',
    safety        TEXT                                COMMENT '安全情况',
    major_issue   TEXT                                COMMENT '重大问题',
    status        VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    version       INT                                 COMMENT '版本号',
    reject_reason VARCHAR(500)                        COMMENT '驳回原因',
    photos        TEXT                                COMMENT '照片(JSON)',
    attachments   TEXT                                COMMENT '附件(JSON)',
    weather       VARCHAR(30)                         COMMENT '天气',
    wind          VARCHAR(30)                         COMMENT '风力',
    temperature   VARCHAR(30)                         COMMENT '温度',
    reviewer_id   BIGINT                              COMMENT '审核人ID',
    reviewed_at   DATETIME                            COMMENT '审核时间',
    submitted_at  DATETIME                            COMMENT '提交时间',
    submitted_by  VARCHAR(50)                         COMMENT '提交人',
    rejected_at   DATETIME                            COMMENT '驳回时间',
    rejected_by   VARCHAR(50)                         COMMENT '驳回人',
    create_time   DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time   DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE INDEX uk_biz_safety_log_code (code),
    INDEX idx_biz_safety_log_project_id (project_id),
    INDEX idx_biz_safety_log_log_date (log_date),
    INDEX idx_biz_safety_log_status (status),
    INDEX idx_biz_safety_log_author_id (author_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='安全日志表';

CREATE TABLE IF NOT EXISTS biz_meeting_minutes (
    id           BIGINT       NOT NULL AUTO_INCREMENT COMMENT 'ID',
    code         VARCHAR(50)  NOT NULL                COMMENT '会议纪要编号',
    project_id   BIGINT       NOT NULL                COMMENT '项目ID',
    meeting_date DATE         NOT NULL                COMMENT '会议日期',
    author_id    BIGINT                              COMMENT '记录人ID',
    title        VARCHAR(200) NOT NULL                COMMENT '会议标题',
    content      TEXT                                COMMENT '会议内容',
    attendees    VARCHAR(500)                        COMMENT '参会人员',
    location     VARCHAR(200)                        COMMENT '会议地点',
    status       VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    photos       TEXT                                COMMENT '照片(JSON)',
    attachments  TEXT                                COMMENT '附件(JSON)',
    create_time  DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time  DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE INDEX uk_biz_meeting_minutes_code (code),
    INDEX idx_biz_meeting_minutes_project_id (project_id),
    INDEX idx_biz_meeting_minutes_meeting_date (meeting_date),
    INDEX idx_biz_meeting_minutes_status (status),
    INDEX idx_biz_meeting_minutes_author_id (author_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会议纪要表';

CREATE TABLE IF NOT EXISTS biz_supervision_monthly_report (
    id           BIGINT      NOT NULL AUTO_INCREMENT COMMENT 'ID',
    code         VARCHAR(50) NOT NULL                COMMENT '月报编号',
    project_id   BIGINT      NOT NULL                COMMENT '项目ID',
    report_month VARCHAR(10) NOT NULL                COMMENT '报告月份(yyyy-MM)',
    author_id    BIGINT                             COMMENT '作者ID',
    content      TEXT                               COMMENT '月报内容',
    status       VARCHAR(20) DEFAULT 'active'       COMMENT '状态',
    photos       TEXT                               COMMENT '照片(JSON)',
    attachments  TEXT                               COMMENT '附件(JSON)',
    create_time  DATETIME    DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time  DATETIME    DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE INDEX uk_biz_supervision_monthly_report_code (code),
    INDEX idx_biz_supervision_monthly_report_project_id (project_id),
    INDEX idx_biz_supervision_monthly_report_report_month (report_month),
    INDEX idx_biz_supervision_monthly_report_status (status),
    INDEX idx_biz_supervision_monthly_report_author_id (author_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='监理月报表';

CREATE TABLE IF NOT EXISTS biz_sub_item_database (
    id          BIGINT       NOT NULL AUTO_INCREMENT COMMENT 'ID',
    project_id  BIGINT       NOT NULL                COMMENT '项目ID',
    name        VARCHAR(200) NOT NULL                COMMENT '子项名称',
    parent_id   BIGINT                              COMMENT '上级子项ID',
    sort_order  INT                                 COMMENT '排序号',
    description VARCHAR(500)                        COMMENT '描述',
    status      VARCHAR(20)  DEFAULT 'active'       COMMENT '状态',
    create_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    INDEX idx_biz_sub_item_database_project_id (project_id),
    INDEX idx_biz_sub_item_database_parent_id (parent_id),
    INDEX idx_biz_sub_item_database_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='子项数据库表';

CREATE TABLE IF NOT EXISTS biz_project_document (
    id           BIGINT       NOT NULL AUTO_INCREMENT COMMENT 'ID',
    project_id   BIGINT       NOT NULL                COMMENT '项目ID',
    sub_item_id  BIGINT       NOT NULL                COMMENT '子项ID',
    name         VARCHAR(200) NOT NULL                COMMENT '文档名称',
    file_path    VARCHAR(500) NOT NULL                COMMENT '文件路径',
    file_size    BIGINT                              COMMENT '文件大小(字节)',
    upload_date  DATE         NOT NULL                COMMENT '上传日期',
    uploader_id  BIGINT                              COMMENT '上传人ID',
    description  VARCHAR(500)                        COMMENT '描述',
    create_time  DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    update_time  DATETIME     DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    INDEX idx_biz_project_document_project_id (project_id),
    INDEX idx_biz_project_document_sub_item_id (sub_item_id),
    INDEX idx_biz_project_document_uploader_id (uploader_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='项目文档表';

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

-- ============================================================
-- 初始化数据
-- ============================================================

INSERT INTO sys_department (id, name, parent_id, description, leader, sort_order, status) VALUES
(1, '总公司',   NULL, '监理总公司',     '赵总监', 1, 'active'),
(2, '监理一部', 1,    '第一监理事业部', '张监理', 1, 'active'),
(3, '监理二部', 1,    '第二监理事业部', '李监理', 2, 'active');

INSERT INTO sys_user (id, name, gender, dept_id, position, cert_no, phone, id_card, project_id, hire_date, status, password, avatar) VALUES
(1, 'admin',  '男', 1, '系统管理员',     NULL,      '13800000000', NULL,           NULL, '2024-01-01', 'active', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', NULL),
(2, '赵总监', '男', 1, '总监',           'JLZ-001', '13800000001', '110101199001011234', 1,   '2024-01-01', 'active', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', NULL),
(3, '张监理', '男', 2, '专业监理工程师', 'JLG-001', '13800000002', '110101199002021234', 1,   '2024-02-01', 'active', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', NULL),
(4, '李监理', '男', 3, '专业监理工程师', 'JLG-002', '13800000003', '110101199003031234', 2,   '2024-02-01', 'active', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', NULL),
(5, '王监理', '女', 2, '监理员',         'JLY-001', '13800000004', '110101199004041234', 1,   '2024-03-01', 'active', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', NULL),
(6, '陈监理', '男', 3, '监理员',         'JLY-002', '13800000005', '110101199005051234', 3,   '2024-03-01', 'active', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', NULL);

INSERT INTO sys_role (id, name, code, description, status) VALUES
(1, '系统管理员', 'admin', '拥有系统所有权限', 'active');

INSERT INTO sys_user_role (id, user_id, role_id) VALUES
(1, 1, 1),
(2, 2, 1);

INSERT INTO biz_project (id, name, code, build_unit, address, type, status, start_date, end_date, description, manager_id) VALUES
(1, '城东综合体项目', 'PRJ-2024-001', '城东建设发展有限公司', '城东新区建设大道88号',                   '房建工程', 'active', '2024-03-01', '2025-12-31', '城东新区大型商业综合体项目，含商业、办公及地下车库', 2),
(2, '滨河路改造工程', 'PRJ-2024-002', '市城市建设投资集团', '滨河路全段（东起人民路西至建设路）',       '市政工程', 'active', '2024-04-01', '2025-06-30', '滨河路道路拓宽及雨污水管网改造工程',               4),
(3, '科技产业园二期', 'PRJ-2024-003', '高新区科技产业集团', '高新技术开发区科技路168号',               '房建工程', 'active', '2024-05-01', '2026-03-31', '科技产业园二期厂房及配套设施建设项目',             6);

-- ============================================================
-- 性能优化：复合索引补齐已抽离至同目录下的 schema-indexes.sql
-- （原 7 条 ALTER TABLE ... ADD INDEX 非幂等，重复执行会报
-- Duplicate key name，故独立维护）。
-- 首次建库：先执行本脚本，再执行一次 schema-indexes.sql；
-- 已有库：只执行一次 schema-indexes.sql（或其内注释中的在线 DDL）。
-- ============================================================
