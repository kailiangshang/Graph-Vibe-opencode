# Graph Vibe 安装与生命周期

Graph Vibe 使用独立于 OpenCode 的包名、运行入口、网络身份和存储空间。发布后通过 npm 安装：

```bash
npm install -g graph-vibe
```

顶层 `graph-vibe` 包只依赖独立平台包：`graph-vibe-linux-arm64`、`graph-vibe-linux-arm64-musl`、`graph-vibe-linux-x64`、`graph-vibe-linux-x64-baseline`、`graph-vibe-linux-x64-musl`、`graph-vibe-linux-x64-baseline-musl`、`graph-vibe-darwin-arm64`、`graph-vibe-darwin-x64`、`graph-vibe-darwin-x64-baseline`、`graph-vibe-windows-arm64`、`graph-vibe-windows-x64` 和 `graph-vibe-windows-x64-baseline`。安装脚本不会解析或回退到 `opencode-*` 平台包。Graph Vibe 的独立升级发布通道尚未配置，因此 `graph-vibe upgrade` 会明确报错并返回非零状态，不会访问 OpenCode 的安装或发布端点。

## 本地身份

| 资源         | Graph Vibe                  | OpenCode                  |
| ------------ | --------------------------- | ------------------------- |
| 默认后端端口 | `4097`                      | `4096`                    |
| mDNS 域名    | `graph-vibe.local`          | `opencode.local`          |
| 数据         | `~/.local/share/graph-vibe` | `~/.local/share/opencode` |
| 配置         | `~/.config/graph-vibe`      | `~/.config/opencode`      |
| 状态         | `~/.local/state/graph-vibe` | `~/.local/state/opencode` |
| 缓存         | `~/.cache/graph-vibe`       | `~/.cache/opencode`       |
| 数据库       | `graph-vibe.db`             | `opencode.db`             |

## 启动 Graph 工作流

启动 Web 界面并完成首次启动后，在 Home 选择项目，然后点击 `Start Graph Workflow`。Graph Vibe 会创建该项目的 session 并打开空 Graph；点击 `Describe a goal` 返回同一 session 的 composer，再输入目标即可开始规划。

优先保留默认 loopback 绑定，并使用 WSL localhost forwarding。`--hostname 0.0.0.0` 会向可访问主机网络的设备开放包含文件、session 和执行能力的 API。

只有在 localhost forwarding 无法使用、WSL 网络受信且仅主机可达，并已通过防火墙将访问限制到所需客户端时，才可生成仅用于本次运行的强密码并显式绑定所有接口：

```bash
export OPENCODE_SERVER_PASSWORD="$(openssl rand -base64 48)"
graph-vibe web --hostname 0.0.0.0
```

打开命令输出的 Network URL。在 Graph Vibe 的 server connection 设置中使用用户名 `opencode` 和当前 `OPENCODE_SERVER_PASSWORD` 完成认证。Basic auth 只提供访问控制，不会加密 HTTP 凭据或流量；绝不能在不受信任的 LAN 上使用此方式。远程或非私有网络访问必须通过终止 TLS 且要求认证的反向代理，或 SSH/VPN 等安全隧道，并让 Graph Vibe 在其后保持 loopback 绑定。停止 Graph Vibe 后运行 `unset OPENCODE_SERVER_PASSWORD`；不要复用、记录或分享这个临时密码。

首次启动时，Graph Vibe 在自身命名空间中运行，并在迁移完成或选择 fresh start 前阻止 session、Graph、permission 和 PTY 写入。迁移器通过只读 SQLite online snapshot 发现 OpenCode 数据；配置和凭据默认选择。

Session 迁移在首次启动向导中默认关闭。需要迁移历史时，在 Sessions 步骤打开 session migration，先按项目全选、全不选或逐项选择，再按标题、更新时间、archive 状态和估算大小选择 session。向导会突出当前项目最近的 session，但只有打开 session migration 后选择才会生效。执行前仍可返回 draft 修改选择。

迁移完成后，正常运行时不再组合全局 OpenCode source roots，也不提供后续全局导入或同步命令。项目内 `.opencode` 仅作为只读兼容输入保留。选择 fresh start 会在尚未复制任何项目时完成一个空迁移；已有已提交迁移项时不能用 fresh start 擦除部分结果。中断和失败保留 journal，可在 source fingerprint 未变化时重试或继续。

`source fingerprint` 是一个版本化 SHA-256，输入包括 canonical source database path、online snapshot 的大小和 SHA-256、session 数量，以及 accepted config/auth/MCP/dependency manifest 和 referenced-file identity estimates。它不同于 release report 中仅用于证明 live check 前后相等的 content/identity manifest digests。

单次 SQLite snapshot 上限为 16 GiB。超过上限、source 在计划后发生相关内容变化、空间不足或 source schema 不受支持时，向导会 fail closed，不会开始目标写入。

## 卸载检查

先查看将要删除的 Graph Vibe 资源：

```bash
graph-vibe uninstall --dry-run --force
```

确认后执行卸载：

```bash
graph-vibe uninstall --force
```

Graph Vibe 卸载仅操作 Graph Vibe roots 和 `graph-vibe` 包。任何目录、shell 配置或包管理器操作失败都会返回非零状态。

省略 `--force` 时，非 dry-run 卸载会要求交互确认。`--dry-run` 永远不删除目录或包，但检查目标时发生的权限或 I/O 错误仍会报告并返回非零状态。
