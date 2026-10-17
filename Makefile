# Grok Bot 欢迎墙 · 快捷管理
# 所有目标都是对 npm 脚本 / curl 的薄封装，不含业务逻辑。
# 写入 .env 的目标需要重启 `make start` 才生效。

SHELL := /bin/bash
PORT  := $(shell grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- | tr -d ' ' || echo 8787)
URL   := http://127.0.0.1:$(PORT)
LOGS  := $(CURDIR)/logs

.DEFAULT_GOAL := help

# ---------------------------------------------------------------- 运行
# 默认后台运行：输出写 logs/*.log，命令立刻返回并打印日志绝对路径。
# 用 `make logs` / `make logs-checkins` 跟踪输出，`make stop` 停止。
start:            ## 构建并启动欢迎墙（后台，日志 logs/wall.log）
	@mkdir -p $(LOGS)
	@if pgrep -f 'node serve\.mjs' >/dev/null 2>&1; then echo "  墙已在运行（make stop 后再 start）"; else \
		nohup npm start >> $(LOGS)/wall.log 2>&1 & \
		echo "  墙已启动  pid=$$!"; fi
	@echo "  日志  $(LOGS)/wall.log"

checkins:         ## 持续轮询 Luma 签到（后台，日志 logs/poller.log）
	@mkdir -p $(LOGS)
	@if pgrep -f 'luma-checkin-poller' >/dev/null 2>&1; then echo "  轮询器已在运行（make stop 后再 checkins）"; else \
		nohup npm run checkins:on >> $(LOGS)/poller.log 2>&1 & \
		echo "  轮询器已启动  pid=$$!"; fi
	@echo "  日志  $(LOGS)/poller.log"

once:             ## 立即检查一次签到然后退出
	@npm run checkins:once

logs:             ## 跟踪墙日志（logs/wall.log）
	@tail -f $(LOGS)/wall.log

logs-checkins:    ## 跟踪轮询器日志（logs/poller.log）
	@tail -f $(LOGS)/poller.log

# ---------------------------------------------------------------- 查询
status:           ## 看墙 / 轮询缓存 / 相关进程
	@echo ""
	@printf '%b\n' "  \033[36m墙服务\033[0m  $(URL)"
	@if curl -sf -m 3 $(URL)/health -o /tmp/.wall-health 2>/dev/null; then \
		python3 -c "import json;d=json.load(open('/tmp/.wall-health'));mail=d.get('email',{});print('\033[32m    ● 运行中\033[0m  ' + (d.get('eventName') or '(未命名)') + '  ·  luma ' + ('有key' if d.get('luma') else '无key') + '  ·  邮件 ' + ('dry-run' if mail.get('dryRun') else ('开' if mail.get('enabled') else '关')))"; \
	else printf '%b\n' "    \033[31m● 未运行\033[0m"; fi
	@echo ""
	@printf '%b\n' "  \033[36m轮询缓存\033[0m"
	@npm run --silent checkins:status 2>/dev/null | python3 -c "import json,sys;j=json.load(sys.stdin);l=j.get('latest') or {};print('    活动   ' + str(j.get('eventId')));print('    最新   ' + (l.get('username') or '无') + '  ' + (l.get('checkedInAt') or ''));print('    更新   ' + str(j.get('updatedAt')))" 2>/dev/null || printf '%b\n' "    \033[33m缓存不可读\033[0m"
	@echo ""
	@printf '%b\n' "  \033[36m页面\033[0m（当前目录打开即用）"
	@TOKEN=$$(grep -E '^WALL_TOKEN=' .env 2>/dev/null | cut -d= -f2- | tr -d ' '); \
	K=""; [ -n "$$TOKEN" ] && K="key=$$TOKEN&"; \
	LAN=$$(ipconfig getifaddr en0 2>/dev/null); \
	printf '%b\n' "    大屏     $(URL)/?$${K}manual"; \
	printf '%b\n' "    大屏带音乐+控制台  $(URL)/?$${K}manual&desk&music"; \
	printf '%b\n' "    控制台   $(URL)/?$${K}manual&desk"; \
	if [ -n "$$LAN" ]; then printf '%b\n' "    局域网   http://$$LAN:$(PORT)/?$${K}manual"; else printf '%b\n' "    局域网   \033[33m(无 en0 IP)\033[0m"; fi
	@echo ""
	@printf '%b\n' "  \033[36m进程\033[0m"
	@ps -eo pid,etime,command | grep -E 'node serve\.mjs|luma-checkin-poller' | grep -v grep | awk '{printf "    %-7s %-10s %s\n", $$1, $$2, ($$0 ~ /serve/ ? "墙" : "轮询器")}' || true
	@ps -eo pid,command | grep -q '[l]uma-browser-profile' && printf '%b\n' "    \033[36m专用 Chrome 在运行\033[0m" || true
	@ps -eo pid,command | grep -qE '[n]ode serve\.mjs|[l]uma-checkin-poller' || printf '%b\n' "    \033[33m无相关进程\033[0m"
	@echo ""
	@printf '%b\n' "  \033[36m日志\033[0m"
	@test -f $(LOGS)/wall.log && printf '%b\n' "    墙       $(LOGS)/wall.log" || printf '%b\n' "    墙       \033[33m(尚未生成，先 make start)\033[0m"
	@test -f $(LOGS)/poller.log && printf '%b\n' "    轮询器   $(LOGS)/poller.log" || printf '%b\n' "    轮询器   \033[33m(尚未生成，先 make checkins)\033[0m"
	@echo ""

