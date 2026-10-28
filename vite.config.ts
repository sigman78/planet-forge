import { defineConfig } from 'vite';

export default defineConfig({
  assetsInclude: ['**/*.glsl'],
  worker: { format: 'es' },
  server: { port: 5173 },
});
