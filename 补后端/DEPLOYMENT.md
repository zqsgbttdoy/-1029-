# 监理现场管理系统 — 阿里云服务器部署文档

---

## 1. 项目基本信息

| 项目 | 内容 |
|------|------|
| 项目名称 | 监理现场管理系统（Supervision Site Management System） |
| 项目用途 | 建筑工程监理现场管理，包含监理日记、监理日志、安全日志、通知单、会议纪要、月报等业务模块 |
| 技术架构 | Spring Boot 3.2.5 + MySQL 8.0 + 纯HTML/CSS/JS前端 |
| 预计上线时间 | 2026年6月（具体日期待定） |
| 负责人 | 张监理 |
| 联系方式 | （请填写手机号/邮箱） |

---

## 2. 服务器访问凭证

> 以下信息需由网络管理员提供或确认

| 项目 | 内容 |
|------|------|
| 服务器IP | （待分配，建议：华东区域 ECS） |
| SSH端口 | 22（默认） |
| 登录方式 | SSH密钥对（推荐）或密码 |
| 登录用户 | root 或具备 sudo 权限的用户 |
| 操作系统 | CentOS 7.9 / Ubuntu 22.04 LTS |

---

## 3. 项目文件清单

### 3.1 目录结构

```
项目根目录/
├── index.html                    # 首页仪表盘
├── supervision-diary.html        # 监理日记
├── supervision-log.html          # 监理日志
├── safety-log.html               # 安全日志
├── supervision-notice.html       # 监理通知单
├── work-contact.html             # 工作联系单
├── meeting-minutes.html          # 会议纪要
├── supervision-monthly-report.html # 监理月报
├── daily-inspection.html         # 日常巡检
├── sideline-inspection.html      # 旁站检查
├── sub-item-database.html        # 分项工程库
├── project-ledger.html           # 项目台账
├── project-data-upload.html      # 项目资料上传
├── diary-statistics.html         # 日记统计
├── diary-report.html             # 日记报表
├── log-statistics.html           # 日志统计
├── safety-log-statistics.html    # 安全日志统计
├── message-center.html           # 消息中心
├── work-standard-config.html     # 工作标准配置
├── permission-settings.html      # 权限设置
├── department-management.html    # 部门管理
├── personnel-management.html     # 人员管理
├── process-management.html       # 流程管理
├── operation-log.html            # 操作日志
├── assets/                       # 公共脚本（api/字段 schema/记录渲染/日期时间面板）
├── miniprogram/                  # 微信小程序源码（不随 PC 站点部署）
└── backend/                      # 后端项目
    ├── pom.xml                   # Maven配置
    ├── src/                      # Java源码
    └── apache-maven-3.9.6/       # Maven工具（可不上传）
```

### 3.2 部署包

| 文件 | 说明 | 生成方式 |
|------|------|---------|
| `backend/target/supervision-site-management-1.0.0.jar` | 后端可执行JAR包 | `mvn clean package -DskipTests` |
| 24个HTML文件 | 前端静态页面 | 直接复制 |
| `assets/*.js` | 前端公共脚本（含 `datetime-picker.js` 日期时间选择面板） | 与 HTML 一同复制 |

> 仅前端交互或文案调整（例如旁站起止时间改为点选面板）时，只需覆盖 `assets/` 下相关脚本与对应 HTML，**无需重启后端**；
> 小程序端改动需在微信开发者工具重新上传并提交体验版，不随 PC 静态文件生效。

---

## 4. 运行环境要求

### 4.1 服务器最低配置

| 资源 | 最低要求 | 推荐配置 |
|------|---------|---------|
| CPU | 2核 | 2核 |
| 内存 | 4GB | 4GB |
| 系统盘 | 40GB | 40GB |
| 带宽 | 1Mbps | 5Mbps |

### 4.2 软件环境

| 软件 | 版本要求 | 用途 |
|------|---------|------|
| JDK | 17+（推荐 Eclipse Temurin 17） | 运行Spring Boot后端 |
| MySQL | 8.0+ | 数据库 |
| Nginx | 1.20+ | 反向代理 + 静态文件服务 |

