import express from 'express';
import { createHash } from 'node:crypto';

// Sync API for the TreeChat extension.
//
// Identity: there are no accounts. The extension generates a random 256-bit key
// once and keeps it in chrome.storage.sync, so every Chrome signed in to the same
// Google account gets it automatically. The key is sent as a Bearer token; the
// server only ever stores its SHA-256 hash ("owner").
//
// Namespace: one tree per (site, site account). The extension derives it as
// HMAC(key, "<site>:<account id>"), so the server never sees the account id.

const KEY_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url, no padding
const NS_RE = /^[0-9a-f]{64}$/;

export const LIMITS = {
  bodyBytes: 512 * 1024,
  treesPerOwner: 20,
  requestsPerMinute: 120,
};

export function hashKey(key) {
  return createHash('sha256').update(key).digest();
}

// The extension calls from its background service worker, whose origin is
// chrome-extension://<id>. Allowing that by CORS means the extension needs no
// host permission. CORS is not the security boundary here; the key is.
const isExtensionOrigin = (origin) => /^chrome-extension:\/\/[a-p]{32}$/.test(origin);

export function createApp({ store, trustProxy = 0, limits = LIMITS, allowedOrigins = [], now = () => Date.now() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  app.get('/health', async (_req, res) => {
    res.json({ ok: true });
  });

  const v1 = express.Router();
  v1.use(cors(allowedOrigins));
  v1.use(rateLimit(limits.requestsPerMinute, now));
  v1.use(express.json({ limit: limits.bodyBytes }));
  v1.use(auth);

  v1.get('/trees/:ns', validNs, async (req, res) => {
    const row = await store.get(req.owner, req.params.ns);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  });

  v1.put('/trees/:ns', validNs, async (req, res) => {
    const { data, baseVersion = null } = req.body ?? {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'invalid_data' });
    }
    if (baseVersion !== null && !(Number.isInteger(baseVersion) && baseVersion > 0)) {
      return res.status(400).json({ error: 'invalid_base_version' });
    }
    const result = await store.put(req.owner, req.params.ns, data, baseVersion, limits.treesPerOwner);
    if (result.conflict) return res.status(409).json({ error: 'conflict', ...result.current });
    if (result.full) return res.status(403).json({ error: 'too_many_trees' });
    res.json({ version: result.version, updatedAt: result.updatedAt });
  });

  // Turn sync off for good: removes every tree stored under this key.
  v1.delete('/trees', async (req, res) => {
    await store.deleteOwner(req.owner);
    res.status(204).end();
  });

  app.use('/v1', v1);

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // Never echo request bodies or keys back, and never log them.
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    console.error('request failed:', err.code ?? err.name ?? 'error');
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}

function cors(allowedOrigins) {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && (isExtensionOrigin(origin) || allowedOrigins.includes(origin))) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'GET, PUT, DELETE');
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.set('Access-Control-Max-Age', '600');
      }
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

function auth(req, res, next) {
  const match = /^Bearer (\S+)$/.exec(req.get('authorization') ?? '');
  if (!match || !KEY_RE.test(match[1])) return res.status(401).json({ error: 'unauthorized' });
  req.owner = hashKey(match[1]);
  next();
}

function validNs(req, res, next) {
  if (!NS_RE.test(req.params.ns)) return res.status(400).json({ error: 'invalid_namespace' });
  next();
}

// Fixed one-minute window per client IP. In-memory: fine for a single instance.
function rateLimit(perMinute, now) {
  const hits = new Map();
  let windowStart = now();
  return (req, res, next) => {
    if (now() - windowStart >= 60_000) {
      hits.clear();
      windowStart = now();
    }
    const n = (hits.get(req.ip) ?? 0) + 1;
    hits.set(req.ip, n);
    if (n > perMinute) {
      res.set('Retry-After', String(Math.ceil((windowStart + 60_000 - now()) / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }
    next();
  };
}
