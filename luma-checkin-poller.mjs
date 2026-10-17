#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EVENT_ID = 'evt-diEbVteSq6oiKcf';
const DEFAULT_CACHE_FILE = path.join(ROOT, 'data/check-in-cache.json');
const DEFAULT_PROFILE_DIR = path.join(ROOT, 'data/luma-browser-profile');

function loadEnv(file = path.join(ROOT, '.env')) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2]
        .replace(/\s+#.*$/, '')
        .replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    // A .env file is optional.
  }
}

const isTrue = value => /^(1|true|yes|on)$/i.test(String(value || ''));

export function normalizeGuest(entry) {
  const ticketTimes = (entry.event_tickets || [])
    .map(ticket => ticket.checked_in_at)
    .filter(Boolean)
    .sort();
  const checkedInAt =
    entry.last_checked_in_at || entry.checked_in_at || ticketTimes.at(-1) || null;
  const username =
    entry.user_name ||
    entry.name ||
    [entry.user_first_name, entry.user_last_name].filter(Boolean).join(' ') ||
    [entry.first_name, entry.last_name].filter(Boolean).join(' ') ||
    'Guest';
  const id = String(
    entry.user_id ||
      entry.user_api_id ||
      entry.id ||
      entry.api_id ||
      `${username}:${checkedInAt || ''}`,
  );

  return {
    id,
    username,
    checkedInAt,
    email: entry.user_email || entry.email || '',
  };
}

export function checkInKey(guest) {
  return `${guest.id}:${guest.checkedInAt}`;
}

function readCache(cacheFile, eventId) {
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cache.version === 1 && cache.eventId === eventId && Array.isArray(cache.seen)) {
      return cache;
    }
  } catch {
    // Missing, invalid, or stale cache: start from a fresh baseline.
  }
  return { version: 1, eventId, initialized: false, seen: [], latest: null, updatedAt: null };
}

function writeCache(cacheFile, cache) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const temporaryFile = `${cacheFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(cache, null, 2)}\n`);
  fs.renameSync(temporaryFile, cacheFile);
}

class AuthenticationRequiredError extends Error {
  constructor(message = 'Luma login is required') {
    super(message);
    this.name = 'AuthenticationRequiredError';
  }
}

function chromeExecutable() {
  if (process.env.LUMA_CHROME_PATH) return process.env.LUMA_CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find(candidate => fs.existsSync(candidate));
}

async function launchBrowser(profileDir, headless) {
  const executablePath = chromeExecutable();
  if (!executablePath) {
    throw new Error(
      'Chrome was not found. Install Google Chrome or set LUMA_CHROME_PATH.',
    );
  }
  fs.mkdirSync(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless,
    viewport: null,
    // hide the automation fingerprint so Cloudflare's browser check passes on luma.com
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

export async function fetchCheckedInGuests({ page, eventId }) {
  const result = await page.evaluate(async id => {
    const url = new URL('https://api.luma.com/event/admin/get-guests');
    url.searchParams.set('approval_status', 'checked_in');
    url.searchParams.set('event_api_id', id);
    url.searchParams.set('pagination_limit', '50');
    url.searchParams.set('query', '');
    url.searchParams.set('sort_column', 'last_checked_in_at');
    url.searchParams.set('sort_direction', 'desc nulls last');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        credentials: 'include',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, body };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: {
          message:
            error.name === 'AbortError'
              ? 'request timed out after 10 seconds'
              : error.message,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }, eventId);

  if (result.status === 401 || result.status === 403) {
    throw new AuthenticationRequiredError();
  }
  if (!result.ok) {
    throw new Error(
      `Luma ${result.status || 'network error'}: ${result.body.message || 'request failed'}`,
    );
  }

  return (result.body.entries || [])
    .map(normalizeGuest)
    .filter(guest => guest.checkedInAt)
    .sort(
      (left, right) =>
        new Date(right.checkedInAt).getTime() - new Date(left.checkedInAt).getTime(),
    );
}

async function notifyWall(guest, { wallUrl, wallToken }) {
  const url = new URL('/allocate', wallUrl);
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (wallToken) headers['x-wall-key'] = wallToken;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      key: guest.email || guest.id,
      name: guest.username,
      email: guest.email,
      checkedInAt: guest.checkedInAt,
      source: 'luma',
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`wall ${response.status}: ${body.message || response.statusText}`);
  }
  return body.allocation;
}

