import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

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

// GitHub Pages serves the demo from /planet-forge/; set BASE=/ for other hosts.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? (process.env.BASE ?? '/planet-forge/') : '/',
  define: { __GEN_HASH__: JSON.stringify(command === 'build' ? genHash() : 'dev') },
  assetsInclude: ['**/*.glsl'],
  worker: { format: 'es' },
  server: { port: 5188 },
}));
