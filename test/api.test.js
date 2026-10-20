import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createMemoryStore } from '../src/stores/memory.js';
import { createPostgresStore } from '../src/stores/postgres.js';

const newKey = () => randomBytes(32).toString('base64url');
const NS = 'a'.repeat(64);
const NS2 = 'b'.repeat(64);

// Same contract for both stores. Postgres runs only when TEST_DATABASE_URL is set.
const backends = [['memory', async () => createMemoryStore()]];
if (process.env.TEST_DATABASE_URL) backends.push(['postgres', () => createPostgresStore(process.env.TEST_DATABASE_URL)]);

for (const [name, makeStore] of backends) {
  describe(`api (${name})`, () => {
    let server, base, store;
    const limits = { bodyBytes: 4096, treesPerOwner: 2, requestsPerMinute: 1000 };

    before(async () => {
      store = await makeStore();
      server = createApp({ store, limits }).listen(0);
      await new Promise((r) => server.once('listening', r));
      base = `http://127.0.0.1:${server.address().port}`;
    });
    after(async () => {
      await new Promise((r) => server.close(r));
      await store.close();
    });

    const call = (method, path, key, body) =>
      fetch(base + path, {
        method,
        headers: { ...(key && { authorization: `Bearer ${key}` }), ...(body !== undefined && { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });

    test('health', async () => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
    });

    test('rejects missing or malformed keys', async () => {
      assert.equal((await call('GET', `/v1/trees/${NS}`)).status, 401);
      assert.equal((await call('GET', `/v1/trees/${NS}`, 'short')).status, 401);
    });

    test('rejects bad namespaces and data', async () => {
      const key = newKey();
      assert.equal((await call('GET', '/v1/trees/xyz', key)).status, 400);
      assert.equal((await call('PUT', `/v1/trees/${NS}`, key, { data: [1] })).status, 400);
      assert.equal((await call('PUT', `/v1/trees/${NS}`, key, { data: {}, baseVersion: 0 })).status, 400);
      assert.equal((await call('PUT', `/v1/trees/${NS}`, key, '{bad')).status, 400);
    });

    test('create, read, update with versions', async () => {
      const key = newKey();
      assert.equal((await call('GET', `/v1/trees/${NS}`, key)).status, 404);

      let res = await call('PUT', `/v1/trees/${NS}`, key, { data: { n: 1 }, baseVersion: null });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).version, 1);

      res = await call('PUT', `/v1/trees/${NS}`, key, { data: { n: 2 }, baseVersion: 1 });
      assert.equal((await res.json()).version, 2);

      res = await call('GET', `/v1/trees/${NS}`, key);
      const row = await res.json();
      assert.deepEqual(row.data, { n: 2 });
      assert.equal(row.version, 2);
      assert.ok(row.updatedAt);
    });

    test('stale writes conflict and return the current tree', async () => {
      const key = newKey();
      await call('PUT', `/v1/trees/${NS}`, key, { data: { n: 1 } });
      await call('PUT', `/v1/trees/${NS}`, key, { data: { n: 2 }, baseVersion: 1 });

      let res = await call('PUT', `/v1/trees/${NS}`, key, { data: { n: 'stale' }, baseVersion: 1 });
      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.version, 2);
      assert.deepEqual(body.data, { n: 2 });

      // Creating over an existing tree is also a conflict.
      res = await call('PUT', `/v1/trees/${NS}`, key, { data: { n: 'new' }, baseVersion: null });
      assert.equal(res.status, 409);
    });

    test('keys are isolated from each other', async () => {
      const a = newKey();
      const b = newKey();
      await call('PUT', `/v1/trees/${NS}`, a, { data: { owner: 'a' } });
      assert.equal((await call('GET', `/v1/trees/${NS}`, b)).status, 404);
    });

    test('caps trees per key and body size', async () => {
      const key = newKey();
      assert.equal((await call('PUT', `/v1/trees/${NS}`, key, { data: {} })).status, 200);
      assert.equal((await call('PUT', `/v1/trees/${NS2}`, key, { data: {} })).status, 200);
      assert.equal((await call('PUT', `/v1/trees/${'c'.repeat(64)}`, key, { data: {} })).status, 403);
      assert.equal((await call('PUT', `/v1/trees/${NS}`, key, { data: { big: 'x'.repeat(5000) }, baseVersion: 1 })).status, 413);
    });

    test('delete removes every tree for the key only', async () => {
      const a = newKey();
      const b = newKey();
      await call('PUT', `/v1/trees/${NS}`, a, { data: {} });
      await call('PUT', `/v1/trees/${NS2}`, a, { data: {} });
      await call('PUT', `/v1/trees/${NS}`, b, { data: {} });
      assert.equal((await call('DELETE', '/v1/trees', a)).status, 204);
      assert.equal((await call('GET', `/v1/trees/${NS}`, a)).status, 404);
      assert.equal((await call('GET', `/v1/trees/${NS2}`, a)).status, 404);
      assert.equal((await call('GET', `/v1/trees/${NS}`, b)).status, 200);
    });
  });
}

test('CORS: preflight allowed for extension origins only', async () => {
  const server = createApp({ store: createMemoryStore() }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/v1/trees/${NS}`;
  const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const pre = await fetch(url, { method: 'OPTIONS', headers: { origin: ext, 'access-control-request-method': 'PUT' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ext);
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  const page = await fetch(url, { headers: { origin: 'https://chatgpt.com', authorization: `Bearer ${newKey()}` } });
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  await new Promise((r) => server.close(r));
});

test('rate limit per IP', async () => {
  const store = createMemoryStore();
  const server = createApp({ store, limits: { bodyBytes: 4096, treesPerOwner: 2, requestsPerMinute: 3 } }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/v1/trees/${NS}`;
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await fetch(url, { headers: { authorization: `Bearer ${newKey()}` } })).status);
  await new Promise((r) => server.close(r));
  assert.deepEqual(statuses, [404, 404, 404, 429]);
});
