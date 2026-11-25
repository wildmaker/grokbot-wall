# Grok Bot · Check-in Wall

A single-file Three.js "terminal" for a Grok Bot meetup: guests check in on Luma, a
full-screen ASCII Grok Bot greets each one by name on the venue screen, and every guest is
emailed a Cursor referral code (credits) the moment they check in.

Everything on screen is one WebGL character grid: a 3D Grok Bot rendered through an ASCII
shader, morphing between the eight official Grok Bot silhouettes in the brand colours; a
drifting headline and colour field on a finer grid behind it; a live check-in feed and a
block-letter welcome as overlays. Click or tap the art for an ASCII shockwave.

The server does the work: it polls Luma (and accepts its webhook), allocates one code per
guest, and emails it via Resend. The wall page is a viewer. A hidden staff console handles
lookups, resends, manual check-ins, and a CSV export.

## Quick start (local, demo mode)

```sh
npm start                      # builds dist/index.html and serves http://localhost:8787
```

On a fresh checkout with no configured event, the wall runs a demo with fake guests and
placeholder codes. Press `Space` to fake a check-in, `F` for fullscreen. Once an event is
configured, `/` shows persisted real check-ins; use `?demo` to request the fake stream.

## One repo, many events

Everything event-specific lives in `.env` (and `data/`), so each meetup is just another
copy of the config:

```sh
LUMA_EVENT_URL=https://luma.com/spacexai-zhengzhou1128   # which Luma event to read
EVENT_NAME=                                              # headline; empty = the event's Luma title
LUMA_POLL_ON_START=0                                     # polling always boots OFF
```

`LUMA_EVENT_URL` takes a luma.com link, a bare slug, or an `evt-…` id. It is resolved to the
event id and title through Luma's public page API at startup, so no API key or login is
needed for that step. The wall headline is `EVENT_NAME` if set, otherwise the event's own
Luma title (also used in the email subject). The poller and the wall always follow the same
event: the poller asks the wall which one it is serving. You can also paste a different
link in the desk console under **settings** (`D` → settings → *luma event link or id*).

For a new city: copy `.env.example` to a fresh `.env`, use a fresh `data/` (or press
**reset allocations**), and put that city's `data/codes.json` in place. `.env` always beats
the event stored in `data/state.json`.

## Is check-in polling working? (status light)

Polling is a switch, **off by default**: open the desk console (bottom-right **desk**
button, or `D`) and use its **POLL** toggle. The server forgets its previous setting on
every restart (`LUMA_POLL_ON_START=1` opts back in). While it is off nothing is requested
from Luma.

A status light shows whether detection is really alive, in the bottom bar of the venue
screen and as a chip in the desk console header (hover for details):

| status | meaning |
| --- | --- |
| `POLL ○ OFF` | the switch is off; nothing is being read |
| `LUMA ● LIVE 2s` | last successful poll finished 2 s ago |
| `POLLER ✗ OFFLINE` | POLL is on but the helper's heartbeat stopped (is `npm run checkins:on` still running?) |
| `POLLER ✗ NOT RUNNING` | POLL is on and no helper has ever reported |
| `LUMA ✗ LOGIN` | the saved Luma session expired: `npm run checkins:login`, restart the helper |
| `LUMA ✗ <message>` | the last poll failed (network, Luma error, or the wall refused a check-in) |
| `WALL ✗ RECONNECTING` | this page lost the wall server |

The helper POSTs a heartbeat to the wall after every poll (`POST /poller/status`), so the
light reflects real Luma requests rather than just "the process exists".

## Standalone check-in poller

`luma-checkin-poller.mjs` is a Node script on the organizer's machine, not frontend code. It
drives a local Chrome (Playwright, persistent profile under `data/luma-browser-profile/`)
that is logged in to Luma, calls Luma's organizer check-in list from inside that page, and
POSTs new check-ins to the wall's `/allocate`. The wall page itself only polls the wall
server. It does not require a Luma API key. Polling is **off by default**, so this command
makes no network request:

```sh
npm run checkins
```

Save the organizer login once, start the wall, and then explicitly turn polling on:

```sh
npm run checkins:login    # first run only: log into Luma in the opened Chrome window
npm start                 # terminal 1: wall server
npm run checkins:on       # terminal 2: wait for the desk-console polling switch
npm run checkins:once     # fetch once, update the cache, and exit
npm run checkins:status   # read the cache without contacting Luma
```

Open the desk console (`?manual&desk`) and use the **POLL OFF / POLL ON** switch in its
header. The switch is off by default, is stored in `data/state.json`, and pauses/resumes
both the browser-session helper and the official API poller without stopping either
process.

