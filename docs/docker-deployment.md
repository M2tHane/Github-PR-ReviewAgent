# Docker 测试部署

应用镜像包含 Node.js 24、编译后的服务及管理页、Git、现有 Semgrep 1.136.0 和本地扫描规则。运行身份为容器内 `node` 用户（UID 1000）。PostgreSQL 18 独立容器运行，数据写入持久卷，不向宿主机发布数据库端口。

部署文件为 [Dockerfile](../Dockerfile)、[compose.deploy.yaml](../compose.deploy.yaml) 和 [打包脚本](../scripts/build-image.sh)。原 `compose.yaml` 仍用于本机开发数据库。

## 构建与导出

本机需有运行中的 Docker 和 Buildx。在项目根目录执行：

```sh
scripts/build-image.sh pr-review-agent:test work/docker/pr-review-agent-test.tar.gz
```

脚本构建 Linux amd64 镜像、加载到本地 Docker，再导出 gzip 压缩镜像包。可用 `PLATFORM=linux/arm64` 构建 ARM 服务器镜像。无参数时镜像标签和导出文件名使用当前 Git 短 SHA；实际构建内容来自当前工作区，发布前应检查是否有未提交修改。

镜像构建执行 `npm ci`、TypeScript／管理页构建，最终镜像仅保留运行依赖。构建上下文采用 [.dockerignore](../.dockerignore) 文件白名单，不发送 `.env`、私钥、Git 历史或 `work/`。生产凭据不作为构建参数。

在服务器安装 Docker Engine 和 Compose 插件后，传入镜像包与 Compose 文件，再导入：

```sh
docker load -i pr-review-agent-test.tar.gz
```

服务器还需要 `postgres:18-alpine` 镜像。可在服务器执行 `docker pull postgres:18-alpine`；不能访问镜像仓库时，在同架构机器下载后另行 `docker save`／`docker load` 传输。

## GitHub 自动构建与发布

[Docker image 工作流](../.github/workflows/docker-image.yml) 使用现有 Dockerfile 构建 Linux amd64 镜像：

- PR 指向 main 时验证构建，不登录镜像仓库、不发布镜像，仅有仓库读取权限。
- 提交合并／推送到 main 后，独立发布任务通过 GitHub 自带的 `GITHUB_TOKEN` 登录 GHCR，不需要在仓库配置个人 PAT 或业务凭据。
- 镜像地址为 `ghcr.io/m2thane/github-pr-reviewagent`，标签 `latest` 指向最近成功发布的 main 构建，`sha-完整提交号` 用于固定版本；发布摘要同时记录不可变 digest。
- Action 固定到提交 SHA，构建缓存按架构复用。PR 的过期构建可以取消；main 发布按组串行执行，避免并行覆盖 latest。
- `.env`、GitHub App 私钥及本地 work 仍被构建上下文白名单排除，不需要上传为 Actions Secret。

测试机可从 GHCR 拉取发布镜像，无需上传离线包：

```sh
docker pull ghcr.io/m2thane/github-pr-reviewagent:latest
```

如 GHCR 包保持私有，需先以有该包读取权限的账号通过 `docker login ghcr.io --password-stdin` 登录（拉取凭据仅需 `read:packages`，不是应用运行用的 GitHub App 凭据）。仓库公开不等于新建 GHCR 包自动公开；本工作流不修改包可见性。

在 `deploy.env` 中设置 `APP_IMAGE=ghcr.io/m2thane/github-pr-reviewagent:sha-完整提交号`，再按本文更新步骤执行迁移与启动。自动发布镜像不等于自动部署；当前未给 GitHub 托管执行器配置到内网测试机的访问，也没有自动重启服务器。

## 私密配置

建议使用独立目录 `/opt/pr-review-agent`，目录内容如下：

```text
/opt/pr-review-agent/
  compose.deploy.yaml
  deploy.env
  secrets/
    app.env
    github-app.pem
```

`secrets/app.env` 使用现有服务 `.env`，`github-app.pem` 使用该配置中 `GITHUB_PRIVATE_KEY_PATH` 指向的私钥。两者均通过 SSH 传输，禁止加入 Git 或镜像。`secrets` 目录权限设为 0700；两份文件权限 0600，所有者 UID 1000，使应用容器可以读取。宿主机 root 保持管理权限。

`deploy.env` 保存部署参数（0600）：

```dotenv
APP_IMAGE=pr-review-agent:test
APP_BIND_ADDRESS=192.168.50.207
APP_PORT=3000
POSTGRES_PASSWORD=替换为随机数据库密码
```

