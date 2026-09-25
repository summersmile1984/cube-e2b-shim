# 部署到 CubeSandbox

本文说明如何把 cube-e2b-shim 部署在一套自建 CubeSandbox 前面，对外提供与 E2B 官方 API 对齐的服务，供 E2B SDK 以及 Mastra 等框架直接使用。

## 1. 架构

```
E2B SDK / Mastra ──HTTPS──▶ 反向代理或 Cloudflare Tunnel ──▶ cube-e2b-shim :3100
                              api.<域名>                        │
                              sandbox.<域名>                    ├─▶ CubeAPI     (控制面，私网)
                              *.<域名>                          ├─▶ cube-proxy  (沙箱流量，私网)
                                                                └─▶ CubeOps     (可选，节点管理)
```

- shim 在同一个端口上同时提供两类服务，按 `Host` 头区分：
  - **API 面**：`api.<域名>`，即 E2B 控制面，包括 `/sandboxes`、`/templates`、`/volumes` 等。
  - **Edge 面**：`<端口>-<沙箱ID>.<域名>` 和 `sandbox.<域名>`，是沙箱流量入口。envd 端口是 49983。
- CubeAPI 密钥只保存在 shim 所在主机上。客户端只拿 shim 签发的 API key。
- CubeAPI、cube-proxy、CubeOps 都**不应**暴露到公网，只需让 shim 主机能访问到。

## 2. 前置条件

| 项目 | 要求 |
|---|---|
| CubeSandbox | 已部署并可用（本文按 v0.7.x 编写） |
| shim 主机 | Linux + systemd，Node.js **≥ 22.5**（状态库使用 `node:sqlite`） |
| 网络 | shim 主机能访问 CubeAPI（默认 `:3000`）和 cube-proxy（HTTP，默认 `:80`）；使用节点管理时还需能访问 CubeOps（默认 `:3010`） |
| 域名 | 一个根域名，比如 `example.com`。需要为 `api`、`sandbox` 和 `*`（通配）三条记录都做解析 |
| 证书 | 能覆盖 `*.example.com` 的证书。用 Cloudflare Tunnel 时由 Cloudflare 自动签发 |
| 磁盘 | `/var/lib/cube-e2b-shim` 必须是持久盘，里面存 SQLite 状态和模板构建文件 |

**必须配置通配 DNS。** 签名文件链接（SDK 的 `downloadUrl`/`uploadUrl`）和沙箱端口访问都走 `<端口>-<沙箱ID>.<域名>` 这种主机名，这一点和 E2B 官方一致。

## 3. 准备 Cube 侧信息

需要收集以下信息，后面填进配置：

| 配置项 | 含义 | 示例 |
|---|---|---|
| `CUBE_API_URL` | CubeAPI 地址 | `http://127.0.0.1:3000` |
| `CUBE_API_KEY` | CubeAPI 的访问密钥 | 部署 Cube 时设置的 key |
| `CUBE_PROXY_URL` | cube-proxy 地址，**必须是 http** | `http://192.168.9.100` |
| `CUBE_DOMAIN` | Cube 内部的沙箱域名，cube-proxy 按它路由 | `cube.app` |
| `CUBE_OPS_URL` / `CUBE_OPS_TOKEN` | 可选，CubeOps 地址和 JWT，用于节点管理接口 | `http://127.0.0.1:3010` |

确认连通性（在 shim 主机上执行）：

```sh
curl -s -H "X-API-Key: $CUBE_API_KEY" "$CUBE_API_URL/health"
curl -s -H "X-API-Key: $CUBE_API_KEY" "$CUBE_API_URL/templates" | head -c 300
```

## 4. 安装 shim

### 4.1 获取代码并构建

```sh
sudo git clone https://github.com/summersmile1984/cube-e2b-shim.git /opt/cube-e2b-shim
cd /opt/cube-e2b-shim
sudo npm ci
sudo npm run build
sudo npm prune --omit=dev
```

也可以用发布包：打 `v*` 标签后，GitHub Release 里会生成 `cube-e2b-shim-<版本>.tgz` 和对应的 sha256 文件。把它解压到 `/opt/cube-e2b-shim`，再执行 `npm ci --omit=dev`。

### 4.2 创建运行用户和 systemd 服务

