import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { startServer } from './app.js';
export { createApp, startServer } from './app.js';
export type { AppOptions, StartOptions } from './app.js';

// Importing this module from Electron does not start a second listener.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const candidate = fileURLToPath(new URL('../dist', import.meta.url));
  startServer({ staticDir: existsSync(candidate) ? candidate : undefined, allowedOrigins: process.env.OPEN_GENJUTSU_DEV_ORIGIN ? [process.env.OPEN_GENJUTSU_DEV_ORIGIN] : [] }).then(instance => {
    console.log(`Open Genjutsu local API: http://127.0.0.1:${instance.port}`);
    for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => { instance.close().finally(() => process.exit(0)); });
  }).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
