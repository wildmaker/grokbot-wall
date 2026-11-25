// Turns whatever the organiser pastes (a luma.com link, a bare slug, or an evt-… id) into the
// Luma event id + name. Uses Luma's public page API, so it needs neither an API key nor a login.

const API = 'https://api.luma.com';
const HOSTS = /^(?:www\.)?(?:luma\.com|lu\.ma|luma\.co)$/i;

export function parseEventRef(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^evt-[A-Za-z0-9]+$/.test(raw)) return { kind: 'id', id: raw };
  let slug = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(?:www\.)?(?:luma\.com|lu\.ma|luma\.co)\//i.test(raw)) {
    let url;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
    if (!HOSTS.test(url.hostname)) return null;
    slug = url.pathname.split('/').filter(Boolean)[0] || '';
  }
  slug = slug.replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(slug) ? { kind: 'slug', slug } : null;
}

async function getJson(url, ms = 10_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: ac.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Luma ${response.status}: ${body.message || 'request failed'}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const pickEvent = body => {
  const ev = body?.event || body?.data?.event || body?.data || body || {};
  return { id: ev.api_id || body?.api_id || body?.data?.api_id || null, name: ev.name || '', startAt: ev.start_at || '' };
};

// -> { id, name, startAt }. Throws a readable error when the link cannot be resolved.
export async function resolveEvent(input) {
  const ref = parseEventRef(input);
  if (!ref) throw new Error(`Not a Luma event link or id: "${input}"`);
  if (ref.kind === 'id') {
    const found = pickEvent(await getJson(`${API}/event/get?event_api_id=${encodeURIComponent(ref.id)}`).catch(() => ({})));
    return { id: ref.id, name: found.name, startAt: found.startAt };
  }
  const body = await getJson(`${API}/url?url=${encodeURIComponent(ref.slug)}`);
  if (body.kind && body.kind !== 'event') throw new Error(`"${ref.slug}" is a Luma ${body.kind} page, not an event`);
  const found = pickEvent(body.data);
  if (!found.id) throw new Error(`Luma returned no event id for "${ref.slug}"`);
  return found;
}
