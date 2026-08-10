/**
 * Cloudflare Worker proxy for the RiseUp Exposed API.
 *
 * Only needed if the browser blocks the app's direct call to
 * https://input.riseup.co.il (CORS). The Worker holds the RiseUp PAT as a
 * secret, so the token never reaches the browser at all.
 *
 * Deploy:
 *   npx wrangler deploy
 *   npx wrangler secret put RISEUP_PAT     # riseup_pat_…
 *   npx wrangler secret put APP_SECRET     # any long random string
 *
 * Then in the app's settings: base = https://<worker>.workers.dev,
 * token = the APP_SECRET value (not the PAT).
 */

const UPSTREAM = 'https://input.riseup.co.il';

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Authorization, Accept, Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const json = (status, body) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });

    if (request.method !== 'GET') return json(405, { error: 'method not allowed' });

    if (!env.RISEUP_PAT) return json(500, { error: 'RISEUP_PAT secret is not set on the Worker' });

    // Without APP_SECRET the Worker is an open, unauthenticated window onto the
    // account's transactions — anyone with the URL could read them.
    if (!env.APP_SECRET) return json(500, { error: 'APP_SECRET secret is not set on the Worker' });

    const presented = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!timingSafeEqual(presented, env.APP_SECRET)) return json(401, { error: 'unauthorized' });

    const url = new URL(request.url);
    // Allowlist, not a pass-through: the PAT must only ever reach these read endpoints.
    if (!/^\/api\/external\/(transactions|budget)(\/|$)/.test(url.pathname)) {
      return json(404, { error: 'not found' });
    }

    const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      headers: { Authorization: `Bearer ${env.RISEUP_PAT}`, Accept: 'application/json' },
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
    });
  },
};

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
