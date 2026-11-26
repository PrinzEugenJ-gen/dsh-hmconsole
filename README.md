# DSH·HM 控制台（dsh-hmconsole · 自由版）

在 DSH 设置里放一块配对面板：**手机扫二维码或输 6 位码，就连上这台电脑的 DSH**，
之后在手机 App 里收发会话、看历史、传文件、看电脑画面。

这个版本是 [dsh-console-hm](https://github.com/ChenJun25/dsh-console-hm) 的**自由版分支**：

- **没有会员、没有充值、没有兑换码**，公网 / 看电脑 / 控制电脑一律不设权益门槛；
- **不连接作者云**（原版的短 ID、云隧道、云端推送、异地配对码全部移除），插件不会向任何第三方服务器注册；
- **公网访问两条路，二选一**：
  1. **自建 frps**：你有公网服务器就填地址 + token，插件用内置 frpc 把公网端口转回本机（地址固定）；
  2. **内置免费隧道**：没有服务器也能用，插件用系统自带的 ssh 拉一条免注册反向隧道，拿到一个随机公网 https 地址（地址会变，服务商可能限速）；
- 局域网内**完全不依赖公网**，断网也能用。

---

## 安装

```bash
dsh plugin --profile desktop add dsh-hmconsole
```

`--profile` 写你自己的 profile 名（默认 `web`，桌面端一般是 `desktop`）。
也可以把 `dsh-hmconsole-<版本>.tgz` 从「插件 → 添加插件」装进去。

装好后：**设置 → 导航列表 → DSH·HM 控制台**，侧栏底部也有入口。

> 和原版 `dsh-console-hm` **不能同时装**：两个插件都会占本机端口，二选一。

---

## 端口与接口

- 局域网服务端口默认 **8898**（原版是 8899，留出空间给两边共存排查）；
- UDP 局域网发现：同端口 8898，广播串 `DSH-HMCONSOLE-PROBE`；
- 面板数据路由：`/api/dsh-hmconsole/state`、`/api/dsh-hmconsole/newcode`、`/api/dsh-hmconsole/sessions`、`/api/dsh-hmconsole/cmd`；
- 手机端通道：`/dsh-hmconsole/mp/*`；
- 二维码协议：`dsh-hmconsole://pair?...`。

端口被占用时插件**直接启动失败并打出怎么办的日志**，不会偷偷挪（挪了手机扫不到）。
确实要换端口：在 profile 的 `cordis.patch.yml` 里按 id 定向覆盖：

```yaml
- id: dsh-hmconsole
  config:
    port: 8898
    name: "我的电脑"
```

---

## 公网怎么用

### 路线 A：自建 frps（推荐，地址固定）

面板 →「连接与安全」→ 自建 frps。填你服务器的公网 IP、frps 端口（默认 7000）、token、
要给这台电脑用的公网端口（9000 起）。服务器上只要跑一个朴素的 frps：

```toml
bindPort = 7000
auth.method = "token"
auth.token = "<你自己生成的随机串>"
```

**不要**在前面套 Nginx/Caddy 反代（会加 `X-Forwarded-For`，手机配对会被当成公网来源拒掉），
也不要给这个端口配 HTTPS。面板里点「展开」有一份可以直接丢给 AI 的完整搭建提示词。

### 路线 B：内置免费隧道（不用服务器）

面板 →「连接与安全」→ 免费公网隧道 → 选服务商 → 开启。

- 用系统自带的 `ssh`（Windows 10+ 自带 OpenSSH；Linux/macOS 本来就有）；
- 服务商三选一：`serveo.net`（默认，实测直接可用）/ `pinggy.io` / `localhost.run`；
  `localhost.run` 现在要先有 SSH key 才会给地址，`pinggy` 免登录时不一定回地址，**默认用 serveo**；
- 连上后拿到 `https://xxxx.serveousercontent.com` 这类随机地址，断线自动重连（4 秒起，最长 60 秒一次）；
- ⚠️ serveo 对**浏览器 UA** 会先弹一个「警告页」，点「Continue to Site」才放行；
  手机 App 用普通 HTTP 客户端 UA（如 OkHttp）直接就是 JSON，不会撞到这个页面 —— 实测已验证；
- 免费隧道的地址是随机的、可能限速，长期使用建议走路线 A。

两条路线互斥：开一条会自动关掉另一条。

---

## 安全边界（自己心里有数）

- 二维码里是**一次性票据**（5 分钟、兑换即焚），不是长期访问码；
- 6 位码**一次性**，用掉即作废；公网来源错码有次数限制；
- 访问码每次进程重启会变，存在 `~/.dsh/dsh-hmconsole-token.json`（0600）；
- 公网隧道等于把这台电脑的服务暴露在公网，**别把地址外传**；不用时关掉；
- 「看电脑」/「控制电脑」在自由版里没有 VIP 门槛 —— 谁能连上这台电脑，谁就能用；
  如果不想给人看画面，把「连接与安全」里的公网开关关掉即可。

---

## 配置与状态文件

都在 `~/.dsh/` 下，前缀 `dsh-hmconsole-`：

| 文件 | 作用 |
|---|---|
| `dsh-hmconsole-token.json` | 访问码 |
| `dsh-hmconsole-devices.json` | 已配对设备 |
| `dsh-hmconsole-custom.json` | 自建 frps 配置 |
| `dsh-hmconsole-free-tunnel.json` | 免费隧道开关与服务商 |
| `dsh-hmconsole-tunnel.auto.json` | frpc 实际使用的隧道配置 |
| `dsh-hmconsole.log` | 运行日志 |

---

## 已知限制

- 电脑睡眠时公网一定连不上（网卡与 frpc/ssh 都停了）；
- 免费隧道依赖第三方 SSH 服务，服务商抖动时只能等自动重连；
- 删除的功能：云端短 ID、兑换码续期、作者云隧道、云端推送（HMS 推送）、异地配对码；
  异地连接请用「公网地址 + 二维码」；
- 升级卡已移除（本包不发布到 npm，需要更新就换 tgz 重装）。

---

## 许可

MIT。上游版权归 CJ（[ChenJun25/dsh-console-hm](https://github.com/ChenJun25/dsh-console-hm)）；
本分支去掉了会员体系与作者云依赖，其余功能与上游对齐。
