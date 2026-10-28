import { defineConfig } from 'vite';

// GitHub Pages serves the demo from /planet-forge/; set BASE=/ for other hosts.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? (process.env.BASE ?? '/planet-forge/') : '/',
  assetsInclude: ['**/*.glsl'],
  worker: { format: 'es' },
  server: { port: 5188 },
}));