```sh
sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin cube-shim
sudo cp contrib/cube-e2b-shim.service /etc/systemd/system/cube-e2b-shim.service
sudo install -m 0600 contrib/cube-e2b-shim.env.example /etc/cube-e2b-shim.env
```

服务单元通过 `StateDirectory` 自动创建 `/var/lib/cube-e2b-shim`，并只允许向这个目录写入。

## 5. 配置

编辑 `/etc/cube-e2b-shim.env`（`sudoedit /etc/cube-e2b-shim.env`）。可以先生成几个随机值：

```sh
openssl rand -hex 32   # 分别用作 API key、管理员令牌、访问令牌、加密密钥
```

### 5.1 必填

```ini
# 发给客户端的 E2B API key，多个用逗号分隔
SHIM_API_KEYS=<随机值>

# CubeAPI
CUBE_API_URL=http://127.0.0.1:3000
CUBE_API_KEY=<Cube 的密钥>

# cube-proxy（必须是 http）以及 Cube 内部域名
CUBE_PROXY_URL=http://192.168.9.100
CUBE_DOMAIN=cube.app

# 对外的根域名：会写进沙箱响应，也用于识别 Edge 面
SHIM_DOMAIN=example.com

# 状态库：必须持久化。其中保存着 envd token，丢失后所有已有沙箱的 envd 都会返回 401
SHIM_DB_PATH=/var/lib/cube-e2b-shim/shim.db
```

### 5.2 建议配置

```ini
# 只监听私网地址，由反向代理或 Tunnel 转发进来
SHIM_LISTEN_HOST=127.0.0.1
# SHIM_LISTEN_PORT=3100

# 加密 secrets 和 webhook 签名密钥的密钥（32 字节，hex 或 base64）。
# 不设置时会自动生成并存进数据库；单独设置可以把密钥和数据库分开保管。
SHIM_ENCRYPTION_KEY=<随机值>

# 账号级访问令牌（Bearer）：GET /teams 和 API key 管理接口需要
SHIM_ACCESS_TOKENS=<随机值>

# 管理员令牌：/admin/*、/nodes 等管理员接口需要
SHIM_ADMIN_TOKEN=<随机值>
```

### 5.3 按需配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SHIM_TEAM_NAME` / `SHIM_TEAM_ID` | `default` / 自动生成 | 本部署对应的唯一团队 |
| `SHIM_PUBLIC_API_URL` | 从请求头推导 | 模板文件上传链接使用的对外地址。代理没有传递正确的 `Host` 或 `X-Forwarded-Proto` 时需要设置 |
| `SHIM_BUILD_FILES_DIR` | `<DB 所在目录>/template-files` | 模板构建时 COPY 上传文件的存放位置 |
| `SHIM_TEMPLATE_DISK_SIZE` | `4G` | 从镜像构建 Cube 模板时的可写层大小 |
| `SHIM_EVENT_POLL_SECONDS` | `15` | 轮询 Cube 发现生命周期变化（超时销毁、自动暂停等）的间隔 |
| `SHIM_EVENT_RETENTION_DAYS` | `7` | 事件、webhook 投递记录、团队监控数据的保留天数 |
| `SHIM_VOLUME_HELPER_TEMPLATE` | `base` | 卷文件接口所用辅助沙箱的模板 |
| `CUBE_OPS_URL` / `CUBE_OPS_TOKEN` | 空 | 不配置时，`/nodes` 接口返回 501 |
| `SHIM_CLUSTER_ID` | 固定 UUID | `/nodes` 接口返回的集群 ID |
| `SHIM_STRIP_CUBE_METADATA` | `true` | 从响应中去掉 Cube 内部的 metadata |
| `SHIM_TLS_KEY` / `SHIM_TLS_CERT` | 空 | 由 shim 自己终结 TLS（一般交给前面的代理处理） |

### 5.4 启动

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cube-e2b-shim
sudo systemctl status cube-e2b-shim
sudo journalctl -u cube-e2b-shim -f     # 日志中应出现 "e2b-shim listening"
curl -s http://127.0.0.1:3100/health    # {"status":"ok"}
```

## 6. 对外入口（DNS 与反向代理）

把 `api`、`sandbox`、`*` 三条记录全部指向 shim，并**原样保留 `Host` 头**。代理必须支持 WebSocket 和长连接（envd 的命令流是长时间的流式响应）。

### 6.1 Cloudflare Tunnel

详见 [cloudflared-deployment.md](../contrib/cloudflared-deployment.md)。ingress 配置示例：

```yaml
ingress:
  - hostname: api.example.com
    service: http://127.0.0.1:3100
  - hostname: sandbox.example.com
    service: http://127.0.0.1:3100
  - hostname: "*.example.com"
    service: http://127.0.0.1:3100
  - service: http_status:404
