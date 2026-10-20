import { createApp } from './app.js';
import { createPostgresStore } from './stores/postgres.js';
import { createMemoryStore } from './stores/memory.js';

// Cloudtype routes to port 8000 and does not always pass PORT through.
const port = Number(process.env.PORT) || 8000;
const trustProxy = Number(process.env.TRUST_PROXY ?? 1);
// Extra origins besides chrome-extension://* (comma separated), e.g. a web dashboard later.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

let store;
if (process.env.DATABASE_URL) {
  store = await createPostgresStore(process.env.DATABASE_URL);
} else if (process.env.NODE_ENV !== 'production') {
  console.warn('DATABASE_URL is not set: using an in-memory store (data is lost on restart).');
  store = createMemoryStore();
} else {
  console.error('DATABASE_URL is required in production.');
  process.exit(1);
}

const server = createApp({ store, trustProxy, allowedOrigins }).listen(port, () => {
  console.log(`treechat-be listening on :${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
  });
}