async function wallPollingEnabled({ wallUrl, wallToken }) {
  const url = new URL('/state', wallUrl);
  const headers = { accept: 'application/json' };
  if (wallToken) headers['x-wall-key'] = wallToken;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`wall ${response.status}: ${body.message || response.statusText}`);
    }
    return Boolean(body.config?.pollEnabled);
  } finally {
    clearTimeout(timeout);
  }
}

function emit(payload, stream = process.stdout) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

export function updateCache(cache, guests, now = new Date().toISOString()) {
  const seen = new Set(cache.seen);
  const newGuests = guests
    .filter(guest => !seen.has(checkInKey(guest)))
    .sort(
      (left, right) =>
        new Date(left.checkedInAt).getTime() - new Date(right.checkedInAt).getTime(),
    );

  for (const guest of guests) seen.add(checkInKey(guest));
  return {
    newGuests: cache.initialized ? newGuests : [],
    cache: {
      ...cache,
      initialized: true,
      seen: [...seen],
      latest: guests[0]
        ? {
            id: guests[0].id,
            username: guests[0].username,
            checkedInAt: guests[0].checkedInAt,
          }
        : cache.latest || null,
      updatedAt: now,
    },
  };
}

function usage() {
  return [
    'Luma browser-session check-in poller (polling is OFF by default)',
    '',
    '  node luma-checkin-poller.mjs              Show disabled status; no request is made',
    '  node luma-checkin-poller.mjs --login      Open Chrome and save the Luma login',
    '  node luma-checkin-poller.mjs --on         Poll until stopped',
    '  node luma-checkin-poller.mjs --once       Fetch once and exit',
    '  node luma-checkin-poller.mjs --status     Read the local cache only',
    '',
    'Environment:',
    `  LUMA_EVENT_ID                    Default: ${DEFAULT_EVENT_ID}`,
    '  LUMA_CHECKIN_POLL_ENABLED=1       Alternative to --on',
    '  LUMA_CHECKIN_POLL_MS=2000         Poll interval (minimum 1000 ms)',
    '  LUMA_CHECKIN_CACHE_FILE=<path>     Override the local cache file',
    '  LUMA_BROWSER_PROFILE_DIR=<path>    Persistent local Chrome login',
    '  LUMA_BROWSER_HEADLESS=1            Hide Chrome after login has been saved',
    '  LUMA_CHECKIN_NOTIFY_WALL=0         Do not POST new guests to the wall',
    '  WALL_URL=http://127.0.0.1:8787     Wall server base URL',
    '  WALL_TOKEN=<token>                 Needed when the wall is protected',
  ].join('\n');
}

