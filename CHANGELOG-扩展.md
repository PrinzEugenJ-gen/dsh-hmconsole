# CHANGELOG · dsh-hmconsole 扩展（0.5.97 → 0.6.0）

> 变更范围：只在 `plugin/dsh-hmconsole/`（工作副本）。`base document/dsh-hmconsole-main/` 原件**未改动**，作为只读参考与回溯基线。
> 决策依据：`docs/MP-CONTRACT.md`（契约）、`docs/假设清单.md`（事实）、D2 = 「把旧面能力搬进 `/mp`」。

---

## 1. 新增 RPC（13 个，全部进白名单）

| 方法 | 作用 | 实现方式 |
|---|---|---|
| `mp.hello` | 能力协商：协议号、`methods[]`、`features`、`limits` | `methods` 由 handler 表 `Object.keys(handlers)` 生成，**不手写清单** |
| `host.drives` | 盘符列表 | 复用 `runCommand('fsDrives')`，映射成 `{name,path}` |
| `host.mkdir` | 新建文件夹 | 复用 `runCommand('fsMkdir')`，先做绝对路径 + `..` 校验 |
| `host.stat` | 文件/目录元信息 | 复用新增的 `runCommand('fsStat')` |
| `host.readFile` | 小文件 base64 读取 | 复用 `runCommand('readFile')`；**公网夹到 3MB**，客户端不能靠 `maxBytes` 绕过 |
| `workspace.remove` | 解绑工作区（不删磁盘目录） | 复用 `runCommand('wsDelete')` |
| `binding.list` | 已配对设备清单（脱敏） | 新增 `store.publicRecords()`，**永不返回 secret** |
| `gateway.status` | 局域网/隧道/异地配对状态 | 新增 `gatewayStatusNow()`，给 App 诊断页 |
| `permission.catalog` | 权限预置目录 | 委托 `runCommand('permissionCatalog')`（B5） |
| `permission.set` | 切换权限预置 | 委托 `runCommand('permissionSet')`；缺参 `bad-request`（B5） |
| `webImport.probe` | 识别分享链接 | 只认 `deepseek.com` 域名（`web-import.mjs`） |
| `webImport.pull` | 抓取并解析分享会话 | `GET /api/v0/share/content?share_id=`，**公开无鉴权** |
| `webImport.commit` | 落盘 + 建会话 + 去重 | `imports/<id>.md`，索引在 `~/.dsh/dsh-hmconsole-imports.json` |

**D1**：公网单文件上限统一 **32MB**（`/cmd` 请求体从 `36e6` 改为 `FILE_WAN_MAX_BYTES`；`mp.hello.limits` 上传/下载同值）。

**D3**：`session.prompt` 支持 `busyMode:'steer'`，**默认仍是 `queue`**，非法值一律按 queue。

**P3 发现加固**：新增 `lib/discovery.mjs`（v1 兼容 / v2 nonce 回显 / 私网限定 / 单 IP 5 次每秒限流 / `discovery:'off'` 开关），socket 生命周期仍在 `lan-server.mjs`。

## 2. 行为变更（唯一的破坏性变更）

| 方法 | 之前 | 之后 |
|---|---|---|
| `workspace.create` | 恒返回 `unavailable`（桩） | 委托 `runCommand('wsCreate')`，返回 `{workspaceId,id,path,title,created}`；路径不存在/相对路径/含 `..` → `bad-request` |

> 这是 D2 的核心目的，属于**有意**变更。旧 App 若依赖 `unavailable` 做降级，会走成功分支；但旧 App（0.5.x 时代的配套 App）本来就没实现建工作区，实际无影响。

## 3. 基础设施改动