url:              ## 打印大屏 / 控制台地址
	@echo "大屏     $(URL)/?manual"
	@echo "控制台   $(URL)/?manual&desk"
	@echo "局域网   http://$$(ipconfig getifaddr en0 2>/dev/null || echo '<本机IP>'):$(PORT)/?manual"

state:            ## 看已分配名单（服务端 state.json）
	@python3 -m json.tool data/state.json 2>/dev/null || echo "无 data/state.json"

# ---------------------------------------------------------------- 开关
# 墙未运行时给出干净提示，而不是 curl 的原始报错
REQUIRE_WALL = @curl -sf -m 3 $(URL)/health -o /dev/null 2>/dev/null || { printf '%b\n' "  \033[31m墙未运行\033[0m ($(URL)) — 先跑 make start"; exit 1; }

po:               ## 打开轮询开关（POLL ON）
	$(REQUIRE_WALL)
	@curl -sS -X POST $(URL)/config -H 'content-type: application/json' -d '{"pollEnabled":true}' | python3 -c "import json,sys;j=json.load(sys.stdin);print('  轮询  \033[32mPOLL ON\033[0m  (每 ' + str(round(j['config']['pollMs']/1000)) + 's)')"

pf:               ## 关闭轮询开关（POLL OFF）
	$(REQUIRE_WALL)
	@curl -sS -X POST $(URL)/config -H 'content-type: application/json' -d '{"pollEnabled":false}' | python3 -c "import json,sys;json.load(sys.stdin);print('  轮询  \033[33mPOLL OFF\033[0m')"

reset:            ## 清空全部分配（服务端自动写备份）
	$(REQUIRE_WALL)
	@curl -sS -X POST $(URL)/reset >/dev/null && echo "  已清空全部分配（备份写在 data/state.backup-*.json）"

# ---------------------------------------------------------------- 登录
login:            ## 打开专用 Chrome 登录 Luma（首次或登录过期时）
	@npm run checkins:login

