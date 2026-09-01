import { defineConfig, type Plugin } from 'vite';

const autoCodezUiModules: Plugin = {
  name: 'auto-codez-ui-modules',
  transformIndexHtml() {
    return {
      tags: [
        { tag: 'link', attrs: { rel: 'stylesheet', href: '/src/ui-overrides.css' }, injectTo: 'head' },
        { tag: 'script', attrs: { type: 'module', src: '/src/terminal-ui.ts' }, injectTo: 'body' },
        { tag: 'script', attrs: { type: 'module', src: '/src/api-key-ui.ts' }, injectTo: 'body' },
        { tag: 'script', attrs: { type: 'module', src: '/src/chat-rename-ui.ts' }, injectTo: 'body' },
      ],
    };
  },
};

export default defineConfig({
  plugins: [autoCodezUiModules],
  optimizeDeps: {
    exclude: ['monaco-editor'],
  },
});