> 注意：服务器上**不需要**安装 Node.js、Python、Maven。Maven仅在构建时使用，可在本地构建后上传JAR包。

### 4.3 端口占用

| 端口 | 服务 | 说明 |
|------|------|------|
| 80 | Nginx | 对外提供HTTP访问 |
| 8080 | Spring Boot | 后端API服务（仅内网访问） |
| 3306 | MySQL | 数据库（仅内网访问） |

### 4.4 防火墙配置

| 规则 | 端口 | 来源 | 说明 |
|------|------|------|------|
| 允许 | 80 | 0.0.0.0/0 | 允许外部HTTP访问 |
| 允许 | 22 | 管理员IP | SSH远程管理 |
| 拒绝 | 8080 | 外网 | 后端API仅通过Nginx代理访问 |
| 拒绝 | 3306 | 外网 | 数据库禁止外网直连 |

---

## 5. 数据库信息

| 项目 | 内容 |
|------|------|
| 数据库类型 | MySQL 8.0+ |
| 数据库名称 | supervision_db |
| 字符集 | utf8mb4 |
| 排序规则 | utf8mb4_unicode_ci |
| 访问地址 | localhost:3306（本机部署时） |
| 账号 | supervision_app（生产专用账号，禁止使用 root 运行应用） |
| 密码 | （强密码，通过环境变量注入，禁止 root/123456，启动时会被校验拦截） |
| 初始化脚本 | `backend/src/main/resources/schema.sql`（建表 + 初始数据）+ `schema-indexes.sql`（复合索引，只执行一次）；生产 ddl-auto=validate，必须先手动执行，见「第二步：首次建库流程」 |

---

## 6. 配置文件

### 6.1 后端配置（application.yml + application-prod.yml）

后端采用双配置文件方案，**生产环境必须设置 `SPRING_PROFILES_ACTIVE=prod` 激活生产配置**：

| 配置文件 | 适用环境 | 关键差异 |
|---------|---------|---------|
| `application.yml` | 开发（默认） | ddl-auto=update、show-sql=true、debug 日志、CORS 放开 `*`、默认弱密钥（仅限开发） |
| `application-prod.yml` | 生产（prod profile） | ddl-auto=**validate**（禁止自动改表）、show-sql=**false**、日志 info/warn、Druid 池 initial/min/max/wait=10/10/50/30000、Hibernate batch_size=50、useSSL=true |

生产关键行为说明：
- **快速失败校验**：应用内置 `ProductionSafetyValidator`，prod 启动时强校验必填环境变量（密钥长度、弱密码、CORS 通配符等），不合规直接启动失败，防止带病上线。
- **文件上传**：扩展名白名单校验，文件以 UUID 重命名并按日期子目录存储 `{上传根目录}/{yyyyMMdd}/{uuid}.{ext}`；返回的 `/api/uploads/...` 原路径**仅作存库标识，不可匿名直出**（Nginx 对 `/api/uploads/`、`/uploads/` 一律 403），预览由前端通过 `/api/files/access` 换取受控签名链接，后端 `/api/files/content` 再验项目权限。
- **分页保护**：所有列表接口 pageSize 全局钳制 ≤ 200，超出自动截断。

### 6.2 生产环境变量清单

> 必填项在 prod 下**无默认值**，缺失或不合规时应用启动失败。示例密钥一律使用占位符，**绝不在文档/脚本/命令行中写真实密钥**。

