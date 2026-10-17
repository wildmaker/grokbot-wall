# AGENTS.md — grokbot-wall

Grok Bot 聚会签到墙：Luma 签到 → 分配 Cursor 推荐码 → 发邮件；大屏是一个单文件 Three.js ASCII「终端」。

## 一句话架构

服务端做所有业务（轮询 Luma、分配码、发邮件），大屏页面只是**只读的观看者**。
`src/index.html` 是唯一的前端源码，`build.mjs` 把 vendor 脚本和码池内联进 `dist/index.html`。

```
src/index.html             大屏（three.js UMD + qrcode 由 build 内联）——唯一前端源码
serve.mjs                  服务端：静态、Luma 代理/轮询、分配、Resend 邮件队列、webhook
build.mjs                  src/index.html → dist/index.html（--no-codes 生成不含码的公开版）
tunnel.mjs                 笔记本模式：cloudflared quick tunnel + webhook 生命周期
hook-relay.mjs             只暴露 POST /webhooks/luma 的转发器（配合隧道）
luma-checkin-poller.mjs    独立轮询器：复用本地 Chrome 登录读签到列表，默认关闭
data/codes.example.json    推荐码文件的结构样板（真实码放 data/codes.json，已 gitignore）
```

## 常用命令

```sh
npm start                    # build + 起服务，http://localhost:8787
npm run serve                # 只起服务（不重新 build）
npm run build                # 只重新生成 dist/index.html
npm run tunnel               # 快速隧道 + 自动注册 Luma webhook（需 cloudflared）
npm run checkins             # 轮询器：只显示 disabled 状态，不发请求
npm run checkins:login       # 首次：在打开的 Chrome 里登录 Luma
npm run checkins:on          # 持续轮询（受 desk 控制台 POLL 开关约束）
npm run checkins:once|:status
```

Docker：`docker compose up -d --build`（只监听 127.0.0.1:8787），`./deploy.sh [tunnel]` 是封装。

`npm start` / `npm run build` / `npm run serve` **不需要** `npm install`；只有 `luma-checkin-poller.mjs`
（`npm run checkins*`）需要 `playwright-core`，先 `npm install`，否则会 `ERR_MODULE_NOT_FOUND: playwright-core`。

## 无依赖、无测试、无 lint

- 依赖只有 `playwright-core`；服务端与前端都是**纯 Node ESM / 原生浏览器 API**，不要引入构建工具或框架。
- **没有测试框架、没有 linter、没有 CI**。不要假装跑测试；改完必须手动验证（见下）。
- 没有任何测试用例文件；`screenshots/` 是人工留档的截图，不要动。

## 验证方式（没有自动化，必须手验）

```sh
npm start                              # 无 .env 时自动进入 demo
open 'http://localhost:8787/?demo'     # 假签到流；Space 手动造一个签到，F 全屏
open 'http://localhost:8787/?manual&desk'   # 无 API key 时的 desk 控制台（D 开/关、M 手动签到、Shift+E 导出 CSV）
curl -s http://127.0.0.1:8787/health   # 服务端自检（返回 luma/auth/email/pools 状态）
```

邮件相关一律用 `EMAIL_DRY_RUN=1`（只打日志）或 `EMAIL_TEST_TO=you@x.com`（全部改投给你）验证，
**不要拿真码真发**。事件当天前记得清掉这两个开关。

## 必须遵守的约定

### 前端（src/index.html）
- 单文件、单 `<script>`，用 `// ====` 横幅分节（CONFIG & DATA / APP STATE / LUMA / DEMO / TERMINAL GRID / 3D SCENE / UI LAYER / CELEBRATION + LOOP / DESK CONSOLE / BOOT）。**新增代码放进对应小节，保持横幅风格，不要重排整个文件。**
- 代码风格是刻意的紧凑单行：`const pick = pool => {...}`、一行一个函数、短命名（`a`=allocation、`G`=grid、`L`=layout）。**不要"美化"成多行，也不要用 Prettier 重排。**
- 一切渲染都走字符网格：`put/fillRect/box/typed/bigText` 写入 `G` 的 cell，3D 只渲染到低分辨率 target 再 ASCII 化。改视觉请用这套 API，不要引入 DOM/SVG 层。
- 大屏隐私：公共屏只显示 `publicName()`（"Ada Lovelace" → "Ada L."），desk 控制台才显示全名。别把全名或完整码放上大屏。
- URL 参数是主要开关，改视觉/模式优先加参数而不是配置文件：模式 `?demo ?manual ?desk ?raw`；外观 `?cell= ?fine= ?headline= ?style= ?color= ?hold ?noblink`；调试 `?burst= ?event= ?noauto ?modal=manual|settings`；鉴权 `?key=`。
- `/*@codes*/null` 是 build 占位符，前端靠 `CODES` 常量工作；**不要把码硬编码进源码**。

