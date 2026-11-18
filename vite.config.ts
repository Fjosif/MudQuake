import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { dedupe: ['three', '@dimforge/rapier3d-compat'] },
  server: {
    port: 5173,
  },
  build: {
    target: 'esnext',
  },
});
