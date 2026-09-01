import { defineConfig, type IndexHtmlTransformContext } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['monaco-editor'],
  },
  plugins: [
    {
      name: 'auto-codez-ui-modules',
      transformIndexHtml(html: string, _context: IndexHtmlTransformContext) {
        return {
          html,
          tags: [
            { tag: 'script', attrs: { type: 'module', src: '/src/terminal-ui.ts' }, injectTo: 'body' },
            { tag: 'script', attrs: { type: 'module', src: '/src/api-key-ui.ts' }, injectTo: 'body' },
            { tag: 'script', attrs: { type: 'module', src: '/src/ui-polish.ts' }, injectTo: 'body' },
            { tag: 'script', attrs: { type: 'module', src: '/src/error-recovery-ui.ts' }, injectTo: 'body' },
            { tag: 'script', attrs: { type: 'module', src: '/src/api-key-flow-polish.ts' }, injectTo: 'body' },
          ],
        };
      },
    },
  ],
});
