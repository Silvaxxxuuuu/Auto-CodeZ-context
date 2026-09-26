import { defineConfig } from 'vite';

const descopeProjectId = process.env.AUTO_CODEZ_DESCOPE_PROJECT_ID?.trim() || '';

export default defineConfig({
  define: {
    __AUTO_CODEZ_DESCOPE_PROJECT_ID__: JSON.stringify(descopeProjectId),
  },
  build: {
    rollupOptions: {
      external: ['node-pty'],
    },
  },
});
