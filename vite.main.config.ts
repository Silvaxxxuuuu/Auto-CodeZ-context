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
    clearScreen: false,
    build: {
      outDir: '.vite/build',
      emptyOutDir: false,
      watch: env.command === 'serve' ? {} : null,
      minify: env.command === 'build',
      lib: {
        entry: forgeEnv.forgeConfigSelf.entry,
        fileName: () => 'main.js',
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
