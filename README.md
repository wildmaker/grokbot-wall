# Grok Bot · 签到欢迎墙

Luma 活动签到后，大屏上的 ASCII Grok Bot 会按姓名欢迎每位来宾。可选：同时给来宾发一封带 Cursor 兑换码的邮件（默认关闭）。

- **欢迎墙**：一个网页，只负责显示，用任何普通浏览器打开即可。
- **服务**（`serve.mjs`）：保存签到名单、分配兑换码、发邮件。
- **轮询脚本**（`luma-checkin-poller.mjs`）：在组织者电脑上打开一个已登录 Luma 的 Chrome，读取签到名单，推给服务。

## 现场速查（先看这里）

### 开门前（至少提前 30 分钟）

```sh
cp .env.example .env     # 只需做一次；填 LUMA_EVENT_URL，建议再填 WALL_TOKEN
npm run checkins:login   # 只需做一次：在弹出的 Chrome 里登录 Luma 组织者账号，登录后关掉
npm start                # 终端 1：启动服务，窗口保持打开
npm run checkins:on      # 终端 2：启动轮询脚本，窗口保持打开
```

1. 大屏浏览器打开 `http://localhost:8787/`（设了 `WALL_TOKEN` 则加 `?key=<token>`），按 `F` 全屏。
2. 右下角点 **设置**（或按 `D`）打开控制台，打开 **轮询** 开关。底栏出现 `LUMA ● LIVE` 才算通。
3. 用测试账号在 Luma 签一次到，确认大屏有欢迎；然后在 设置 里点 **清空分配记录**，再正式开场。

### 签到期间：不要关这些

| 不要关 | 原因 |
| --- | --- |
| 终端 1（服务） | 关了大屏和名单都没了 |
| 终端 2（轮询脚本） | 关了没人去读 Luma，新签到不会上墙 |
| **轮询脚本弹出的那个 Chrome 窗口** | 它就是 Luma 的登录会话，可以最小化，但不能关。大屏不要用它打开 |
| 电脑休眠 / 断网 | 接电源，关闭自动休眠，尽量用有线网 |

### 状态灯（大屏底栏，控制台顶部同步显示）

| 显示 | 含义 | 处理 |
| --- | --- | --- |
| `POLL ○ OFF` / 轮询 ○ 关 | 轮询开关是关的 | 控制台打开 **轮询** |
| `LUMA ● LIVE 2s` | 2 秒前刚成功读过 Luma | 正常 |
| `POLLER ✗ OFFLINE` | 开关已开，但脚本没有心跳 | 终端 2 是否还在？Chrome 窗口是否被关？见下方"故障处理" |
| `POLLER ✗ NOT RUNNING` | 开关已开，但脚本从未启动过 | 运行 `npm run checkins:on` |
| `LUMA ✗ LOGIN` | Luma 登录过期 | 在脚本弹出的 Chrome 里重新登录；不行就 `npm run checkins:login` 后重启脚本 |
| `LUMA ✗ <错误>` | 上一次读取失败（网络、Luma 报错） | 脚本会自动重试；持续不好就看终端 2 的输出 |
| `WALL ✗ RECONNECTING` | 大屏页面连不上服务 | 检查终端 1 |

建议现场安排一个人专门盯这个灯。灯不是 `LIVE` 时，大屏不会报错，只是没人被欢迎。

### 故障处理

- **轮询脚本或 Chrome 被关**：脚本不会自动重开 Chrome。在终端 2 按 `Ctrl+C`，再运行 `npm run checkins:on`。已签到的人不会重复，断线期间新签到的人会补上。
- **服务被重启**：已签到名单保留（存在 `data/state.json`），但 **轮询开关会回到关闭**，要在控制台重新打开。想让它自动恢复，在 `.env` 设 `LUMA_POLL_ON_START=1`。
- **一时恢复不了**：控制台点 **+ 手动签到**（`M`）给到场的人录入，大屏照常欢迎。散场后点 **导出 CSV**（`Shift+E`）。
- **备份**：开场前和中途手动复制 `data/state.json`，防止写入时断电损坏。
- **没配活动就打开轮询**：会被拒绝并提示，在 `.env` 填 `LUMA_EVENT_URL`，或在 设置 里粘贴活动链接。

## 配置：一个仓库，多场活动

场次相关的内容都在 `.env` 和 `data/`。新一场就是换一份配置：

```sh
LUMA_EVENT_URL=https://luma.com/spacexai-zhengzhou1128   # luma.com 链接、slug 或 evt-… id
EVENT_NAME=                                              # 大屏标题；留空则用 Luma 上的活动标题
LUMA_POLL_ON_START=0                                     # 默认 0：每次启动轮询都是关的
```

- 服务启动时通过 Luma 公开接口把链接解析成活动 id 和标题，**不需要登录**。
- 轮询脚本跟随服务当前的活动，两者不会读成不同的活动。设置里粘贴新链接可以切换活动。
- `.env` 优先于 `data/state.json` 里存的旧活动。
- **换场次**：用新的 `.env`，把 `data/state.json` 和 `data/check-in-cache.json` 移走（或留给 `data/archive/`），服务会重新建空名单。脚本缓存绑定活动，换活动后首次启动只建基线，不会补发历史签到，所以 **一定要在开门前启动脚本**。
- 其他环境变量见 `.env.example`；常用的有 `WALL_TOKEN`（访问密钥）、`LUMA_CHECKIN_POLL_MS`（轮询间隔，默认 2000，最小 1000）。

