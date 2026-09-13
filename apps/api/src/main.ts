// Node ≥21.7 can load .env natively; no dotenv dependency needed. Missing file is fine (Docker/CI use real env vars).
try {
  process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
} catch {
  /* no .env */
}

import { buildApp } from './server.js';

const app = await buildApp();
await app.listen({ port: app.ctx.cfg.port, host: '0.0.0.0' });