| 变量名 | 是否必填 | 说明 | 示例 |
|--------|---------|------|------|
| SPRING_PROFILES_ACTIVE | 必填 | 激活生产配置，固定为 `prod` | `prod` |
| APP_JWT_SECRET | 必填 | JWT 签名密钥，**≥32 字符**，不得等于开发默认密钥，也不得保留模板占位值「请替换…」（都会被启动校验拦截） | `openssl rand -base64 48` 生成 |
| APP_UPLOAD_SIGNING_SECRET | 必填 | 附件短时链接独立签名密钥，**≥32 字符**，需单独生成，**不得复用 APP_JWT_SECRET**；多实例部署必须同一密钥 | `openssl rand -base64 48` 生成 |
| SPRING_DATASOURCE_USERNAME | 必填 | 数据库账号，使用专用账号（非 root） | `supervision_app` |
| SPRING_DATASOURCE_PASSWORD | 必填 | 数据库密码，禁止 root/123456 等弱密码（会被启动校验拦截） | `<强密码>` |
| APP_CORS_ALLOWED_ORIGINS | 必填 | 允许跨域来源，逗号分隔的明确域名，**禁止 `*`** | `https://jl.example.com` |
| APP_DEFAULT_RESET_PASSWORD | 必填 | 管理员重置用户密码时的默认密码，**禁止 123456** | `<非123456的初始密码>` |
| SPRING_DATASOURCE_URL | 可选 | 数据库连接串，默认 `jdbc:mysql://localhost:3306/supervision_db?...&useSSL=true&serverTimezone=Asia/Shanghai`（生产默认启用 SSL） | 按需覆盖 |
| APP_UPLOAD_DIR | 必填（生产） | 上传文件物理根目录，位于静态站点根目录**之外**（Nginx 不对该目录做 alias 直出，附件统一走受控签名链接）；默认值 `uploads` 仅适用于开发环境 | `/opt/supervision/uploads` |
| APP_UPLOAD_ALLOWED_EXTENSIONS | 可选 | 上传扩展名白名单（逗号分隔），默认含常见图片/文档/压缩包 | `jpg,jpeg,png,pdf,doc,docx,xls,xlsx` |
| APP_JWT_EXPIRATION | 可选 | JWT 有效期（毫秒），默认 86400000（24 小时） | `86400000` |
| LOG_PATH | 可选 | 日志输出目录，默认 `logs` | `/opt/supervision/logs` |

> **上传目录提示**：生产环境务必显式配置 `APP_UPLOAD_DIR`；该目录只供后端读写，**不要在 Nginx 中为其配置 alias 直接对外服务**（`deploy/nginx-supervision.conf` 已默认封禁 `/api/uploads/` 与 `/uploads/` 匿名访问，附件预览请走 `/api/files/access` 受控链接）。

环境变量设置方式（两种写法）：

```bash
# Linux（写入启动脚本或 /etc/profile.d/，注意脚本文件权限收紧为 600）
export SPRING_PROFILES_ACTIVE=prod
export APP_JWT_SECRET='<openssl rand -base64 48 生成的随机密钥>'
export SPRING_DATASOURCE_USERNAME=supervision_app
export SPRING_DATASOURCE_PASSWORD='<强密码>'
export APP_CORS_ALLOWED_ORIGINS=https://jl.example.com
export APP_DEFAULT_RESET_PASSWORD='<非123456的初始密码>'
export APP_UPLOAD_SIGNING_SECRET='<独立执行 openssl rand -base64 48 生成的随机密钥，不复用 JWT 密钥>'
export APP_UPLOAD_DIR=/opt/supervision/uploads
export LOG_PATH=/opt/supervision/logs
```

```powershell
# Windows PowerShell（仅当前会话生效）
$env:SPRING_PROFILES_ACTIVE = "prod"
$env:APP_JWT_SECRET = "<随机生成的至少32位字符串>"
$env:SPRING_DATASOURCE_USERNAME = "supervision_app"
$env:SPRING_DATASOURCE_PASSWORD = "<强密码>"
$env:APP_CORS_ALLOWED_ORIGINS = "https://jl.example.com"
$env:APP_DEFAULT_RESET_PASSWORD = "<非123456的初始密码>"
$env:APP_UPLOAD_SIGNING_SECRET = "<独立生成的至少32位附件签名密钥>"
$env:APP_UPLOAD_DIR = "D:\supervision\uploads"
$env:LOG_PATH = "D:\supervision\logs"
```