## 发码（默认关闭）

- 控制台顶部有 **发码** 开关，默认关，只对之后签到的人生效。
- 要发码：把兑换码放进 `data/codes.json`（格式见 `data/codes.example.json`：`A`、`B` 两个池，每项 `{code, url}`），并在 `.env` 填 `RESEND_API_KEY` 和 `EMAIL_FROM`（发件域名需在 Resend 验证），再打开开关。
- **不发码也要有 `data/codes.json`**，内容为 `{"A": [], "B": []}`。找不到这个文件时，服务会退回使用示例文件里的假码。
- 彩排用：`EMAIL_DRY_RUN=1` 只写日志不发信；`EMAIL_TEST_TO=你的邮箱` 把所有邮件改发给你。正式开场前清掉。
- 邮件队列每秒发 2 封，失败会自动重试，重启后会重新排队未发的邮件。紧急接口：`GET /email/status`、`POST /email/sweep`、`POST /email/send-now`。

## 轮询脚本说明

- 脚本用 Playwright 控制本机 Chrome（登录保存在 `data/luma-browser-profile/`，已被 Git 忽略），在 Luma 页面内调用组织者后台的签到名单接口，有新签到就 POST 到 `/allocate`。
- 欢迎墙页面不能直接请求 Luma：浏览器跨域会被拦，也带不上你的登录。所以必须由脚本代劳。
- 这是 Luma 未公开的接口，Luma 改版可能失效。也支持官方 `LUMA_API_KEY`（见 `.env.example`），本仓库默认按无 key、靠本机登录会话来用。
- 开关由服务控制：控制台关闭轮询时，脚本不会向 Luma 发请求。
- 常用命令：

```sh
npm run checkins:on       # 常驻运行，等待控制台的轮询开关
npm run checkins:once     # 读一次后退出
npm run checkins:status   # 只看本地缓存，不请求 Luma
npm run checkins:login    # 登录 Luma，保存会话
```

## 控制台

右下角 **设置** 按钮（或按 `D`）：搜索来宾、查看兑换码和二维码、重发邮件、收回兑换码、手动签到（`M`）、导出 CSV（`Shift+E`）、设置（活动链接、发码模式、轮询间隔、清空分配记录）。

## 部署到服务器（可选）

```sh
cp .env.example .env                              # 填好
cp data/codes.example.json data/codes.json        # 不发码则改成 {"A": [], "B": []}
docker compose up -d --build                      # 服务监听 127.0.0.1:8787
```

- 公网域名可用 Cloudflare named tunnel：配置见 `docker-compose.yml` 里的注释，然后 `docker compose --profile tunnel up -d`。`deploy.sh` 封装了这些命令。
- 云端只放得下"服务 + 欢迎墙"：服务是常驻 Node 进程，名单存在本地文件，**不能直接放进 Vercel 或 Cloudflare Workers**。轮询脚本仍在本机，把 `WALL_URL` 指向云端地址即可。
- **同时准备本机和云端两套时**：同一时间只让一个当"主"（轮询脚本的 `WALL_URL` 指向谁，谁就是主）；两边用不同的 `WALL_TOKEN`；备用实例保持轮询关闭；如果发码，把 `codes.json` 拆成两份，避免两边发出同一个码。

`WALL_TOKEN` 保护除 webhook 和 `/assets` 外的所有路由。公开托管的页面不含兑换码。

## 键位与 URL 参数

| 键 | 作用 |
| --- | --- |
| `F` | 全屏 |
| `D` / `M` / `Shift+E` | 控制台 / 手动签到 / 导出 CSV |
| `Space` | 仅演示模式：模拟一次签到 |

`?demo` 假数据 · `?desk` 打开页面即展开控制台 · `?cell=22` 更大字号 · `?fine=2` 更粗的背景字符 · `?headline=…` 覆盖标题 · `?style=3&color=2&hold` 固定形态和颜色 · `?raw` 不带 ASCII 的 3D 场景。

没有配置活动的全新仓库会运行演示模式（假来宾、假码）。配置活动后，`/` 显示真实签到，`?demo` 可强制看演示。

## 仓库结构

```
src/index.html           欢迎墙页面（three.js 和 qrcode-generator 构建时内联）
serve.mjs                服务：静态页、名单、发码、邮件队列、webhook
luma-checkin-poller.mjs  组织者电脑上的 Luma 轮询脚本
luma-event.mjs           把 Luma 链接/slug 解析成活动 id 和标题
build.mjs                构建 → dist/index.html（--no-codes 生成不含码的公开版）
tunnel.mjs, hook-relay.mjs  笔记本模式：cloudflared 临时隧道 + 仅暴露 webhook
data/                    codes.json、state.json、check-in-cache.json、archive/
```

## 致谢

three.js（MIT）和 qrcode-generator（MIT）放在 `src/vendor/`。邮件头图来自 Grok Bot 品牌素材。