使用 `openssl rand -hex 24` 生成数据库密码，可直接用于连接 URL。不要把服务器登录密码复用为数据库密码。Compose 给应用覆盖容器内数据库地址、私钥位置、Semgrep 路径和监听端口；`app.env` 由 Node 的 `--env-file` 解析，保留 Node 对引号、多行内容的行为。

部署前检查 `app.env` 中引用本机地址的其他配置：

- 管理页面 OAuth 回调不能沿用本机 `127.0.0.1` 地址；修改 `GITHUB_OAUTH_CALLBACK_URL` 并同步 GitHub App 的回调配置。
- GitHub Webhook 必须指向 GitHub 能访问的公网 HTTPS 地址并转发到测试机 `/github/webhook`。内网 IP 本身无法接收 GitHub 云端推送；需沿用已有入口的转发或另配入口。
- 企业微信长连接从服务器主动连出，不要求公开回调端口，但服务器必须能访问企微、GitHub 和模型端点。
- 本机代理地址不可直接照搬到服务器；旧 Message Push Webhook 继续禁用。

## 数据与连接切换

只复制 `.env` 不会带上数据库中的群绑定、成员、团队规则、任务历史和去重记录。迁移既有环境时，应备份并完整迁移现有业务库；新空库意味着需要重新绑定和配置。

切换既有机器人时按顺序执行：确认没有活动任务／待发通知 → 停止本机应用和旧 Webhook 转发 → 导出业务库 → 恢复到测试机的新库 → 执行增量迁移 → 启动服务器应用并切换入口。不要让同一个机器人在本机和服务器同时连接；跨数据库的实例锁不能避免连接互踢和重复处理。

导入数据前可先仅启动数据库：

```sh
docker compose --env-file deploy.env -f compose.deploy.yaml up -d --wait postgres
```

本项目迁移程序根据 `schema_migrations` 逐个执行未应用的 SQL。完整恢复时必须保留此表，不能把 baseline 强行应用到已经存在业务表的数据库。备份文件可能含业务文本和配置，按私密文件保管。

## 启动、检查与更新

```sh
docker compose --env-file deploy.env -f compose.deploy.yaml up -d --wait
docker compose --env-file deploy.env -f compose.deploy.yaml ps
docker compose --env-file deploy.env -f compose.deploy.yaml logs --tail=50 app migrate
curl --fail http://192.168.50.207:3000/readyz
```

Compose 等数据库健康后运行一次 `migrate` 容器，迁移成功才启动应用。`migrate` 正常退出码为 0，不是长期运行服务。应用 readiness 同时检查数据库；`/healthz` 只表示 HTTP 进程正常，不能证明机器人已认证或 GitHub 回调已送达。

应用和数据库配置 `unless-stopped`，启动 Docker 后可自动恢复。更新前备份数据库，在无活动任务时停止应用，加载新镜像并修改 `deploy.env` 中的标签，再运行：

```sh
docker compose --env-file deploy.env -f compose.deploy.yaml stop app
docker compose --env-file deploy.env -f compose.deploy.yaml run --rm migrate
docker compose --env-file deploy.env -f compose.deploy.yaml up -d --wait
```

回退应用版本前先确认数据库迁移兼容；不要删除持久卷。`docker compose down` 保留数据库卷，**不要使用 `down -v` 作为普通更新操作**。

## 验收与资源

- 检查应用、数据库健康、迁移退出码、机器人唯一连接及认证后的轮询。
- 检查管理页登录和 GitHub Webhook 真实投递，再用授权测试群／仓库验证任务。不能把 HTTP 200 当作全部链路通过。
- 镜像提供 Git 和 Semgrep；只执行服务自带扫描规则，不安装、构建或测试目标仓库。
- Compose 的应用 readiness 每 30 秒约增加一次数据库 `SELECT 1`；数据库自身健康探针每 5 秒运行一次 `pg_isready`。业务轮询和 Worker 并发沿用现有配置。
- 容器日志每个服务最多保留约 3 × 10 MB。工作区使用容器临时目录，任务结束正常清理；数据库持久卷需监控磁盘。
- 用 `docker stats --no-stream` 记录空闲内存和 CPU，用镜像 inspect 记录镜像大小；生产吞吐、模型延迟及高并发峰值需要真实负载测量。测试环境不可据空闲探针推导性能上限。

实际部署状态及证据记录在 [DEV 清单](tasks/DEV.md)，此文档中的命令是操作说明，不代表已经在目标服务器执行成功。
