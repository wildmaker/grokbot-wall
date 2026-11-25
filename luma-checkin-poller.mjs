#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveEvent } from './luma-event.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
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

// Reads the desk-console switch (and which event the wall is serving) from the wall server.
async function wallControl({ wallUrl, wallToken }) {
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
    return { enabled: Boolean(body.config?.pollEnabled), eventId: body.config?.eventId || null };
  } finally {
    clearTimeout(timeout);
  }
}

// Heartbeat the wall turns into its status light. Best effort: a failure here never stops polling.
async function reportStatus(status, details, { wallUrl, wallToken }) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (wallToken) headers['x-wall-key'] = wallToken;
  try {
    await fetch(new URL('/poller/status', wallUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ status, ...details }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // wall unreachable: the poll loop reports that itself
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
    '  LUMA_EVENT_URL=<luma.com link>    Event to read (or LUMA_EVENT_ID=evt-...). If neither is set,',
    '                                    the event the wall server is already serving is used',
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

const checkInUrl = eventId =>
  `https://luma.com/check-in/${encodeURIComponent(eventId)}/guests?tab=checked_in`;

// Which event to read. The wall server is the single source of truth (it resolves LUMA_EVENT_URL
// on boot and the desk console can change it); .env is the fallback when the wall isn't up yet.
async function pickEvent(wall) {
  const ref = process.env.LUMA_EVENT_URL || process.env.LUMA_EVENT_ID || '';
  const fromEnv = ref
    ? await resolveEvent(ref).catch(error => {
        emit({ type: 'event_lookup_failed', ref, message: error.message }, process.stderr);
        return null;
      })
    : null;
  let wallEventId = null;
  try {
    wallEventId = (await wallControl(wall)).eventId;
  } catch {
    // wall not reachable yet
  }
  if (wallEventId && fromEnv && wallEventId !== fromEnv.id) {
    emit(
      {
        type: 'event_mismatch',
        message: `.env points at ${fromEnv.id} but the wall is serving ${wallEventId}; following the wall. Restart the wall to apply .env.`,
      },
      process.stderr,
    );
  }
  const id = wallEventId || fromEnv?.id;
  if (!id) {
    throw new Error(
      'No Luma event configured. Set LUMA_EVENT_URL=https://luma.com/<event> in .env (and start the wall first).',
    );
  }
  const info = fromEnv?.id === id ? fromEnv : await resolveEvent(id).catch(() => ({ id, name: '' }));
  return { id, name: info.name || '' };
}

async function main() {
  loadEnv();
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log(usage());
    return;
  }

  const cacheFile = path.resolve(process.env.LUMA_CHECKIN_CACHE_FILE || DEFAULT_CACHE_FILE);
  const wallUrl = process.env.WALL_URL || `http://127.0.0.1:${process.env.PORT || 8787}`;
  const wallToken = process.env.WALL_TOKEN || '';
  const wall = { wallUrl, wallToken };

  if (args.has('--status')) {
    let cached = {};
    try {
      cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      // no cache yet
    }
    emit({
      type: 'status',
      enabled: false,
      eventId: cached.eventId || null,
      cacheFile,
      initialized: Boolean(cached.initialized),
      latest: cached.latest || null,
      updatedAt: cached.updatedAt || null,
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

  let { id: eventId, name: eventName } = await pickEvent(wall);
  let cache = readCache(cacheFile, eventId);

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
  let lastOkAt = 0;
  let lastCount = 0;

  const report = (status, extra = {}) =>
    reportStatus(
      status,
      {
        eventId,
        eventName,
        pollMs,
        lastOkAt,
        checkedInCount: lastCount,
        latest: cache.latest,
        ...extra,
      },
      wall,
    );

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
      const message = 'Complete the Luma login in the opened Chrome window.';
      await report('login_required', { message });
      if (headless) {
        throw new Error(
          'The saved Luma session is not authenticated. Run npm run checkins:login.',
        );
      }
      if (!announced) {
        emit({ type: 'login_required', eventId, message });
        announced = true;
      }
      await wait(1_000);
    }
    return [];
  };

  // Returns how many new check-ins the wall refused (they stay unseen and are retried next poll).
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
    lastCount = guests.length;
    return failedKeys.size;
  };

  // The desk console can point the wall at another event while we run: follow it.
  const switchEvent = async nextId => {
    const info = await resolveEvent(nextId).catch(() => ({ id: nextId, name: '' }));
    eventId = info.id;
    eventName = info.name || '';
    cache = readCache(cacheFile, eventId);
    prefetchedGuests = null;
    lastOkAt = 0;
    lastCount = 0;
    await page.goto(checkInUrl(eventId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    emit({ type: 'event_changed', eventId, eventName });
  };

  // Someone closed the Chrome tab or window mid-event: open it again instead of failing every poll.
  const browserGone = error =>
    !page || page.isClosed() || /has been closed|Target closed|browser has disconnected|Chrome was closed/i.test(error.message || '');
  const reopenBrowser = async () => {
    emit({ type: 'browser_reopening', eventId, message: 'Chrome was closed; reopening it.' });
    await report('starting', { message: 'Chrome was closed; reopening it.' });
    await context?.close().catch(() => {});
    context = await launchBrowser(profileDir, headless);
    page = context.pages()[0] || (await context.newPage());
    await page.goto(checkInUrl(eventId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    prefetchedGuests = await waitForLogin();
  };

  try {
    await report('starting');
    context = await launchBrowser(profileDir, headless);
    page = context.pages()[0] || (await context.newPage());
    await page.goto(checkInUrl(eventId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    prefetchedGuests = await waitForLogin();
    if (stopped) return;

    emit({
      type: 'browser_ready',
      eventId,
      eventName,
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
          const control = await wallControl(wall);
          if (control.eventId && control.eventId !== eventId) await switchEvent(control.eventId);
          if (!control.enabled) {
            prefetchedGuests = null;
            if (pollingActive !== false) {
              emit({ type: 'polling_paused', eventId, message: 'Enable polling in the desk console.' });
            }
            pollingActive = false;
            consecutiveErrors = 0;
            await report('paused');
            await wait(1_000);
            continue;
          }
          if (pollingActive !== true) emit({ type: 'polling_resumed', eventId });
          pollingActive = true;
        }
        const refused = await poll();
        consecutiveErrors = 0;
        lastOkAt = Date.now();
        if (refused) {
          await report('error', {
            message: `wall refused ${refused} check-in${refused > 1 ? 's' : ''}; retrying`,
          });
        } else {
          await report('polling');
        }
      } catch (caught) {
        let error = caught;
        if (error instanceof AuthenticationRequiredError) {
          prefetchedGuests = await waitForLogin();
          continue;
        }
        if (!once && !stopped && browserGone(error)) {
          try {
            await reopenBrowser();
            consecutiveErrors = 0;
            continue;
          } catch (reopenError) {
            error = reopenError;
          }
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
        await report('error', { message: error.message });
        if (once) process.exitCode = 1;
      }
      if (once || stopped) break;
      const delay = Math.min(pollMs * 2 ** consecutiveErrors, 30_000);
      await wait(delay);
    } while (!stopped);
  } finally {
    await report('stopped');
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
