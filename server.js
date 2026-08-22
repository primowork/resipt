/**
 * Static host + RiseUp API relay.
 *
 * The browser can't call https://input.riseup.co.il directly — that API is built
 * for server-side use and doesn't send CORS headers, so the request dies in
 * preflight. Relaying it through the same origin that serves the page sidesteps
 * CORS entirely: to the browser it's just a same-origin request.
 *
 *   GET /api/riseup/transactions?cashflowMonth=YYYY-MM
 *     -> GET https://input.riseup.co.il/api/external/transactions?...
 *
 * The token comes from the RISEUP_PAT env var when set (preferred — it never
 * touches the browser), otherwise from the Authorization header the app sends.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const UPSTREAM = (process.env.RISEUP_API_BASE || 'https://input.riseup.co.il').replace(/\/+$/, '');
const ENV_PAT = process.env.RISEUP_PAT || '';

// Allowlist, not a pass-through: the token must only ever reach these read endpoints.
const RELAY_ROUTES = new Set(['transactions', 'budget']);

/* ---------------- state ----------------
 * localStorage is not a place to keep anything you care about. On iOS it is cleared for
 * reasons outside anyone's control: ITP drops script-writable storage for a site left
 * alone for a week, removing a home-screen app removes its store, and a different
 * hostname is a different store entirely. Months of accumulation vanish unannounced.
 *
 * This must be a mounted volume. Railway's default filesystem is ephemeral and is wiped
 * on every deploy, so a JSON file written to it would reproduce the very bug this exists
 * to fix — in a place with even less chance of noticing.
 */
const STATE_DIR = process.env.STATE_DIR || '';
const STATE_SALT = process.env.STATE_SALT || '';
const CODE_MIN = 6;   // the code is the whole of the access control

// Named after a hash of the code, so there is no user table to keep and no account to
// manage: the code *is* the access. Salted so that listing the directory reveals nothing.
function stateFile(code) {
  return path.join(STATE_DIR, crypto.createHash('sha256').update(code + STATE_SALT).digest('hex') + '.json');
}

// A short code needs a floor under brute force. Per-IP, in memory: a restart clearing it
// is fine, since a restart also costs the attacker everything they had in flight.
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (attempts.get(ip) || []).filter((t) => now - t < 60_000);
  hits.push(now);
  attempts.set(ip, hits);
  if (attempts.size > 5000) attempts.clear();   // unbounded growth is its own outage
  return hits.length > 10;
}

function codeOf(req) {
  const code = String(req.headers['x-code'] || '');
  return code.length >= CODE_MIN ? code : null;   // never logged, anywhere
}

async function readState(code) {
  try {
    return JSON.parse(await fsp.readFile(stateFile(code), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { rev: 0, state: {} };   // a code nobody has used yet
    throw e;
  }
}

// Written to a temp file and renamed, because a deploy landing mid-write would otherwise
// leave truncated JSON — which reads back as total data loss.
async function writeState(code, body) {
  const file = stateFile(code);
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(body));
  await fsp.rename(tmp, file);
}

async function handleState(req, res) {
  const ip = req.socket.remoteAddress || '?';
  const code = codeOf(req);
  if (!code) {
    if (rateLimited(ip)) return json(res, 429, { error: 'too_many' });
    return json(res, 401, { error: 'bad_code' });
  }

  if (req.method === 'GET') return json(res, 200, await readState(code));

  if (req.method === 'PUT') {
    const body = await readJson(req);
    if (!body || typeof body.state !== 'object' || body.state === null) {
      return json(res, 400, { error: 'bad_body' });
    }
    const current = await readState(code);
    // Two devices, last-write-wins, would let whichever tab was left open quietly erase
    // what the other one saved. A stale rev is refused so the client can merge instead.
    if (Number(body.rev) !== current.rev) {
      return json(res, 409, { error: 'stale', rev: current.rev, state: current.state });
    }
    const next = { rev: current.rev + 1, state: body.state, at: new Date().toISOString() };
    await writeState(code, next);
    return json(res, 200, { rev: next.rev });
  }

  return json(res, 405, { error: 'method_not_allowed' });
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) { req.destroy(); resolve(null); }
    });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json; charset=utf-8'],
};

