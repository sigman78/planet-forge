import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { cloudflare } from '@cloudflare/vite-plugin';

// Hash of the generator sources: part of the planet cache key, so cached planets from an older
// generator are never reused.
function genHash(): string {
  const h = createHash('sha1');
  const dirs = ['src/gen', 'src/core'];
  for (const dir of dirs) {
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.ts') && !f.endsWith('.test.ts')) h.update(f).update(readFileSync(`${dir}/${f}`));
    }
  }
  return h.digest('hex').slice(0, 12);
}

// Two deploy targets:
//  - GitHub Pages (default build): served from /planet-forge/.
//  - Cloudflare (DEPLOY_TARGET=cloudflare, see scripts/deploy-cloudflare.mjs): served from the domain root,
//    built through the Cloudflare Vite plugin (assets-only Worker).
const CLOUDFLARE = process.env.DEPLOY_TARGET === 'cloudflare';

export default defineConfig(({ command, isPreview }) => ({
  base: CLOUDFLARE ? '/' : command === 'build' || isPreview ? '/planet-forge/' : '/',
  plugins: CLOUDFLARE ? [cloudflare()] : [],
  define: { __GEN_HASH__: JSON.stringify(command === 'build' ? genHash() : 'dev') },
  assetsInclude: ['**/*.glsl'],
  worker: { format: 'es' },
  server: { port: 5188 },
}));