### 6.3 Nginx 配置

> 以下为基础 HTTP 示意配置；生产环境请使用 `deploy/nginx-supervision.conf` 模板（含 HTTPS、安全响应头、上传目录匿名访问封禁与受控链接策略），详见 ALIYUN_DEPLOYMENT.md 第 3-4 节。

```nginx
server {
    listen 80;
    server_name 【域名或IP】;

    # 前端静态文件
    location / {
        root /opt/supervision/static;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # 后端API代理
    location /api/ {
        proxy_pass http://127.0.0.1:8080/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_read_timeout 120s;
        client_max_body_size 100m;
    }
}
```

---

## 7. 部署步骤（完整流程）

### 第一步：服务器环境准备

```bash
# 1. 安装 JDK 17
yum install -y java-17-openjdk java-17-openjdk-devel   # CentOS
# 或
apt install -y openjdk-17-jdk                           # Ubuntu

# 验证
java -version

# 2. 安装 MySQL 8.0
yum install -y mysql-server   # CentOS
# 或
apt install -y mysql-server   # Ubuntu

# 启动并设置开机自启
systemctl start mysqld
systemctl enable mysqld

# 3. 安装 Nginx
yum install -y nginx   # CentOS
# 或
apt install -y nginx   # Ubuntu

systemctl start nginx
systemctl enable nginx
```

### 第二步：首次建库流程（必须在启动后端之前完成）

> **重要**：生产环境 `ddl-auto=validate`，应用**不会**自动建表，只做实体与表结构一致性校验。首次部署必须先手动依次执行 `schema.sql`（建表 + 初始数据，当前共 **24 张表**，含现场记录工作流三表 biz_project_member / biz_uploaded_file / biz_field_record_event）和 `schema-indexes.sql`（复合索引），否则启动直接失败。
>
> **存量库升级**：旧版 21 张表的线上库不能重跑 schema.sql，应执行增量迁移脚本 `backend/src/main/resources/schema-field-workflow.sql`（新建上述三张工作流表，并为四类现场记录表补 request_key/lock_version 等新列），否则 validate 校验失败。

```bash
# 1. 登录 MySQL（root 仅用于建库授权，应用运行使用专用账号）
mysql -u root -p
```

```sql
-- 2. 建库（utf8mb4 字符集）
CREATE DATABASE IF NOT EXISTS supervision_db
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3. 创建应用专用账号并授权（建议 supervision_app，禁止应用使用 root 连接）
CREATE USER 'supervision_app'@'localhost' IDENTIFIED BY '<强密码>';
GRANT SELECT, INSERT, UPDATE, DELETE ON supervision_db.* TO 'supervision_app'@'localhost';
FLUSH PRIVILEGES;

-- 4. 执行初始化脚本（建表 + 初始数据）
USE supervision_db;
SOURCE /opt/supervision/schema.sql;

-- 5. 执行复合索引脚本（仅首次建库时执行一次；重复执行会报 Duplicate key name，可安全忽略）
SOURCE /opt/supervision/schema-indexes.sql;
```

```sql
-- 6. 验证：确认表已建、索引已生效（应能看到 idx_sys_message_receiver_read 等复合索引）
SHOW TABLES;
SHOW INDEX FROM sys_message;
```