async function main() {
  loadEnv();
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log(usage());
    return;
  }

  const eventId = process.env.LUMA_EVENT_ID || DEFAULT_EVENT_ID;
  const cacheFile = path.resolve(process.env.LUMA_CHECKIN_CACHE_FILE || DEFAULT_CACHE_FILE);
  let cache = readCache(cacheFile, eventId);

  if (args.has('--status')) {
    emit({
      type: 'status',
      enabled: false,
      eventId,
      cacheFile,
      initialized: cache.initialized,
      latest: cache.latest,
      updatedAt: cache.updatedAt,
    });
    return;
  }

  const once = args.has('--once');
  const loginOnly = args.has('--login');
  const enabled =
    once ||
    loginOnly ||
    args.has('--on') ||
    isTrue(process.env.LUMA_CHECKIN_POLL_ENABLED);
  if (!enabled) {
    emit({
      type: 'disabled',
      enabled: false,
      message: 'Polling is off. Use --on or set LUMA_CHECKIN_POLL_ENABLED=1.',
    });
    return;
  }

  const pollMs = Math.max(1_000, Number(process.env.LUMA_CHECKIN_POLL_MS) || 2_000);
  const profileDir = path.resolve(
    process.env.LUMA_BROWSER_PROFILE_DIR || DEFAULT_PROFILE_DIR,
  );
  const headless = isTrue(process.env.LUMA_BROWSER_HEADLESS);
  const notifyWallEnabled =
    process.env.LUMA_CHECKIN_NOTIFY_WALL === undefined ||
    isTrue(process.env.LUMA_CHECKIN_NOTIFY_WALL);
  const wallUrl = process.env.WALL_URL || `http://127.0.0.1:${process.env.PORT || 8787}`;
  const wallToken = process.env.WALL_TOKEN || '';
  let stopped = false;
  let timer = null;
  let wake = null;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (wake) wake();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const wait = ms =>
    new Promise(resolve => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
    }).finally(() => {
      timer = null;
      wake = null;
    });

  let context = null;
  let page = null;
  let prefetchedGuests = null;

  const waitForLogin = async () => {
    let announced = false;
    while (!stopped) {
      if (!page || page.isClosed()) throw new Error('Chrome was closed');
      if (/^https:\/\/(?:www\.)?luma\.com\//.test(page.url())) {
        try {
          const guests = await fetchCheckedInGuests({ page, eventId });
          if (announced) emit({ type: 'authenticated', eventId });
          return guests;
        } catch (error) {
          if (!(error instanceof AuthenticationRequiredError)) throw error;
        }
      }
      if (headless) {
        throw new Error(
          'The saved Luma session is not authenticated. Run npm run checkins:login.',
        );
      }
      if (!announced) {
        emit({
          type: 'login_required',
          eventId,
          message: 'Complete the Luma login in the opened Chrome window.',
        });
        announced = true;
      }
      await wait(1_000);
    }
    return [];
  };

  const poll = async () => {
    const wasInitialized = cache.initialized;
    const guests =
      prefetchedGuests || (await fetchCheckedInGuests({ page, eventId }));
    prefetchedGuests = null;
    const result = updateCache(cache, guests);
    const failedKeys = new Set();

    if (!wasInitialized) {
      emit({
        type: 'baseline',
        eventId,
        checkedInCount: guests.length,
        latest: result.cache.latest,
      });
    }
    for (const guest of result.newGuests) {
      try {
        if (notifyWallEnabled) await notifyWall(guest, { wallUrl, wallToken });
        emit({
          type: 'check_in',
          eventId,
          username: guest.username,
          checkedInAt: guest.checkedInAt,
          id: guest.id,
          wallNotified: notifyWallEnabled,
        });
      } catch (error) {
        failedKeys.add(checkInKey(guest));
        emit(
          {
            type: 'wall_error',
            eventId,
            username: guest.username,
            message: error.message,
            at: new Date().toISOString(),
          },
          process.stderr,
        );
      }
    }

    result.cache.seen = result.cache.seen.filter(key => !failedKeys.has(key));
    cache = result.cache;
    writeCache(cacheFile, cache);
  };

  try {
    context = await launchBrowser(profileDir, headless);
    context.once('close', stop);
    page = context.pages()[0] || (await context.newPage());
    const checkInUrl = `https://luma.com/check-in/${encodeURIComponent(eventId)}/guests?tab=checked_in`;
    await page.goto(checkInUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    prefetchedGuests = await waitForLogin();
    if (stopped) return;

    emit({
      type: 'browser_ready',
      eventId,
      profileDir,
      pollMs,
      wallNotifications: notifyWallEnabled,
      controlledByWall: true,
    });
    if (loginOnly) {
      emit({ type: 'login_saved', eventId, profileDir });
      return;
    }

    let consecutiveErrors = 0;
    let pollingActive = null;
    do {
      try {
        if (!once) {
          const switchEnabled = await wallPollingEnabled({ wallUrl, wallToken });
          if (!switchEnabled) {
            prefetchedGuests = null;
            if (pollingActive !== false) {
              emit({ type: 'polling_paused', eventId, message: 'Enable polling in the desk console.' });
            }
            pollingActive = false;
            consecutiveErrors = 0;
            await wait(1_000);
            continue;
          }
          if (pollingActive !== true) emit({ type: 'polling_resumed', eventId });
          pollingActive = true;
        }
        await poll();
        consecutiveErrors = 0;
      } catch (error) {
        if (error instanceof AuthenticationRequiredError) {
          prefetchedGuests = await waitForLogin();
          continue;
        }
        consecutiveErrors += 1;
        emit(
          {
            type: 'error',
            eventId,
            message: error.message,
            at: new Date().toISOString(),
          },
          process.stderr,
        );
        if (once) process.exitCode = 1;
      }
      if (once || stopped) break;
      const delay = Math.min(pollMs * 2 ** consecutiveErrors, 30_000);
      await wait(delay);
    } while (!stopped);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    emit({ type: 'fatal', message: error.message }, process.stderr);
    process.exitCode = 1;
  });
}