### 服务端（serve.mjs）
- `.env` 加载器是手写三行正则（"只在未设置时填充"，显式空环境变量优先）。**不要换成 dotenv。**
- `WALL_TOKEN` 是唯一鉴权：除 `POST /webhooks/luma` 和 `/assets/*` 外所有路由都要 token（header `x-wall-key` 或 `?key=`）。新增路由默认落在鉴权之后，**不要无意中把新路由放到 webhook 之前变成公开接口**。
- 静态与 `/assets` 都用 `path.normalize` + `startsWith(ROOT/...)` 防目录穿越；保持这个模式。
- 状态文件 `data/state.json`（gitignore，保存分配与邮件状态）是业务真相，`save()` 是同步全量写。`state.config` 里 `pollEnabled` 默认 `false`——**不要默认打开轮询**。
- 邮件队列：2/s 节流 + 20s 扫尾重排 + 重启后 `requeueStale(true)`。跳过原因（no email / no codes / not configured）写进 `a.mail.status`，不要静默丢弃。
- 分配逻辑 `allocate()` 按 key 幂等；池顺序由 `poolMode`（`A-then-B` / `B-then-A` / `both`）决定。改这里要同时改前端 `localAllocate()`，两处逻辑必须一致。
- 分配只在"首次见到该 key 且已签到"时发生；Luma 轮询靠 `checked_in_at` 降序 + 60s 全量刷新，改动前先读懂 `pollLuma()` 的 `full`/`stop` 分页早停。
- 服务端日志用 `  ✓ / ✗ / ◎ / ⚡ / ✉ / ↩` 这类前缀，保持可读性。

### 构建（build.mjs）
- `<script src="..." data-inline>` 会被内联，`/*@codes*/null` 被替换成码池 JSON。
- `--no-codes` 产出**不含任何码**的公开版（Dockerfile 就是这么构建的），码只在服务端 `data/codes.json` 里。公开 HTML 永远不内嵌码——这是安全边界，别破坏。
- `dist/` 是生成物且已 gitignore：**永远不要手改 `dist/`，改 `src/` 后重新 build。**
- `src/vendor/` 里是 vendored 的 three.js / qrcode-generator（MIT），除非必须升级，不要动。

### 轮询器（luma-checkin-poller.mjs）
- 默认**关闭**，不显式 `--on` / `LUMA_CHECKIN_POLL_ENABLED=1` 就不发任何请求；`npm run checkins` 必须是零网络行为。
- 用 organizer 浏览器会话 + **未公开的 admin endpoint**，会随 Luma 改动失效；它只是 API key/webhook 之外的兜底路径，别把它当成官方方案。
- 首次启用写 `data/check-in-cache.json` 作为基线（不重放历史签到）；之后每条新签到输出一行 `{"type":"check_in",...}` 并 POST 到墙上 `/allocate`。
- Chrome 登录存 `data/luma-browser-profile/`（gitignore）。所有新开关都要能通过环境变量表达，并同步更新 `usage()`。

### 密钥与数据
- 绝不提交 `.env`、`data/codes.json`、`data/state.json`、`data/luma-browser-profile/`、`cloudflared/*.json`、`cloudflared/config.yml`（都已在 `.gitignore`）。
- `data/` 下的文件是运行期状态，清理前先确认能重建。

## Git

历史提交是简短、聚焦的祈使句（`Add Luma check-in poller and Wuhan meetup tweaks`），一次提交一件事。
主分支 `main`；提交前先手动验证上面的路径，别在改动里顺手重排无关代码。
