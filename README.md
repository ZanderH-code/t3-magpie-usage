# t3-magpie-usage

[English](#english) | [中文](#中文)

---

## English

A read-only Node.js 20+ adapter that bridges local Magpie subscription quotas into T3 Code's CLIProxy (`cliproxy`) usage-limit interface.

It exposes a minimal local HTTP server (default `127.0.0.1:38765`) implementing T3 Code's CLIProxy management endpoints (`/v0/management/auth-files` and `/v0/management/api-call`) backed by Magpie's read-only quota endpoints (`/v1/magpie/accounts` and `/v1/magpie/quotas`).

### Requirements

- **OS / Init:** Linux with a running `systemd` user session (`systemctl --user` and `XDG_RUNTIME_DIR` available)
- **Runtime & Tools:** Node.js 20+, Python 3, `curl`
- **Magpie:** Running locally and reachable at `MAGPIE_URL` (default `http://127.0.0.1:3425`)
- **T3 Code:** Started at least once so the settings file exists at `T3_SETTINGS` (default `~/.t3/userdata/settings.json`)

> **Platform note:** `install.sh` and `uninstall.sh` are designed for Linux with a `systemd` user session. Other operating systems are not supported by the installer scripts.

### Supported Providers & Limitations

- **Supported providers:** Only **Claude** and **Codex** accounts (where `on !== false`) are exposed, mapped directly to T3 Code's native `claude` and `codex` provider drivers.
- **Omitted providers:** Other Magpie providers — such as **Copilot**, **Mistral**, **OpenCode Go**, and **Zed** — are intentionally omitted.
- **Why other providers are omitted:** Current T3 Code usage-source integration groups accounts strictly under its built-in provider drivers. Earlier attempts to map unsupported providers under the Antigravity driver resulted in a broken and cluttered UI.
- **No custom Magpie category:** The current T3 Code API does not provide a custom `Magpie` category or custom provider driver. Showing non-native providers in a dedicated Magpie category requires upstream changes in T3 Code itself.
- **Window mapping notes:**
  - Claude exposes the `5 hour` (`five_hour`) and `7 day` (`seven_day`) utilization windows.
  - Codex filters out unlimited windows and image-generation windows, mapping the remaining primary and secondary windows.

### Installation

Run the installer from the repository root:

```bash
./install.sh
```

With optional environment overrides:

```bash
MAGPIE_URL=http://127.0.0.1:3425 \
T3_SETTINGS=~/.t3/userdata/settings.json \
PORT=38765 \
./install.sh
```

#### Environment Overrides

| Variable | Default | Description |
| --- | --- | --- |
| `MAGPIE_URL` | `http://127.0.0.1:3425` | Base URL of the local Magpie API |
| `T3_SETTINGS` | `~/.t3/userdata/settings.json` | Path to T3 Code's `settings.json` |
| `PORT` | `38765` | Local TCP port (`1024`–`65535`) on `127.0.0.1` |

#### What `install.sh` Does

1. Checks for Node.js 20+, Python 3, `curl`, `systemctl`, `XDG_RUNTIME_DIR`, `T3_SETTINGS`, and reachable Magpie `/v1/magpie/accounts` and `/v1/magpie/quotas` endpoints.
2. Copies `server.mjs` to `~/.local/share/t3-magpie-usage/server.mjs` (respecting `XDG_DATA_HOME`).
3. Generates a random 256-bit hex bearer key (or reuses the existing key on reinstall) and writes `~/.config/t3-magpie-usage/config.env` with mode `0600` inside a `0700` directory (respecting `XDG_CONFIG_HOME`).
4. Backs up `T3_SETTINGS` to `settings.json.before-magpie-install-<UTC-timestamp>`, then registers a single `usageLimitSources` entry with ID `magpieRelay` and label `Magpie` pointing to `http://127.0.0.1:<PORT>`. If a `magpieRelay` entry already exists with a different URL, the installer refuses to overwrite it.
5. Installs `~/.config/systemd/user/t3-magpie-usage.service` (mode `0600`), reloads the user `systemd` daemon, enables and restarts the service, then waits for `/health` to pass.

After installation, refresh usage limits in T3 Code to load your Magpie Claude and Codex accounts.

### Verification

Check the local adapter health endpoint (returns counts only, no credentials):

```bash
curl -fsS http://127.0.0.1:38765/health
```

Check the `systemd` user service status and logs:

```bash
systemctl --user status t3-magpie-usage.service
journalctl --user -u t3-magpie-usage.service -n 50 --no-pager
```

Run repository syntax checks and unit tests:

```bash
npm run check
npm test
```

### Uninstall

Run the uninstaller from the same Linux user session:

```bash
./uninstall.sh
```

If you installed with custom `T3_SETTINGS` or `PORT`, pass them as environment overrides (`PORT` is automatically read from `config.env` if still present):

```bash
T3_SETTINGS=~/.t3/userdata/settings.json PORT=38765 ./uninstall.sh
```

What `uninstall.sh` does:

1. Disables and stops `t3-magpie-usage.service`, removes `~/.config/systemd/user/t3-magpie-usage.service`, and reloads the user `systemd` daemon.
2. Removes **only** the `usageLimitSources.magpieRelay` entry whose `url` matches `http://127.0.0.1:<PORT>`, leaving all other T3 sources untouched.
3. Creates a backup (`settings.json.before-magpie-uninstall-<UTC-timestamp>`) before writing changes to `T3_SETTINGS`.
4. Removes its installed `server.mjs` and `config.env` files. It removes their directories only when they are empty; other files in those directories are left untouched. Magpie's own data is never modified.

### Security

- **Read-only:** Only sends `GET` requests to Magpie (`/v1/magpie/accounts`, `/v1/magpie/quotas`). Never writes to or mutates Magpie state.
- **Loopback-only binding:** Binds to `127.0.0.1` by default (port `38765`), not exposed on external network interfaces.
- **Bearer authentication:** `/v0/management/*` requires `Authorization: Bearer <MANAGEMENT_KEY>` verified with constant-time comparison (`crypto.timingSafeEqual`). The key is stored in `~/.config/t3-magpie-usage/config.env` (`0600`) inside a `0700` directory.
- **No secret leakage in `/health`:** `/health` reports only `ok`, `magpie`, and account/quota counts.
- **Service hardening:** The `systemd` unit runs with `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=read-only`, and `ReadOnlyPaths` on the install directory.
- **Safe settings updates:** Both `install.sh` and `uninstall.sh` back up `settings.json`, write via a temporary file, preserve original file permissions, and replace atomically.

### Troubleshooting

- **`T3 settings not found`:** Start T3 Code once to initialize `~/.t3/userdata/settings.json`, or pass `T3_SETTINGS=/path/to/settings.json`.
- **`Cannot reach Magpie ... API`:** Verify Magpie is running and accessible at `MAGPIE_URL` (default `http://127.0.0.1:3425`).
- **`Refusing to replace existing T3 source 'magpieRelay'`:** A `magpieRelay` entry with a different URL already exists in `settings.json`. Rename or remove it first, or run `./install.sh` with the matching `PORT`.
- **`Service did not become healthy`:** Inspect logs with `journalctl --user -u t3-magpie-usage.service --no-pager` and confirm `PORT` is not already in use (`ss -tlnp | grep 38765`).
- **Missing providers in T3 Code:** Only enabled Claude and Codex accounts are exposed by design. Other providers (Copilot, Mistral, OpenCode Go, Zed, etc.) are intentionally excluded; see [Supported Providers & Limitations](#supported-providers--limitations).
- **Accounts not updating immediately:** The adapter caches Magpie responses in memory for 10 seconds (`CACHE_MS=10000` by default). Wait a few seconds and refresh in T3 Code.

---

## 中文

一个只读的 Node.js 20+ 适配器，用于将本地 Magpie 的订阅配额桥接到 T3 Code 的 CLIProxy（`cliproxy`）用量限额界面。

它在本地启动一个轻量 HTTP 服务（默认监听 `127.0.0.1:38765`），实现 T3 Code 的 CLIProxy 管理协议端点（`/v0/management/auth-files` 与 `/v0/management/api-call`），并只读拉取 Magpie 的配额接口（`/v1/magpie/accounts` 与 `/v1/magpie/quotas`）。

### 运行要求

- **系统与服务管理：** 具备运行中的 `systemd` 用户会话的 Linux（需可用 `systemctl --user` 且已设置 `XDG_RUNTIME_DIR`）
- **运行时与工具：** Node.js 20+、Python 3、`curl`
- **Magpie：** 已在本地运行，且可通过 `MAGPIE_URL`（默认 `http://127.0.0.1:3425`）访问
- **T3 Code：** 至少启动过一次，使配置文件存在于 `T3_SETTINGS`（默认 `~/.t3/userdata/settings.json`）

> **平台说明：** `install.sh` 和 `uninstall.sh` 仅支持带有 `systemd` 用户会话的 Linux，不支持其他操作系统。

### 支持的提供商与限制

- **支持的提供商：** 仅集成 **Claude** 与 **Codex** 账号（且 `on !== false`），直接使用 T3 Code 原生的 `claude` 与 `codex` 驱动展示。
- **未包含的提供商：** 其他 Magpie 提供商——例如 **Copilot**、**Mistral**、**OpenCode Go**、**Zed** 等——被有意省略。
- **为何省略其他提供商：** 当前 T3 Code 的用量来源集成按其内置提供商驱动进行分组。此前将不支持的提供商映射到 Antigravity 驱动会导致界面错乱、拥挤。
- **无独立 Magpie 分类：** 当前 T3 Code API 不提供自定义的 `Magpie` 分类或自定义提供商驱动。若需为非原生提供商提供独立的 Magpie 分类，需要 T3 Code 上游或 T3 本身进行改动。
- **窗口映射说明：**
  - Claude 暴露 `5 hour`（`five_hour`）与 `7 day`（`seven_day`）使用率窗口。
  - Codex 会过滤掉无限配额窗口和图像生成窗口，并将剩余的主/次窗口映射给 T3 Code。

### 安装

在仓库根目录执行：

```bash
./install.sh
```

可通过环境变量覆盖默认配置：

```bash
MAGPIE_URL=http://127.0.0.1:3425 \
T3_SETTINGS=~/.t3/userdata/settings.json \
PORT=38765 \
./install.sh
```

#### 环境变量覆盖项

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `MAGPIE_URL` | `http://127.0.0.1:3425` | 本地 Magpie API 的基础 URL |
| `T3_SETTINGS` | `~/.t3/userdata/settings.json` | T3 Code 的 `settings.json` 路径 |
| `PORT` | `38765` | 绑定在 `127.0.0.1` 上的本地 TCP 端口（`1024`–`65535`） |

#### `install.sh` 执行的操作

1. 检查 Node.js 20+、Python 3、`curl`、`systemctl`、`XDG_RUNTIME_DIR`、`T3_SETTINGS` 是否存在，并验证 Magpie 的 `/v1/magpie/accounts` 与 `/v1/magpie/quotas` 可访问。
2. 将 `server.mjs` 复制到 `~/.local/share/t3-magpie-usage/server.mjs`（遵循 `XDG_DATA_HOME`）。
3. 生成 256 位随机十六进制 Bearer 密钥（重装时复用已有密钥），并写入 `~/.config/t3-magpie-usage/config.env`（文件权限 `0600`，所在目录权限 `0700`，遵循 `XDG_CONFIG_HOME`）。
4. 在修改前将 `T3_SETTINGS` 备份为 `settings.json.before-magpie-install-<UTC时间戳>`，然后写入一个 `usageLimitSources` 条目：ID 为 `magpieRelay`，标签为 `Magpie`，指向 `http://127.0.0.1:<PORT>`。若已存在指向其他 URL 的 `magpieRelay` 条目，安装脚本会拒绝覆盖。
5. 写入 `~/.config/systemd/user/t3-magpie-usage.service`（权限 `0600`），重载用户 `systemd` 配置，启用并重启服务，然后等待 `/health` 健康检查通过。

安装完成后，在 T3 Code 中刷新用量限额即可加载 Magpie 的 Claude 与 Codex 账号。

### 验证与检查

检查适配器健康状态（仅返回统计数量，不包含凭据）：

```bash
curl -fsS http://127.0.0.1:38765/health
```

查看 `systemd` 用户服务状态与日志：

```bash
systemctl --user status t3-magpie-usage.service
journalctl --user -u t3-magpie-usage.service -n 50 --no-pager
```

运行仓库语法检查与单元测试：

```bash
npm run check
npm test
```

### 卸载

在同一 Linux 用户会话中运行：

```bash
./uninstall.sh
```

若安装时自定义了 `T3_SETTINGS` 或 `PORT`，可通过环境变量传入（若 `config.env` 仍存在，`PORT` 会自动从中读取）：

```bash
T3_SETTINGS=~/.t3/userdata/settings.json PORT=38765 ./uninstall.sh
```

`uninstall.sh` 执行的操作：

1. 停用并停止 `t3-magpie-usage.service`，删除 `~/.config/systemd/user/t3-magpie-usage.service`，并重载用户 `systemd` 配置。
2. **仅移除** `usageLimitSources.magpieRelay` 中 `url` 匹配 `http://127.0.0.1:<PORT>` 的条目，保留其他 T3 来源配置不变。
3. 在修改 `T3_SETTINGS` 之前创建备份（`settings.json.before-magpie-uninstall-<UTC时间戳>`）。
4. 移除安装器安装的 `server.mjs` 与 `config.env` 文件。仅当对应目录为空时才删除目录；目录中的其他文件会保留。不会修改任何 Magpie 账号数据。

### 安全性

- **严格只读：** 仅向 Magpie 发送 `GET` 请求（`/v1/magpie/accounts`、`/v1/magpie/quotas`），不会写入或修改 Magpie 状态。
- **仅监听本地回环：** 默认绑定 `127.0.0.1`（端口 `38765`），不对外暴露网络接口。
- **Bearer 认证：** `/v0/management/*` 要求携带 `Authorization: Bearer <MANAGEMENT_KEY>`，服务端使用常量时间比较（`crypto.timingSafeEqual`）校验；密钥保存在 `0600` 权限的 `~/.config/t3-magpie-usage/config.env` 中（目录权限 `0700`）。
- **`/health` 不泄露密钥：** `/health` 仅返回 `ok`、`magpie` 及账号/配额数量。
- **服务沙箱加固：** `systemd` 单元启用了 `NoNewPrivileges=true`、`PrivateTmp=true`、`ProtectSystem=strict`、`ProtectHome=read-only` 以及安装目录的 `ReadOnlyPaths`。
- **安全的配置更新：** `install.sh` 与 `uninstall.sh` 均先备份 `settings.json`，再通过临时文件保持原权限并原子替换。

### 故障排查

- **`T3 settings not found`：** 请先启动一次 T3 Code 以生成 `~/.t3/userdata/settings.json`，或通过 `T3_SETTINGS=/path/to/settings.json` 指定路径。
- **`Cannot reach Magpie ... API`：** 确认 Magpie 正在运行且 `MAGPIE_URL`（默认 `http://127.0.0.1:3425`）可访问。
- **`Refusing to replace existing T3 source 'magpieRelay'`：** `settings.json` 中已存在指向不同 URL 的 `magpieRelay` 条目。请先重命名或移除该条目，或使用匹配的 `PORT` 重新运行 `./install.sh`。
- **`Service did not become healthy`：** 使用 `journalctl --user -u t3-magpie-usage.service --no-pager` 查看日志，并检查 `PORT` 是否被占用（`ss -tlnp | grep 38765`）。
- **T3 Code 中未显示某些提供商：** 本适配器按设计仅暴露已启用的 Claude 与 Codex 账号；Copilot、Mistral、OpenCode Go、Zed 等其他提供商被有意排除，详见[支持的提供商与限制](#支持的提供商与限制)。
- **配额未立即刷新：** 适配器默认在内存中缓存 Magpie 响应 10 秒（`CACHE_MS=10000`），请稍候几秒后在 T3 Code 中重新刷新。