- `mp-contract.mjs`：`ALLOW` 24 → **37**；新增 `APP_PROTOCOL=2`、`WAN_FILE_READ_MAX`、`WAN_FILE_DOWNLOAD_MAX`（限额不再散落魔数）。
- `mp-routes.mjs`：新增 `forwardedWan(req)`（转发头判定公网），RPC 调用带上 `{wan}` 环境；支持 `deps.isWan` 覆盖。
- `mp-dispatch.mjs`：`dispatch(method,payload,rpcId,env)`；新增 `runHost(op,payload,wan)` 桥，**复用宿主 runCommand，不复制 fs/工作区逻辑**；`absPathOrThrow()` 统一路径校验。
- `mp-support.mjs`：`store.publicRecords()`；`attachMp` 透传 `runCommand / gatewayStatus / hostVersion / isWan / webFetch / importsPath`；启动日志 RPC 计数改为按 `ALLOW.length` 动态输出。
- `index.js`：新增 `fsStat` op、`gatewayStatusNow()`、`discovery`/`shortId` 注入。
- **新增 `lib/discovery.mjs`**：发现协议的纯逻辑（解析/回包/私网判定/限流）。
- **新增 `lib/web-import.mjs`**：分享链接解析、响应解析、Markdown 渲染、剪贴板解析、去重索引。

## 4. 测试

| 套件 | 结果 |
|---|---|
| `test/mp-contract.spec.mjs` | ✅ 51 |
| `test/mp-dispatch.spec.mjs` | ✅ 32 |
| `test/mp-routes.spec.mjs` | ✅ 14 |
| `test/mp-e2e.spec.mjs` | ✅ 16 |
| `test/mp-v2.spec.mjs`（新增，分发器级） | ✅ 17 |
| `test/mp-v3.spec.mjs`（新增，D1/D3/B5/导入） | ✅ 16 |
| `test/mp-v2-e2e.spec.mjs`（新增，真 HTTP 服务 + 真 attachMp） | ✅ 18 |
| `test/discovery.spec.mjs`（新增，纯逻辑） | ✅ 8 |
| `test/web-import.spec.mjs`（新增，真实响应结构） | ✅ 13 |
| **合计** | **✅ 185 条断言 / 9 套件全绿** |
| `test/selftest.mjs` | ⚠️ 4 项失败，**与基线完全一致**（缺 `qrcode` 依赖，原件同样失败，与本轮无关） |

**真实网络自检**（不是 fixture）：`fetchShare('engtbxuvz0v6g8mldl')` 实测 **393ms**，标题自动从 `Shared Conversation` 纠正为「幺正变换」，2 条消息、role 正确、THINK 进 `reasoning`、`createdAt=1795144996182`。

**改了三处既有断言，必须说明理由**（不是放宽，是跟随契约变更）：

1. `mp-contract.spec.mjs`：`assert.equal(ALLOW.length, 24)` → 「≥24 且无重复且旧 24 个一个不少」。硬编码长度会阻止任何合法扩容；新写法**更强**（删任何一个旧方法都会红）。
2. `mp-dispatch.spec.mjs`：`workspace.create` 的用例从「相对路径 → unavailable」改成「绝对路径 + 宿主无 runCommand → unavailable」，并新增「相对路径/`..` → bad-request」到 `mp-v2.spec.mjs`。原用例的意图（"宿主缺能力时不崩"）保留。
3. `mp-v2.spec.mjs`：`features.webImport` 由 `[]` 改为 `['share','clipboard']`——功能真做出来了，「如实报空」的断言自然要跟着变；`account` 通道仍未实现，所以不报它。

## 5. 本次没做（仍在 S1 后续）

| 项 | 状态 | 说明 |
|---|---|---|
| UDP 发现加固 | ✅ 已完成 | v1 兼容 + v2 nonce + 私网限定 + 限流 + 开关 |
| `windows-keeper`（防睡眠/自启/守护） | 未做 | 单独模块，需真机验证 `powercfg` 行为 |
| `webImport.*` | ✅ 已完成（share + clipboard） | `account` 通道**不做了**：分享接口本身公开无鉴权，没必要碰账号凭据 |
| `push.register` 的 `/mp` 版本 | 未做 | App 暂用 B 面 `/cmd {op:'pushRegister'}` |
| `session.prompt` 的 `busyMode:'steer'` | ✅ 已完成 | D3：默认 queue |
| `gateway.set`（开关隧道/异地配对） | 未做 | B6 的写操作，仍走 `/cmd` |
| `pair/rotate`（secret 轮换） | 未做 | 目前仍是 1 年 cookie |

## 6. 回滚

```bash
# 直接丢弃工作副本即可；原件始终是基线
rm -rf plugin/dsh-hmconsole
```
