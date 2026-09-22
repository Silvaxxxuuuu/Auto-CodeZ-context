import { defineConfig } from 'vite';

const accountApiDefaultUrl = process.env.AUTO_CODEZ_ACCOUNT_API_DEFAULT_URL?.trim() || '';
const descopeProjectId = process.env.AUTO_CODEZ_DESCOPE_PROJECT_ID?.trim() || '';

export default defineConfig({
  define: {
    __AUTO_CODEZ_ACCOUNT_API_DEFAULT_URL__: JSON.stringify(accountApiDefaultUrl),
    __AUTO_CODEZ_DESCOPE_PROJECT_ID__: JSON.stringify(descopeProjectId),
  },
  build: {
    rollupOptions: {
      external: ['node-pty'],
    },
  },
});
