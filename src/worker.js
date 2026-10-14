// Spearpoint Studio site worker.
// - Serves the static site from ./public
// - /api/stats         live totals + latest posts from Zernio (cached ~30 min)
// - /api/thumb/<code>  post thumbnails, proxied so expiring CDN links never break the page
//
// Needs one secret: ZERNIO_API_KEY (set in Cloudflare, never in this repo).

const ZERNIO = 'https://zernio.com/api/v1';
const STATS_TTL = 30 * 60;          // seconds
const THUMB_TTL = 6 * 60 * 60;      // seconds
const CACHE_HOST = 'https://cache.spearpointpro.internal';

let memo = null; // per-isolate copy: { body, at }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/stats') return statsResponse(env, ctx);
    if (url.pathname.startsWith('/api/thumb/')) return thumbResponse(url.pathname.slice(11), env, ctx);
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};

// ---------- /api/stats ----------

async function statsResponse(env, ctx) {
  try {
    const body = await getStats(env, ctx);
    return json(body, 200, { 'Cache-Control': 'public, max-age=300' });
  } catch (err) {
    if (memo) return json(memo.body, 200, { 'Cache-Control': 'public, max-age=60' });
    // Safe to show: says which step failed, never the key.
    const reason = /ZERNIO_API_KEY/.test(err.message) ? 'missing-key'
      : (/-> (\d+)/.exec(err.message) || [])[1] ? 'zernio-' + /-> (\d+)/.exec(err.message)[1]
      : 'fetch-failed';
    return json({ error: 'Stats are unavailable right now.', reason }, 503, { 'Cache-Control': 'no-store' });
  }
}

