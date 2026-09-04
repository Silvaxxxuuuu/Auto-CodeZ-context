import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const rendererEntryTag = '<script type="module" src="/src/renderer-entry.ts"></script>';
const monacoEditorWorker = fileURLToPath(new URL('./node_modules/monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url));
const monacoEditorStyles = fileURLToPath(new URL('./node_modules/monaco-editor/esm/vs/editor/editor.main.css', import.meta.url));

const devLoader = `<script>
  (() => {
    const app = document.getElementById('app');
    let settled = false;

    const showFatal = (message) => {
      if (!app) return;
      app.innerHTML = '<pre style="box-sizing:border-box;margin:0;min-height:100vh;padding:24px;background:#0b0d11;color:#ffb4b4;font:13px/1.55 Consolas,monospace;white-space:pre-wrap;overflow:auto">' + message + '</pre>';
    };

    import('/src/renderer-entry.ts').then(() => {
      settled = true;
    }).catch((error) => {
      settled = true;
      const detail = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
      showFatal('Falha ao carregar o renderer do Auto CodeZ.\\n\\n' + detail);
      console.error('Falha ao carregar /src/renderer-entry.ts.', error);
    });

    window.setTimeout(() => {
      if (settled) return;
      if (document.querySelector('.app-shell')) return;
      showFatal('O renderer do Auto CodeZ não concluiu a inicialização em 5 segundos.');
    }, 5000);
  })();
</script>`;

export default defineConfig(({ command }) => ({
  resolve: {
    alias: [
      { find: 'monaco-editor/esm/vs/editor/editor.worker.js?worker', replacement: `${monacoEditorWorker}?worker` },
      { find: 'monaco-editor/esm/vs/editor/editor.worker.js', replacement: monacoEditorWorker },
      { find: 'monaco-editor/esm/vs/editor/editor.main.css', replacement: monacoEditorStyles },
    ],
  },
  optimizeDeps: {
    exclude: ['monaco-editor'],
  },
  plugins: command === 'serve'
    ? [
        {
          name: 'auto-codez-dev-renderer-loader',
          transformIndexHtml(html) {
            if (!html.includes(rendererEntryTag)) throw new Error('Entry point do renderer não encontrado no index.html.');
            return html.replace(rendererEntryTag, devLoader);
          },
        },
      ]
    : [],
}));
