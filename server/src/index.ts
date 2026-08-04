import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = createPool(config);
const app = await buildApp(config, db);

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => db.end()).then(() => process.exit(0));
  });
}