relogin:          ## 换账号：停进程 → 备份 profile → 重新登录
	@echo "1/3 停止轮询器与其 Chrome…"
	@-pkill -f 'luma-checkin-poller' 2>/dev/null || true
	@-pkill -f 'luma-browser-profile' 2>/dev/null || true
	@sleep 2
	@echo "2/3 备份当前登录态…"
	@if [ -d data/luma-browser-profile ]; then \
		mv data/luma-browser-profile "data/luma-browser-profile.bak-$$(date +%Y%m%d-%H%M%S)"; \
		echo "  已备份 $${_}"; \
	else echo "  无既有 profile"; fi
	@echo "3/3 打开 Chrome 登录新账号（登录完成后进程自动退出）…"
	@npm run checkins:login
	@echo "完成。用 'make checkins' 恢复轮询。"

# `make total 40` 的位置参数：取 MAKECMDGOALS 里目标名之后的第一个词
ARG := $(word 2,$(MAKECMDGOALS))

# ---------------------------------------------------------------- 环境变量替换（写法1：sed 替换已存在的键）
event:            ## 切换活动 ID：make event evt-xxxxx
	@test -n "$(ARG)" || { echo "用法: make event evt-xxxxx"; exit 1; }
	@sed -i '' -E 's|^LUMA_EVENT_ID=.*|LUMA_EVENT_ID=$(ARG)|' .env
	@echo "已写入：" $$(grep '^LUMA_EVENT_ID=' .env)
	@echo "重启 'make start' 和 'make checkins' 后生效。"

token:            ## 设置访问令牌：make token abc123
	@test -n "$(ARG)" || { echo "用法: make token <token>"; exit 1; }
	@sed -i '' -E 's|^WALL_TOKEN=.*|WALL_TOKEN=$(ARG)|' .env
	@echo "已写入：" $$(grep '^WALL_TOKEN=' .env)
	@echo "重启 'make start' 后生效；大屏改用 /?key=<token> 打开。"

name:             ## 设置活动名（大屏标题）：make name "Grok Bot Meetup"
	@test -n "$(ARG)" || { echo "用法: make name \"活动名\""; exit 1; }
	@sed -i '' -E 's|^EVENT_NAME=.*|EVENT_NAME=$(ARG)|' .env
	@echo "已写入：" $$(grep '^EVENT_NAME=' .env)
	@echo "重启 'make start' 后生效。"

# 吞掉位置参数，避免 make 把它们当成目标去构建
%:
	@:

env:              ## 看当前 .env（密钥打码）
	@grep -vE '^\s*#|^\s*$$' .env | sed -E 's/(KEY|TOKEN)=.+/=***/'

# ---------------------------------------------------------------- 清理
stop:             ## 停止墙 + 轮询器 + 专用 Chrome
	@-pkill -f 'luma-checkin-poller' 2>/dev/null || true
	@-pkill -f 'luma-browser-profile' 2>/dev/null || true
	@-pkill -f 'node serve\.mjs' 2>/dev/null || true
	@sleep 1
	@echo "已停止：" && (ps -eo pid,command | grep -E 'serve\.mjs|luma-checkin-poller|luma-browser-profile' | grep -v grep || echo "  无残留")

clean:            ## 删除构建产物、缓存与日志（保留 state.json 和登录态）
	@rm -rf dist data/check-in-cache.json logs
	@echo "已删除 dist/ 、data/check-in-cache.json 和 logs/"

restart:          ## 重启一切（墙 + 轮询器，后台）
	@$(MAKE) --no-print-directory stop
	@$(MAKE) --no-print-directory start
	@$(MAKE) --no-print-directory checkins
	@printf '%b\n' "  \033[32m重启完成（墙 + 轮询器）\033[0m"

restart-wall:     ## 只重启墙（轮询器不动）
	@-pkill -f 'node serve\.mjs' 2>/dev/null || true
	@sleep 1
	@$(MAKE) --no-print-directory start
	@printf '%b\n' "  \033[32m墙已重启\033[0m"

help:             ## 显示本帮助
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  带参数：make event evt-xxx · make token abc · make name \"...\""