The first enabled run creates `data/check-in-cache.json` as a baseline and reports the
current `latest` guest without replaying every historical check-in. Later polls emit one
`{"type":"check_in","username":"..."}` line per new check-in and POST it to the local wall.
Open the keyless wall as `http://localhost:8787/`; if `WALL_TOKEN` is set, both
processes read it from `.env`. Set `LUMA_CHECKIN_POLL_ENABLED=1` instead of using `--on`,
or change the interval with `LUMA_CHECKIN_POLL_MS` (minimum 1000 ms). The Chrome login is
stored locally under `data/luma-browser-profile/` and ignored by Git.

This mode uses Luma's organizer web session and an undocumented admin endpoint, so Luma
may change it. The API-key/webhook setup below remains the official hosted option.

## Running it for real

1. `cp .env.example .env` and fill in:
   - `LUMA_EVENT_URL` — the event's luma.com link (see *One repo, many events*).
   - `EVENT_NAME` — optional headline override; defaults to the event's Luma title.
   - `LUMA_API_KEY` (Luma → Settings → Developer → API Keys), only for the official-API mode.
   - `RESEND_API_KEY` and `EMAIL_FROM` (the sender domain must be verified in Resend).
   - `WALL_TOKEN` — any secret; the wall is opened as `/?key=<token>`.
   - `PUBLIC_URL` — the public https URL once hosted (used for the email hero image and to
     self-register the Luma webhook).
2. Put your referral codes in `data/codes.json` (same shape as `data/codes.example.json`:
   two pools, each a list of `{code, url}`). Codes are handed out one per guest, pool A
   first; "one from each pool" is a setting in the staff console.
3. `npm start`, open `http://localhost:8787/?key=<token>` and press `F`.

Rehearsal switches in `.env`: `EMAIL_DRY_RUN=1` logs instead of sending; `EMAIL_TEST_TO`
redirects every guest email to you. Clear both before doors open. Restart after editing.

## Hosting (Docker on a box + Cloudflare tunnel)

```sh
git clone <this repo> && cd grokbot-wall
cp .env.example .env            # fill it in as above
cp data/codes.example.json data/codes.json   # then replace with your real codes
docker compose up -d --build    # wall on 127.0.0.1:8787
```

For a public https hostname without opening ports, use a Cloudflare named tunnel:
`cloudflared tunnel login`, `cloudflared tunnel create grokbot`,
`cloudflared tunnel route dns grokbot grokbot.example.com`, copy the credentials JSON into
`cloudflared/` next to a `config.yml` made from `config.example.yml`, set `PUBLIC_URL`, and
run `docker compose --profile tunnel up -d`. With `PUBLIC_URL` set the server registers a
Luma `guest.updated` webhook for itself (check-ins then show in about a second; polling
every 5 s is the fallback). `deploy.sh` wraps the compose commands.

`WALL_TOKEN` gates every route except the webhook and `/assets`. `data/state.json` holds
allocations and email status and survives restarts. The hosted HTML never embeds codes.

## Staff console

Click the **desk** button in the bottom-right corner (or press `D`; `?desk` still auto-opens
it): search guests, see a guest's code and QR, resend their email, release a code back to
the pool, do a manual check-in for walk-ins, export a CSV, change settings (event, pool
mode, poll interval).

## How the email queue behaves

Sends are queued at 2/s with a timeout on each request, retries on rate limits and
transient failures, and a sweep every 20 s that re-queues anything stuck; a restart
re-queues every pending send. `GET /email/status`, `POST /email/sweep`, and `POST /email/send-now`
exist for emergencies. Guests with no email or no code left are recorded as skipped.

## Keys and URL params

| key | action |
| --- | --- |
| `F` | fullscreen |
| `Space` | demo only: fake a check-in |
| `D` / `M` / `Shift+E` | desk console / manual check-in / export CSV |

`?demo` fake guests · `?desk` auto-open desk console · `?cell=22` bigger text · `?fine=2`
chunkier backdrop glyphs · `?headline=…` override the headline · `?style=3&color=2&hold`
freeze a bot form and colour · `?raw` 3D scene without the ASCII pass.

## Layout of the repo

```
src/index.html      the wall (three.js UMD + qrcode-generator are inlined by the build)
serve.mjs           server: static, Luma proxy + polling, allocation, Resend queue, webhook
build.mjs           → dist/index.html  (--no-codes for a public copy)
tunnel.mjs          laptop mode: cloudflared quick tunnel + webhook lifecycle
hook-relay.mjs      exposes only the webhook path for that tunnel
assets/hero-blue.jpg  email header, from the Grok Bot brand kit
data/codes.example.json  shape of the referral-code file
```

## Credits

three.js (MIT) and qrcode-generator (MIT) are vendored in `src/vendor/`. The email header
image is from the Grok Bot brand kit.