> 说明：复合索引已从 schema.sql 抽离至 `schema-indexes.sql` 独立维护。首次建库需依次执行 schema.sql 和 schema-indexes.sql；**存量库**只执行一次索引脚本，或改用「[存量库索引升级](#9-存量库索引升级线上已有库)」章节的在线 DDL（两者均不会被 Spring Boot 自动加载，均需手工执行）。

### 第三步：上传项目文件

```bash
# 在服务器上创建目录
mkdir -p /opt/supervision/static
mkdir -p /opt/supervision/backend
mkdir -p /opt/supervision/logs
mkdir -p /opt/supervision/uploads

# 从本地上传（在本地电脑执行）
scp target/supervision-site-management-1.0.0.jar root@【服务器IP】:/opt/supervision/backend/
scp *.html root@【服务器IP】:/opt/supervision/static/
scp backend/src/main/resources/schema.sql root@【服务器IP】:/opt/supervision/
scp backend/src/main/resources/schema-indexes.sql root@【服务器IP】:/opt/supervision/
```

### 第四步：配置并启动后端

```bash
# 创建启动脚本（Linux）
cat > /opt/supervision/backend/start.sh << 'EOF'
#!/bin/bash
APP_NAME=supervision-site-management-1.0.0.jar
APP_HOME=/opt/supervision/backend
LOG_HOME=/opt/supervision/logs
PID_FILE=$APP_HOME/app.pid

cd $APP_HOME

if [ -f "$PID_FILE" ]; then
    PID=$(cat $PID_FILE)
    if kill -0 $PID 2>/dev/null; then
        echo "应用已在运行，PID: $PID"
        exit 1
    fi
fi

# ===== 环境变量注入（禁止在命令行明文传密码，防止 ps/history 泄露）=====
export SPRING_PROFILES_ACTIVE=prod
export APP_JWT_SECRET='<随机生成的至少32位字符串>'
export SPRING_DATASOURCE_USERNAME=supervision_app
export SPRING_DATASOURCE_PASSWORD='<强密码>'
export APP_CORS_ALLOWED_ORIGINS=https://jl.example.com
export APP_DEFAULT_RESET_PASSWORD='<非123456的初始密码>'
export APP_UPLOAD_SIGNING_SECRET='<独立生成的至少32位附件签名密钥>'
export APP_UPLOAD_DIR=/opt/supervision/uploads
export LOG_PATH=/opt/supervision/logs

nohup java -jar $APP_NAME > /dev/null 2>&1 &

echo $! > $PID_FILE
echo "应用启动成功，PID: $(cat $PID_FILE)"
echo "日志文件: $LOG_HOME/app.log（由 logback 滚动管理，勿依赖 nohup 重定向）"
EOF

# 启动脚本包含数据库密码等敏感信息，收紧权限（仅属主可读写执行）
chmod 700 /opt/supervision/backend/start.sh

# 创建停止脚本
cat > /opt/supervision/backend/stop.sh << 'EOF'
#!/bin/bash
PID_FILE=/opt/supervision/backend/app.pid
if [ -f "$PID_FILE" ]; then
    PID=$(cat $PID_FILE)
    kill $PID
    echo "应用停止中，PID: $PID"
    rm -f $PID_FILE
else
    echo "PID文件不存在，应用可能未运行"
fi
EOF

chmod +x /opt/supervision/backend/stop.sh

# 启动
/opt/supervision/backend/start.sh
```

Windows 服务器（PowerShell）启动写法（同样先设环境变量再启动，命令行不明文传密码）：

```powershell
$env:SPRING_PROFILES_ACTIVE = "prod"
$env:APP_JWT_SECRET = "<随机生成的至少32位字符串>"
$env:SPRING_DATASOURCE_USERNAME = "supervision_app"
$env:SPRING_DATASOURCE_PASSWORD = "<强密码>"
$env:APP_CORS_ALLOWED_ORIGINS = "https://jl.example.com"
$env:APP_DEFAULT_RESET_PASSWORD = "<非123456的初始密码>"
$env:APP_UPLOAD_SIGNING_SECRET = "<独立生成的至少32位附件签名密钥>"
$env:APP_UPLOAD_DIR = "D:\supervision\uploads"
$env:LOG_PATH = "D:\supervision\logs"
java -jar supervision-site-management-1.0.0.jar
```

### 第五步：配置 Nginx

```bash
# 创建Nginx配置
cat > /etc/nginx/conf.d/supervision.conf << 'EOF'
server {
    listen 80;
    server_name 【域名或IP】;

    # 隐藏 Nginx 版本号
    server_tokens off;

    # 安全响应头
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" always;

    location / {
        root /opt/supervision/static;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8080/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_read_timeout 120s;
        # 必须 ≥100m，与后端 max-request-size=100MB 匹配，否则大文件上传被 Nginx 拦截
        client_max_body_size 100m;
    }

    # 附件禁止匿名直出：原路径仅作存库标识，预览走 /api/files/access 受控签名链接
    location ^~ /api/uploads/ { return 403; }
    location ^~ /uploads/ { return 403; }
}
EOF

# 检查配置
nginx -t

# 重新加载
nginx -s reload
```

### 第六步：配置开机自启

```bash
# 1. 创建环境变量文件（敏感信息不写入 service 单元，权限 600）
cat > /opt/supervision/backend/supervision.env << 'EOF'
SPRING_PROFILES_ACTIVE=prod
APP_JWT_SECRET=<随机生成的至少32位字符串>
SPRING_DATASOURCE_USERNAME=supervision_app
SPRING_DATASOURCE_PASSWORD=<强密码>
APP_CORS_ALLOWED_ORIGINS=https://jl.example.com
APP_DEFAULT_RESET_PASSWORD=<非123456的初始密码>
APP_UPLOAD_SIGNING_SECRET=<独立生成的至少32位附件签名密钥>
APP_UPLOAD_DIR=/opt/supervision/uploads
LOG_PATH=/opt/supervision/logs
EOF
chmod 600 /opt/supervision/backend/supervision.env

# 2. 创建 systemd 服务（通过 EnvironmentFile 注入，命令行不出现任何密码）
cat > /etc/systemd/system/supervision.service << 'EOF'
[Unit]
Description=Supervision Site Management System
After=network.target mysqld.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/supervision/backend
EnvironmentFile=/opt/supervision/backend/supervision.env
ExecStart=/usr/bin/java -jar /opt/supervision/backend/supervision-site-management-1.0.0.jar
ExecStop=/bin/kill -15 $MAINPID
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable supervision
systemctl start supervision
```

---

## 8. 日志说明

后端使用 `logback-spring.xml` 管理日志，**无需依赖 nohup/重定向收集日志**：

| 项目 | 说明 |
|------|------|
| 日志位置 | `logs/app.log`（相对应用工作目录），可通过环境变量 `LOG_PATH` 覆盖，如 `/opt/supervision/logs` |
| 滚动策略 | 按天滚动 + 单文件 50MB 切分（`app.yyyy-MM-dd.N.log`），保留 30 天，总量上限 2GB，超出自动清理最旧文件 |
| 异步输出 | 文件输出经 AsyncAppender（队列 512，满时不阻塞业务线程），降低 I/O 对请求延迟的影响 |
| traceId | 每条日志含 `[traceId]` 字段，同一请求全链路共享同一 traceId，排障时用 `grep <traceId> app.log` 可串联单次请求的全部日志 |
| 生产级别 | prod 下业务包 `com.supervision` 为 info、Hibernate SQL 为 warn；控制台仅输出 WARN 及以上，文件为主要查阅入口 |

> 注意：不要再把 `nohup ... > app.log` 的重定向文件当作应用日志，应统一查看 `$LOG_PATH/app.log`。

---

## 9. 存量库索引升级（线上已有库）

> 全新建库在执行 `schema.sql` 后再执行一次 `schema-indexes.sql` 即可创建以下 7 条复合索引，无需重复执行。
> 线上已有库请使用以下 MySQL 8.0 在线 DDL（`ALGORITHM=INPLACE, LOCK=NONE`，不锁表、业务无感）逐条执行；
> 若提示 `Duplicate key name` 说明该索引已存在，可安全忽略。

```sql
ALTER TABLE sys_message ADD INDEX idx_sys_message_receiver_read (receiver_id, is_read), ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE biz_supervision_diary ADD INDEX idx_biz_supervision_diary_project_date (project_id, diary_date), ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE biz_supervision_log ADD INDEX idx_biz_supervision_log_project_date (project_id, log_date), ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE sys_user ADD INDEX idx_sys_user_dept_status (dept_id, status), ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE biz_safety_log ADD INDEX idx_biz_safety_log_project_date (project_id, log_date), ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE biz_daily_inspection ADD INDEX idx_biz_daily_inspection_project_date (project_id, inspection_date), ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE biz_sideline_inspection ADD INDEX idx_biz_sideline_inspection_project_date (project_id, inspection_date), ALGORITHM=INPLACE, LOCK=NONE;
```

索引用途对照：

| 索引 | 支撑场景 |
|------|---------|
| sys_message(receiver_id, is_read) | 消息中心未读列表/未读数 |
| biz_supervision_diary(project_id, diary_date) | 监理日记列表日期范围查询与统计 |
| biz_supervision_log(project_id, log_date) | 监理日志列表日期范围查询与统计 |
| sys_user(dept_id, status) | 人员列表按部门+状态筛选 |
| biz_safety_log(project_id, log_date) | 安全日志列表与统计 |
| biz_daily_inspection(project_id, inspection_date) | 日常巡检列表 |
| biz_sideline_inspection(project_id, inspection_date) | 旁站检查列表 |

验证：`SHOW INDEX FROM sys_message;` 等应能看到对应索引名。

---

## 10. 测试验证方案

### 10.1 服务健康检查

| 检查项 | 验证方法 | 预期结果 |
|--------|---------|---------|
| prod 快速失败校验 | 不设任何环境变量，仅 `SPRING_PROFILES_ACTIVE=prod` 启动 | 启动**失败**并提示缺失项（证明校验生效） |
| 后端启动 | `curl http://localhost:8080/api/users -H "Authorization: Bearer <token>"` | 返回JSON数据（未带 token 应返回 401） |
| Nginx代理 | `curl http://localhost/api/users` | 返回后端响应（401/JSON），非 502 |
| 前端页面 | 浏览器访问 `http://【IP】/` | 显示系统首页 |
| 数据库连接 | 查看日志 `tail -f /opt/supervision/logs/app.log` | 无连接错误，无 validate 校验失败 |

### 10.2 功能验证清单

| 序号 | 功能模块 | 验证方法 | 预期结果 |
|------|---------|---------|---------|
| 1 | 首页仪表盘 | 访问 `http://【IP】/` | 显示项目概览、待办事项 |
| 2 | 监理日记列表 | 点击"监理日记" | 显示日记列表 |
| 3 | 新建监理日记 | 点击"新建"→填写→保存 | 创建成功 |
| 4 | 监理日志列表 | 点击"监理日志" | 显示日志列表 |
| 5 | 从日记获取功能 | 新建日志→点击"从监理日记获取" | 自动填充已审批日记数据 |
| 6 | 通知铃铛 | 点击右上角铃铛 | 弹出消息面板 |
| 7 | 用户资料面板 | 点击右上角用户名 | 弹出下拉菜单 |
| 8 | 头像上传 | 点击"更换头像"→上传图片→裁剪→保存 | 头像更新成功 |
| 9 | 个人设置 | 点击"个人设置" | 弹出设置面板，可修改保存 |
| 10 | 数据统计 | 点击"数据统计"下各模块 | 数据只读可查看 |

---

## 11. 回滚预案

### 11.1 回滚策略

| 场景 | 回滚方式 | 操作 |
|------|---------|------|
| 后端异常 | 回退JAR包 | 替换JAR文件 → 重启服务 |
| 前端异常 | 回退HTML文件 | 替换HTML文件 → 无需重启 |
| 数据库异常 | 恢复数据库备份 | `mysql -u root -p supervision_db < backup.sql` |
| Nginx异常 | 回退配置 | 替换conf文件 → `nginx -s reload` |

### 11.2 回滚操作步骤

```bash
# 1. 停止当前服务
systemctl stop supervision

# 2. 备份当前版本
cp /opt/supervision/backend/supervision-site-management-1.0.0.jar /opt/supervision/backend/backup/

# 3. 恢复上一版本
cp /opt/supervision/backend/backup/supervision-site-management-1.0.0.jar.bak /opt/supervision/backend/supervision-site-management-1.0.0.jar

# 4. 重启服务
systemctl start supervision

# 5. 验证
curl http://localhost:8080/api/users
```

### 11.3 数据库备份（建议每日自动执行）

```bash
# 手动备份
mysqldump -u root -p supervision_db > /opt/supervision/backup/db_$(date +%Y%m%d_%H%M%S).sql

# 定时备份：密码写入 ~/.my.cnf（权限 600）而非 crontab 命令行，避免明文泄露
# ~/.my.cnf 内容：
#   [mysqldump]
#   user=root
#   password=<强密码>
# 然后 crontab -e 添加：
0 2 * * * mysqldump supervision_db > /opt/supervision/backup/db_$(date +\%Y\%m\%d).sql
```

---

## 12. 常见问题排查

| 问题 | 排查方法 | 解决方案 |
|------|---------|---------|
| 页面无法访问 | `systemctl status supervision` | 检查后端是否启动 |
| prod 启动失败 | 查看启动日志中 ProductionSafetyValidator 的提示 | 按提示补齐/修正必填环境变量（密钥长度、弱密码、CORS 等） |
| 启动报 validate 失败 | 日志含 Schema-validation 错误 | 首次部署先执行 schema.sql（24 张表）；存量库升级执行 schema-field-workflow.sql 增量脚本 |
| API返回404 | `curl http://localhost:8080/api/users` | 检查context-path配置 |
| 数据库连接失败 | 查看app.log中的错误信息 | 检查MySQL是否启动、环境变量账号密码是否正确 |
| Nginx 502 Bad Gateway | `curl http://localhost:8080/api/users` | 后端未启动，先启动后端 |
| 文件上传失败 | 检查Nginx的client_max_body_size；确认扩展名在白名单内 | 增大至100m；或通过 APP_UPLOAD_ALLOWED_EXTENSIONS 调整白名单 |
| 端口被占用 | `netstat -tlnp \| grep 8080` | kill占用进程或修改端口 |

---

## 附录：快速部署命令（一键执行版）

```bash
# === 在本地电脑执行 ===
# 1. 构建后端JAR包
cd backend && mvn clean package -DskipTests

# 2. 上传所有文件到服务器
scp target/supervision-site-management-1.0.0.jar root@【IP】:/opt/supervision/backend/
scp ../*.html root@【IP】:/opt/supervision/static/
scp src/main/resources/schema.sql root@【IP】:/opt/supervision/
scp src/main/resources/schema-indexes.sql root@【IP】:/opt/supervision/

# === 在服务器上执行 ===
# 3. 初始化数据库（首次建库，含建库/专用账号授权，详见「第二步：首次建库流程」）
mysql -u root -p < /opt/supervision/schema.sql
# 复合索引脚本只执行一次（已有库已建过索引则跳过；重复执行报 Duplicate key name 可忽略）
mysql -u root -p supervision_db < /opt/supervision/schema-indexes.sql

# 4. 设置环境变量后启动后端（命令行不明文传密码）
export SPRING_PROFILES_ACTIVE=prod
export APP_JWT_SECRET='<随机生成的至少32位字符串>'
export SPRING_DATASOURCE_USERNAME=supervision_app
export SPRING_DATASOURCE_PASSWORD='<强密码>'
export APP_CORS_ALLOWED_ORIGINS=https://jl.example.com
export APP_DEFAULT_RESET_PASSWORD='<非123456的初始密码>'
export APP_UPLOAD_SIGNING_SECRET='<独立生成的至少32位附件签名密钥>'
export APP_UPLOAD_DIR=/opt/supervision/uploads
export LOG_PATH=/opt/supervision/logs
nohup java -jar /opt/supervision/backend/supervision-site-management-1.0.0.jar > /dev/null 2>&1 &

# 5. 配置并启动Nginx（参考第五步和第六步的配置）

# 6. 验证（日志在 $LOG_PATH/app.log）
curl http://localhost/api/users
```