// What is actually running. "Did it deploy?" was previously answered by squinting at the
// screen and guessing from which buttons were there, which is no answer at all when the
// question is whether a push arrived. Railway injects these; locally they're absent and
// the app just doesn't show the line.
const VERSION = {
  sha: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7),
  branch: process.env.RAILWAY_GIT_BRANCH || '',
  // Process start, not build time: it is the moment this code began serving, which is the
  // thing being asked about.
  startedAt: new Date().toISOString(),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/riseup/')) return relay(req, res, url);
  if (url.pathname === '/api/version') return json(res, 200, VERSION);
  if (url.pathname === '/api/state') {
    return handleState(req, res).catch((e) => {
      console.error('state:', e.message);
      json(res, 500, { error: 'state_unavailable' });
    });
  }

  const entry = STATIC[url.pathname];
  if (!entry || req.method !== 'GET') return send(res, 404, 'text/plain; charset=utf-8', 'Not found');

  fs.readFile(path.join(__dirname, entry[0]), (err, body) => {
    if (err) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    send(res, 200, entry[1], body);
  });
});

async function relay(req, res, url) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

  const route = url.pathname.slice('/api/riseup/'.length);
  if (!RELAY_ROUTES.has(route)) return json(res, 404, { error: 'unknown_route' });

  const token = ENV_PAT || (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return json(res, 401, {
      error: 'missing_token',
      message: 'No RiseUp token. Paste one in the app settings, or set RISEUP_PAT on the server.',
    });
  }

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}/api/external/${route}${url.search}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (e) {
    // Never echo the error verbatim — a failed request can carry the URL and headers.
    console.error('relay: upstream fetch failed:', e.cause?.code || e.message);
    return json(res, 502, { error: 'upstream_unreachable', message: 'Could not reach RiseUp.' });
  }

  const body = await upstream.text();
  send(res, upstream.status, 'application/json; charset=utf-8', body);
}

// `no-cache` does not mean "don't keep it" — it means "keep it, but revalidate before
// reuse", and revalidation needs an ETag or Last-Modified that this server never sent.
// A browser holding a copy it has no way to revalidate serves the copy, which is exactly
// what iOS Safari did: desktop updated, the phone stayed on an old build for days.
// `no-store` is the directive that actually forbids keeping it; the rest cover caches
// that predate it.
const NO_STORE = 'no-store, no-cache, must-revalidate, max-age=0';

function send(res, status, type, body, extra) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': NO_STORE, ...(extra || {}) });
  res.end(body);
}

function json(res, status, body) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

// Refusing to start beats starting without somewhere to save. An app that appears to
// save and does not is how the same data gets lost a second time, quietly.
for (const [name, value] of [['STATE_DIR', STATE_DIR], ['STATE_SALT', STATE_SALT]]) {
  if (!value) {
    console.error(`resipt: ${name} is not set, so nothing would be saved.\n` +
      '  Mount a Railway volume (e.g. at /data), then set STATE_DIR to its mount path\n' +
      '  and STATE_SALT to a long random string. Railway\'s default filesystem is\n' +
      '  ephemeral and is wiped on every deploy, so a plain directory will not do.');
    process.exit(1);
  }
}
try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.accessSync(STATE_DIR, fs.constants.W_OK);
} catch (e) {
  console.error(`resipt: STATE_DIR (${STATE_DIR}) is not writable: ${e.message}`);
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`resipt listening on :${PORT} (upstream ${UPSTREAM}, token from ${ENV_PAT ? 'RISEUP_PAT' : 'client'})`);
});
