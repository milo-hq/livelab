import { buildApp } from './server.js';

const app = await buildApp();
await app.listen({ port: app.ctx.cfg.port, host: '0.0.0.0' });
