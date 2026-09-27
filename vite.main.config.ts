import type { ConfigEnv } from 'vite';
import { defineConfig } from 'vite';

const descopeProjectId = process.env.AUTO_CODEZ_DESCOPE_PROJECT_ID?.trim() || '';

type ForgeConfigEnv = ConfigEnv & {
  forgeConfigSelf: {
    entry: string;
  };
};

export default defineConfig((env) => {
  const forgeEnv = env as ForgeConfigEnv;
  return {
    define: {
      __AUTO_CODEZ_DESCOPE_PROJECT_ID__: JSON.stringify(descopeProjectId),
    },
    build: {
      lib: {
        entry: forgeEnv.forgeConfigSelf.entry,
        fileName: () => '[name].js',
        formats: ['cjs'],
      },
      rollupOptions: {
        external: ['node-pty'],
        output: {
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
      },
    },
  };
});