```

### 6.2 Nginx（自有通配证书）

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.com sandbox.example.com *.example.com;
    ssl_certificate     /etc/ssl/example.com/fullchain.pem;   # 需覆盖 *.example.com
    ssl_certificate_key /etc/ssl/example.com/privkey.pem;

    client_max_body_size 0;          # 模板 COPY 和卷文件上传可能很大
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 3600s;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

`$connection_upgrade` 需要在 `http {}` 块里用 `map $http_upgrade $connection_upgrade { default upgrade; '' close; }` 定义。

## 7. 准备 Cube 模板

### 7.1 基础模板（别名 `base`）

以下场景都依赖一个别名为 `base` 的 Cube 模板：
- E2B SDK 的 `Template().fromTemplate("base")`；
- Mastra 在未指定模板时构建默认模板；
- 卷文件接口的辅助沙箱。

建议用 Ubuntu 镜像，至少包含 `bash`、`sudo`、GNU `findutils`、`tar`、`coreutils`，以及一个普通用户 `user`。例如：

```dockerfile
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash sudo findutils tar coreutils ca-certificates curl \
    && useradd --create-home --shell /bin/bash user \
    && usermod -aG sudo user \
    && echo 'user ALL=(ALL:ALL) NOPASSWD: ALL' > /etc/sudoers.d/user \
    && rm -rf /var/lib/apt/lists/*
```

把镜像推送到 Cube 能拉取的镜像仓库，然后通过 CubeAPI 建模板并设置别名：

```sh
# 从镜像创建模板（cpu 单位是毫核，memory 单位是 MiB）
curl -s -X POST "$CUBE_API_URL/templates" \
  -H "X-API-Key: $CUBE_API_KEY" -H "Content-Type: application/json" \
  -d '{"image":"registry.example.com/e2b-base:latest","writableLayerSize":"10G","cpu":2000,"memory":2048}'
# 记下返回的 templateID（tpl-...），轮询直到 status 为 READY
curl -s -H "X-API-Key: $CUBE_API_KEY" "$CUBE_API_URL/templates/tpl-xxxx"
# 设置别名 base
curl -s -X PUT "$CUBE_API_URL/templates/tpl-xxxx/alias" \
  -H "X-API-Key: $CUBE_API_KEY" -H "Content-Type: application/json" -d '{"alias":"base"}'
```

### 7.2 业务模板

有两种方式：

- **直接用 Cube 模板**：按 7.1 的方法建好，在 SDK 或 Mastra 里传模板 ID 或别名。这种方式最快，不需要构建。
- **用 E2B 的 `Template.build()`**：shim 会在 Cube 上执行构建步骤，最后打成快照模板。构建沙箱需要能访问外网时（比如 `apt install`），要确保 `base` 模板的网络允许出站。

## 8. 验证

### 8.1 快速检查

```sh
curl -s https://api.example.com/health
curl -s -H "X-API-Key: <SHIM_API_KEYS 中的一个>" https://api.example.com/v2/sandboxes
```

### 8.2 冒烟测试（建沙箱后自动删除）

```sh
cd /opt/cube-e2b-shim
E2B_API_URL=https://api.example.com \
E2B_API_KEY=<shim API key> \
E2B_TEMPLATE_ID=<一个 READY 的 Cube 模板 ID> \
E2B_EXPECTED_DOMAIN=example.com \
node dist/smoke.js
```

生产主机上执行过 `npm prune --omit=dev`，TypeScript 已被移除，所以这里直接运行编译好的 `dist/smoke.js`，不要用 `npm run test:e2e`（它会先重新构建）。

### 8.3 完整端到端测试（官方 E2B SDK + Mastra）

可以在任意一台能访问公网域名的机器上执行：

```sh
cd e2e/mastra
npm install
E2B_API_KEY=<shim API key> \
E2B_DOMAIN=example.com \
E2E_TEMPLATE=<Cube 模板 ID 或别名> \
E2E_BUILD_BASE=base \
npm run e2e          # 暂时跳过模板构建测试可加 E2E_SKIP_BUILD=1
```

结尾输出 `ALL CHECKS PASSED` 即为通过。首次在真实 Cube 上部署时，请**重点确认**以下几点，它们在开发环境中只做过模拟验证：

1. `Template.build` 和 fork 依赖 Cube 能对运行中的沙箱打内存快照，并且恢复后 envd 内存里的 token 和默认设置仍然保留。
2. 卷文件接口要求一个卷在被其他沙箱使用时还能再被辅助沙箱挂载。可以用 SDK 的 `Volume.create()` 配合 `writeFile`、`readFile` 验证。
3. 配置了 CubeOps 的话，检查 `GET /nodes`（需要带 `X-Admin-Token`）返回的节点数据是否正确。
4. 用到 webhook 的话，注册一个测试地址，校验 `e2b-signature` 签名和请求体格式。

## 9. 接入 Mastra / E2B SDK

客户端只需要两个环境变量：

```sh
export E2B_API_KEY=<shim API key>
export E2B_DOMAIN=example.com        # SDK 会自动推导出 https://api.example.com 等地址
```

Mastra 示例：

```ts
import { E2BSandbox } from "@mastra/e2b";

const sandbox = new E2BSandbox({
  template: "my-cube-template",   // 推荐：直接用现成的 Cube 模板 ID 或别名
  timeout: 300_000,
});
```

不传 `template` 时，Mastra 会从 `base` 构建默认模板，这一步需要构建沙箱能访问外网（`apt`、nodejs.org）。

## 10. 运维

**备份**
- 定期备份 `/var/lib/cube-e2b-shim/shim.db`，包括 `-wal` 和 `-shm` 文件；最好停服务后备份，或用 `sqlite3 .backup`。
- 库里保存着：envd token、构建记录与标签、secrets（加密）、webhook、托管 API key 的哈希。
- 没有设置 `SHIM_ENCRYPTION_KEY` 时，加密密钥也在库里，要按敏感数据对待这个库。

**升级**：`git pull && npm ci && npm run build && npm prune --omit=dev && sudo systemctl restart cube-e2b-shim`。数据库结构会在启动时自动迁移。重启时正在进行的模板构建会被标记为失败，需要重新触发。

**轮换密钥**
- 修改 `SHIM_API_KEYS`、`SHIM_ACCESS_TOKENS`、`SHIM_ADMIN_TOKEN` 后重启服务即可。
- 通过 `/api-keys` 创建的 key 保存在库里，用接口删除。
- `SHIM_ENCRYPTION_KEY` 一旦设置**不要更换**，否则已加密的 secrets 和 webhook 签名密钥都无法解密。

**日志**：`journalctl -u cube-e2b-shim`。

## 11. 常见问题

| 现象 | 原因与处理 |
|---|---|
| 服务起不来，提示 `SHIM_DB_PATH is required` | 必须配置持久化的数据库路径 |
| 访问 envd 返回 401 | 数据库丢失或被重置（token 找不到），或者沙箱不是通过 shim 创建的。确认 `SHIM_DB_PATH` 在持久盘上 |
| 创建沙箱返回 409 "already secured with a token this service did not issue" | 用了一个不是经 shim 打的快照来建沙箱，里面的 envd 已持有其他 token |
| 创建沙箱返回 502 "environment initialization failed" | shim 访问不到 cube-proxy。检查 `CUBE_PROXY_URL`（必须 http）和 `CUBE_DOMAIN` |
| `Template.build` 报 `Template not found: base` | 没有别名为 `base` 的 Cube 模板（见 7.1） |
| 模板构建卡在上传文件或上传失败 | 代理限制了请求体大小，或 `SHIM_PUBLIC_API_URL` 不对 |
| 签名下载链接打不开 | 缺少 `*.<域名>` 的通配解析或证书 |
| `/nodes` 返回 501 | 没有配置 `CUBE_OPS_URL` |
| `/clusters/*/rigs` 返回 501 | 符合预期：Cube 没有云伸缩组，E2B 规范本身允许返回 501 |
| 超时销毁、自动暂停等事件有延迟 | 这类事件靠轮询 Cube 发现，延迟最多 `SHIM_EVENT_POLL_SECONDS` 秒 |
