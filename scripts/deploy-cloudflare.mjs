// Build and deploy the demo to Cloudflare (planet-forge.ioupg.com) with the `cf` CLI.
// Sets DEPLOY_TARGET so vite.config.ts serves from the domain root and loads the Cloudflare plugin.
// Extra arguments are passed to `cf deploy` (e.g. --dry-run).
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['cf', 'deploy', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DEPLOY_TARGET: 'cloudflare' },
});
process.exit(r.status ?? 1);
