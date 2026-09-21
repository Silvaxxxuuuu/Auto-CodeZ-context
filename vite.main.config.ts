import { defineConfig } from 'vite';

const accountApiDefaultUrl = process.env.AUTO_CODEZ_ACCOUNT_API_DEFAULT_URL?.trim() || '';

export default defineConfig({
  define: {
    __AUTO_CODEZ_ACCOUNT_API_DEFAULT_URL__: JSON.stringify(accountApiDefaultUrl),
  },
  build: {
    rollupOptions: {
      external: ['node-pty'],
    },
  },
});