async function getStats(env, ctx) {
  const now = Date.now();
  if (memo && now - memo.at < STATS_TTL * 1000) return memo.body;

  const cache = caches.default;
  const key = new Request(CACHE_HOST + '/stats-v1');
  const hit = await cache.match(key);
  if (hit) {
    const body = await hit.json();
    memo = { body, at: Date.parse(body.updatedAt) || now };
    return body;
  }

  if (!env.ZERNIO_API_KEY) throw new Error('ZERNIO_API_KEY is not set');
  const body = await buildStats(env.ZERNIO_API_KEY);
  memo = { body, at: now };
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${STATS_TTL}` },
  })));
  return body;
}

async function zernio(path, apiKey) {
  const res = await fetch(ZERNIO + path, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': 'spearpointpro.com site' },
  });
  if (!res.ok) throw new Error(`Zernio ${path} -> ${res.status}`);
  return res.json();
}

function isoDay(msAgo) {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 10);
}

export async function buildStats(apiKey, fetchJson = zernio) {
  // Every post from the last year (Zernio's max range), newest first.
  const posts = [];
  const from = isoDay(365 * 864e5);
  for (let page = 1; page <= 10; page++) {
    const d = await fetchJson(`/analytics?fromDate=${from}&limit=100&page=${page}&sortBy=date&order=desc`, apiKey);
    posts.push(...(d.posts || []));
    const pages = (d.pagination && d.pagination.pages) || 1;
    if (page >= pages) break;
  }

  // Followers now and two weeks ago.
  let followers = 0, followersBefore = 0;
  try {
    const f = await fetchJson(`/accounts/follower-stats?fromDate=${isoDay(15 * 864e5)}&granularity=daily`, apiKey);
    for (const a of f.accounts || []) {
      followers += Number(a.currentFollowers) || 0;
      const series = (f.stats && f.stats[a._id]) || [];
      followersBefore += series.length ? Number(series[0].followers) || 0 : Number(a.currentFollowers) || 0;
    }
  } catch (_) { /* followers are optional */ }

  const totals = { views: 0, shares: 0, likes: 0, saves: 0, posts: posts.length, followers,
    followerGrowthPct: followersBefore > 0 ? ((followers - followersBefore) / followersBefore) * 100 : 0 };

  const byShortcode = {};
  const groups = new Map(); // the same video cross-posted to IG + TikTok becomes one entry

  for (const p of posts) {
    const a = p.analytics || {};
    totals.views += a.views || 0;
    totals.shares += a.shares || 0;
    totals.likes += a.likes || 0;
    totals.saves += a.saves || 0;

    const platform = p.platform || (p.platforms && p.platforms[0] && p.platforms[0].platform) || '';
    const url = p.platformPostUrl || (p.platforms && p.platforms[0] && p.platforms[0].platformPostUrl) || '';
    const code = instagramCode(url);
    if (code) byShortcode[code] = { views: a.views || 0, shares: a.shares || 0, likes: a.likes || 0, saves: a.saves || 0, reach: a.reach || 0 };

    const title = cleanTitle(p.content);
    const gkey = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40);
    const id = postId(url);
    const g = groups.get(gkey) || { title, publishedAt: p.publishedAt, views: 0, shares: 0, platforms: [], url: '', thumbId: '', igThumb: false };
    g.views += a.views || 0;
    g.shares += a.shares || 0;
    const label = platform === 'instagram' ? 'Instagram' : platform === 'tiktok' ? 'TikTok' : platform;
    if (label && !g.platforms.includes(label)) g.platforms.push(label);
    if (p.publishedAt && p.publishedAt < g.publishedAt) g.publishedAt = p.publishedAt;
    // Prefer the Instagram copy for the link and thumbnail.
    if (code || !g.url) g.url = cleanUrl(url) || g.url;
    if (p.thumbnailUrl && id && (code || !g.igThumb)) { g.thumbId = id; g.igThumb = Boolean(code); }
    groups.set(gkey, g);
  }

  const latest = [...groups.values()]
    .sort((x, y) => (y.publishedAt || '').localeCompare(x.publishedAt || ''))
    .slice(0, 6)
    .map(g => ({
      title: g.title, publishedAt: g.publishedAt, views: g.views, shares: g.shares,
      platforms: g.platforms.sort(), url: g.url,
      thumb: g.thumbId ? `/api/thumb/${g.thumbId}` : null,
    }));

  // Thumbnail sources stay server-side (they are signed CDN links).
  const thumbs = {};
  for (const p of posts) {
    const id = postId(p.platformPostUrl || '');
    if (id && p.thumbnailUrl) thumbs[id] = p.thumbnailUrl;
  }

  return { updatedAt: new Date().toISOString(), totals, byShortcode, latest, _thumbs: thumbs };
}

function instagramCode(url) {
  const m = /instagram\.com\/reels?\/([A-Za-z0-9_-]+)/.exec(url || '');
  return m ? m[1] : '';
}

function cleanLine(s) {
  return String(s || '')
    .replace(/#[\w]+/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(content) {
  const line = String(content || '').split('\n').map(cleanLine).find(s => /[A-Za-z]/.test(s)) || '';
  if (line) return line.slice(0, 90);
  // Caption is only emoji/hashtags: name the series instead.
  const tags = String(content || '').toLowerCase();
  if (tags.includes('#pineridgepest')) return 'New from Pine Ridge Pest Co.';
  if (tags.includes('#cavebase')) return 'New from Cave Base';
  return 'New on Spearpoint';
}

function postId(url) {
  const ig = instagramCode(url);
  if (ig) return ig;
  const tt = /tiktok\.com\/@[^/]+\/video\/(\d+)/.exec(url || '');
  return tt ? 'tt' + tt[1] : '';
}

function cleanUrl(url) {
  return /tiktok\.com/.test(url || '') ? String(url).split('?')[0] : url;
}

// ---------- /api/thumb/<code> ----------

async function thumbResponse(code, env, ctx) {
  if (!/^[A-Za-z0-9_-]{5,40}$/.test(code)) return new Response('Not found', { status: 404 });
  const cache = caches.default;
  const key = new Request(`${CACHE_HOST}/thumb/${code}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  let src;
  try { src = (await getStats(env, ctx))._thumbs[code]; } catch (_) { /* fall through */ }
  if (!src) return new Response('Not found', { status: 404 });

  const img = await fetch(src);
  if (!img.ok) return new Response('Not found', { status: 404 });
  const res = new Response(img.body, {
    headers: {
      'Content-Type': img.headers.get('Content-Type') || 'image/jpeg',
      'Cache-Control': `public, max-age=${THUMB_TTL}`,
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

// ---------- helpers ----------

function json(body, status = 200, headers = {}) {
  const out = body && body._thumbs ? { ...body, _thumbs: undefined } : body;
  return new Response(JSON.stringify(out), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
