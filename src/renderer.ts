import './index.css';
import * as monaco from 'monaco-editor';

import type {
  AiProviderId,
} from './core/ai-session';

type ProjectFile = {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
};

type OpenFolderResult = {
  path: string;
  files: ProjectFile[];
} | null;

type ReadFileResult = {
  success: boolean;
  content?: string;
  error?: string;
};

type WriteFileResult = {
  success: boolean;
  error?: string;
};

type ExternalAiResult = {
  success: boolean;
  error?: string;
};

type ClipboardResult = {
  success: boolean;
  content?: string;
  error?: string;
};

type AiControl = {
  type?: string;
  name?: string;
  role?: string;
  value?: string;
  enabled?: boolean;
  controlType?: string;
  className?: string;
  framework?: string;
  processId?: number;
  offscreen?: boolean;
};

type AiWindow = {
  title: string;
  processId?: number;
  className?: string;
  framework?: string;
  controls: AiControl[];
};

type InspectExternalAiResult = {
  success: boolean;
  running: boolean;
  provider?: string;
  windows?: AiWindow[];
  error?: string;
};

type OpenTab = {
  path: string;
  name: string;
  relativePath: string;
  content: string;
  originalContent: string;
  modified: boolean;
  model: monaco.editor.ITextModel;
};

type PendingProposal = {
  tabPath: string;
  originalContent: string;
  proposedContent: string;
  originalModel: monaco.editor.ITextModel;
  proposedModel: monaco.editor.ITextModel;
};

type AiProvider = {
  id: AiProviderId;
  name: string;
};

type AiSessionResult = {
  sessionId: string;
  provider: AiProviderId;
  response: {
    provider: AiProviderId;
    content: string;
    receivedAt: number;
  };
  parsed: {
    raw: string;
    explanation: string;
    files: Array<{
      path: string;
      content: string;
    }>;
  };
};

type AiSessionError = {
  sessionId: string;
  error: string;
};

declare global {
  interface Window {
    autoCodez: {
      createAiSession: (
        request: {
          provider:
            | 'chatgpt'
            | 'claude'
            | 'gemini';
          request: string;
          projectRoot: string;
          activeFile: {
            path: string;
            relativePath: string;
            name: string;
            content: string;
          };
          files: {
            path: string;
            relativePath: string;
            name: string;
            content: string;
          }[];
        },
      ) => Promise<{
        success: boolean;
        sessionId?: string;
        state?:
          | 'idle'
          | 'preparing'
          | 'sending'
          | 'waiting'
          | 'receiving'
          | 'analyzing'
          | 'proposing'
          | 'awaitingApproval'
          | 'applying'
          | 'completed'
          | 'failed'
          | 'cancelled';
        error?: string;
      }>;

      cancelAiSession: (
        sessionId: string,
      ) => Promise<{
        success: boolean;
        error?: string;
      }>;

      onAiSessionState: (
        callback: (
          state: {
            sessionId: string;
            state:
              | 'idle'
              | 'preparing'
              | 'sending'
              | 'waiting'
              | 'receiving'
              | 'analyzing'
              | 'proposing'
              | 'awaitingApproval'
              | 'applying'
              | 'completed'
              | 'failed'
              | 'cancelled';
          },
        ) => void,
      ) => () => void;

      onAiSessionResult: (
        callback: (
          result: AiSessionResult,
        ) => void,
      ) => () => void;

      onAiSessionError: (
        callback: (
          error: AiSessionError,
        ) => void,
      ) => () => void;

      sendAiRequest: (
        request: {
          provider:
            | 'chatgpt'
            | 'claude'
            | 'gemini';
          prompt: string;
          timeoutMs?: number;
        },
      ) => Promise<{
        success: boolean;
        response?: {
          provider:
            | 'chatgpt'
            | 'claude'
            | 'gemini';
          content: string;
          receivedAt: number;
        };
        error?: string;
      }>;
      inspectExternalAi: (
        provider: string,
      ) => Promise<InspectExternalAiResult>;

      openFolder: () => Promise<OpenFolderResult>;

      readFile: (
        filePath: string,
      ) => Promise<ReadFileResult>;

      writeFile: (
        filePath: string,
        content: string,
      ) => Promise<WriteFileResult>;

      openExternalAi: (
        provider: string,
      ) => Promise<ExternalAiResult>;

      writeClipboard: (
        text: string,
      ) => Promise<ClipboardResult>;

      readClipboard: () => Promise<ClipboardResult>;

      buildProjectContext: (
        input: {
          projectRoot: string;
          request: string;
          activeFile: string | null;
          files: Array<{
            path: string;
            relativePath: string;
            name: string;
            content: string;
          }>;
        },
      ) => Promise<{
        success: boolean;
        context?: {
          projectRoot: string;
          request: string;
          activeFile: string | null;
          files: Array<{
            path: string;
            relativePath: string;
            name: string;
            extension: string;
            content: string;
            size: number;
            score: number;
            selected: boolean;
          }>;
          totalFiles: number;
          selectedFiles: number;
          totalCharacters: number;
        };
        serialized?: string;
        error?: string;
      }>;
    };
  }
}

const aiProviders: AiProvider[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
  },
  {
    id: 'claude',
    name: 'Claude',
  },
  {
    id: 'gemini',
    name: 'Gemini',
  },
];

const app =
  document.querySelector<HTMLDivElement>(
    '#app',
  );

if (!app) {
  throw new Error(
    'Elemento #app não encontrado.',
  );
}

const storedProvider =
  window.localStorage.getItem(
    'auto-codez-ai-provider',
  ) as AiProviderId | null;

let selectedAiProvider: AiProviderId | null =
  aiProviders.some(
    (provider) =>
      provider.id === storedProvider,
  )
    ? storedProvider
    : null;

app.innerHTML = `
  <div class="app">
    <header class="topbar">
      <div class="topbar-left">
        <button
          id="file-menu"
          class="file-menu"
          type="button"
        >
          File
        </button>

        <div
          class="future-brand-mark"
          aria-hidden="true"
        ></div>
      </div>

      <div class="topbar-center">
        <span id="project-name">
          Nenhum projeto aberto
        </span>
      </div>

      <div class="topbar-actions">
        <button
          id="save-button"
          class="save-button"
          type="button"
          disabled
        >
          Salvar
        </button>

        <button
          class="icon-button"
          type="button"
          title="Configurações"
        >
          Configurações
        </button>
      </div>
    </header>

    <main class="workspace">
      <aside class="sidebar">
        <div class="sidebar-section project-section">
          <div class="section-title">
            PROJETO
          </div>

          <button
            id="open-folder"
            class="open-folder"
            type="button"
          >
            <span>Abrir pasta</span>
          </button>
        </div>

        <div class="sidebar-section files-section">
          <div class="section-title">
            ARQUIVOS
          </div>

          <div
            id="file-list"
            class="file-list"
          >
            <div class="empty-files">
              Abra uma pasta para começar.
            </div>
          </div>
        </div>
      </aside>

      <section class="content">
        <div
          id="tabs"
          class="tabs"
        ></div>

        <div class="editor-header">
          <span id="current-file">
            Nenhum arquivo selecionado
          </span>
        </div>

        <div
          id="proposal-bar"
          class="proposal-bar"
        >
          <div class="proposal-info">
            <span class="proposal-dot"></span>

            <span>
              Alteração proposta
            </span>
          </div>

          <div class="proposal-actions">
            <button
              id="reject-proposal"
              class="proposal-button reject"
              type="button"
            >
              Rejeitar
            </button>

            <button
              id="accept-proposal"
              class="proposal-button accept"
              type="button"
            >
              Aceitar
            </button>
          </div>
        </div>

        <div
          id="editor"
          class="editor"
        >
          <div class="editor-empty">
            <div class="editor-empty-icon">
              { }
            </div>

            <div>
              Selecione um arquivo
            </div>
          </div>
        </div>

        <div class="composer-area">
          <div class="composer">
            <div
              id="ai-selector"
              class="ai-selector"
            >
              <button
                id="ai-selector-button"
                class="ai-selector-button"
                type="button"
                aria-haspopup="menu"
                aria-expanded="false"
                title="Selecionar IA"
              >
                <span class="ai-label">
                  AI
                </span>

                <span class="ai-chevron">
                  <svg
                    viewBox="0 0 16 16"
                    width="12"
                    height="12"
                    aria-hidden="true"
                  >
                    <path
                      d="M4 6L8 10L12 6"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </span>
              </button>

              <div
                id="ai-menu"
                class="ai-menu"
                role="menu"
              >
                <div class="ai-menu-title">
                  Selecionar IA
                </div>

                <div
                  id="ai-options"
                  class="ai-options"
                ></div>
              </div>
            </div>

            <div class="composer-divider"></div>

            <textarea
              id="prompt"
              placeholder="Descreva o que você quer fazer..."
              rows="1"
            ></textarea>

            <button
              id="send"
              class="send-button"
              title="Enviar"
              type="button"
            >
              <svg
                viewBox="0 0 20 20"
                width="18"
                height="18"
                aria-hidden="true"
              >
                <path
                  d="M10 15V5M5.5 9.5L10 5L14.5 9.5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </div>

          <div class="composer-info">
            Auto CodeZ está trabalhando localmente neste projeto.
          </div>
        </div>
      </section>
    </main>

    <div
      id="status"
      class="status"
    ></div>
  </div>
`;

const openFolderButton =
  document.querySelector<HTMLButtonElement>(
    '#open-folder',
  );

const projectName =
  document.querySelector<HTMLSpanElement>(
    '#project-name',
  );

const fileList =
  document.querySelector<HTMLDivElement>(
    '#file-list',
  );

const editor =
  document.querySelector<HTMLDivElement>(
    '#editor',
  );

const currentFile =
  document.querySelector<HTMLSpanElement>(
    '#current-file',
  );

const tabs =
  document.querySelector<HTMLDivElement>(
    '#tabs',
  );

const prompt =
  document.querySelector<HTMLTextAreaElement>(
    '#prompt',
  );

const sendButton =
  document.querySelector<HTMLButtonElement>(
    '#send',
  );

const saveButton =
  document.querySelector<HTMLButtonElement>(
    '#save-button',
  );

const status =
  document.querySelector<HTMLDivElement>(
    '#status',
  );

const proposalBar =
  document.querySelector<HTMLDivElement>(
    '#proposal-bar',
  );

const acceptProposalButton =
  document.querySelector<HTMLButtonElement>(
    '#accept-proposal',
  );

const rejectProposalButton =
  document.querySelector<HTMLButtonElement>(
    '#reject-proposal',
  );

const aiSelector =
  document.querySelector<HTMLDivElement>(
    '#ai-selector',
  );

const aiSelectorButton =
  document.querySelector<HTMLButtonElement>(
    '#ai-selector-button',
  );

const aiMenu =
  document.querySelector<HTMLDivElement>(
    '#ai-menu',
  );

const aiOptions =
  document.querySelector<HTMLDivElement>(
    '#ai-options',
  );

let projectFiles: ProjectFile[] = [];
let projectRootPath: string | null = null;
let openTabs: OpenTab[] = [];
let activeTabPath: string | null = null;
let activeAiSessionId: string | null = null;

let editorInstance:
  | monaco.editor.IStandaloneCodeEditor
  | null = null;

let diffEditorInstance:
  | monaco.editor.IStandaloneDiffEditor
  | null = null;

let editorChangeDisposable:
  | monaco.IDisposable
  | null = null;

let pendingProposal:
  | PendingProposal
  | null = null;

let fileLoadSequence = 0;
let aiInspectionSequence = 0;

const expandedDirectories =
  new Set<string>();

monaco.editor.defineTheme(
  'auto-codez',
  {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0b0d11',
      'editor.foreground': '#c8ced7',
      'editorLineNumber.foreground': '#454c58',
      'editorLineNumber.activeForeground': '#8d95a3',
      'editorCursor.foreground': '#e7eaf0',
      'editor.selectionBackground': '#303744',
      'editor.inactiveSelectionBackground': '#242a33',
      'editor.lineHighlightBackground': '#10141a',
      'editorIndentGuide.background1': '#171b22',
      'editorIndentGuide.activeBackground1': '#242a33',
      'diffEditor.insertedTextBackground': '#263c2d',
      'diffEditor.removedTextBackground': '#432b2b',
      'diffEditor.insertedLineBackground': '#17251c',
      'diffEditor.removedLineBackground': '#2a1c1c',
    },
  },
);

monaco.editor.setTheme(
  'auto-codez',
);

window.autoCodez.onAiSessionState(
  ({
    sessionId,
    state,
  }) => {
    console.log(
      'AI_SESSION_STATE',
      sessionId,
      state,
    );

    if (
      sessionId === activeAiSessionId &&
      (
        state === 'completed' ||
        state === 'failed' ||
        state === 'cancelled'
      )
    ) {
      if (state !== 'completed') {
        activeAiSessionId = null;
      }
    }

    switch (state) {
      case 'preparing':
        showStatus(
          'Preparando solicitação...',
        );
        break;

      case 'sending':
        showStatus(
          'Enviando solicitação para a IA em segundo plano...',
        );
        break;

      case 'waiting':
        showStatus(
          'Aguardando resposta da IA...',
        );
        break;

      case 'receiving':
        showStatus(
          'Recebendo resposta da IA...',
        );
        break;

      case 'analyzing':
        showStatus(
          'Analisando resposta da IA...',
        );
        break;

      case 'proposing':
        showStatus(
          'Preparando alteração proposta...',
        );
        break;

      case 'awaitingApproval':
        showStatus(
          'Aguardando sua aprovação...',
        );
        break;

      case 'applying':
        showStatus(
          'Aplicando alteração...',
        );
        break;

      case 'completed':
        showStatus(
          'Resposta recebida.',
        );
        break;

      case 'failed':
        showStatus(
          'A sessão da IA falhou.',
          true,
        );
        activeAiSessionId = null;
        if (sendButton) {
          sendButton.disabled = false;
        }
        break;

      case 'cancelled':
        showStatus(
          'Solicitação cancelada.',
          true,
        );
        activeAiSessionId = null;
        if (sendButton) {
          sendButton.disabled = false;
        }
        break;
    }
  },
);

window.autoCodez.onAiSessionResult(
  (result) => {
    if (
      result.sessionId !==
      activeAiSessionId
    ) {
      return;
    }

    const changes =
      result.parsed.files;

    if (
      changes.length === 0
    ) {
      activeAiSessionId = null;
      if (sendButton) {
        sendButton.disabled = false;
      }

      showStatus(
        result.parsed.explanation ||
          'A IA respondeu, mas nenhuma alteração de arquivo foi identificada.',
        true,
      );

      console.log(
        'AI_SESSION_RESPONSE',
        result.response.content,
      );

      return;
    }

    if (
      changes.length > 1
    ) {
      activeAiSessionId = null;
      if (sendButton) {
        sendButton.disabled = false;
      }

      showStatus(
        `A IA retornou alterações para ${changes.length} arquivos. A revisão de múltiplos arquivos ainda não está habilitada. Nenhuma alteração foi aplicada.`,
        true,
      );

      console.log(
        'AI_SESSION_RESPONSE',
        result.response.content,
      );

      return;
    }

    const change =
      changes[0];

    const normalizedResponsePath =
      change.path
        .replaceAll('\\', '/')
        .replace(/^\.\//, '')
        .toLowerCase();

    const activeTab =
      activeTabPath
        ? openTabs.find(
            (tab) =>
              tab.path ===
              activeTabPath,
          )
        : null;

    const activeMatches =
      activeTab &&
      (
        activeTab.relativePath
          .replaceAll('\\', '/')
          .toLowerCase() ===
          normalizedResponsePath ||
        activeTab.path
          .replaceAll('\\', '/')
          .toLowerCase() ===
          normalizedResponsePath
      );

    if (activeMatches) {
      activeAiSessionId = null;
      createProposal(
        change.content,
      );
      showStatus(
        'A IA retornou uma alteração. Revise a proposta.',
      );
      return;
    }

    const targetFile =
      projectFiles.find(
        (file) =>
          file.type === 'file' &&
          (
            file.relativePath
              .replaceAll('\\', '/')
              .toLowerCase() ===
              normalizedResponsePath ||
            file.path
              .replaceAll('\\', '/')
              .toLowerCase() ===
              normalizedResponsePath
          ),
      );

    if (!targetFile) {
      activeAiSessionId = null;
      if (sendButton) {
        sendButton.disabled = false;
      }

      showStatus(
        `A IA respondeu com uma alteração para "${change.path}", mas esse arquivo não pertence ao projeto aberto.`,
        true,
      );
      return;
    }

    void (async () => {
      await openFile(targetFile);

      const tab =
        openTabs.find(
          (item) =>
            item.path ===
            targetFile.path,
        );

      if (!tab) {
        activeAiSessionId = null;
        if (sendButton) {
          sendButton.disabled = false;
        }

        showStatus(
          'Não foi possível abrir o arquivo retornado pela IA.',
          true,
        );
        return;
      }

      activeAiSessionId = null;
      createProposal(
        change.content,
      );
      showStatus(
        'A IA retornou uma alteração. Revise a proposta.',
      );
    })();
  },
);

window.autoCodez.onAiSessionError(
  ({
    sessionId,
    error,
  }) => {
    if (
      sessionId !==
      activeAiSessionId
    ) {
      return;
    }

    activeAiSessionId = null;

    if (sendButton) {
      sendButton.disabled = false;
    }

    showStatus(
      error,
      true,
    );
  },
);

function getAiProvider(
  providerId: AiProviderId | null,
): AiProvider | null {
  if (!providerId) {
    return null;
  }

  return (
    aiProviders.find(
      (provider) =>
        provider.id === providerId,
    ) || null
  );
}

function getProviderName(
  providerId: AiProviderId | null,
): string {
  return (
    getAiProvider(providerId)?.name ||
    'IA'
  );
}

function getAiIcon(
  providerId: AiProviderId,
): string {
  switch (providerId) {
    case 'chatgpt':
      return `
        <span class="ai-provider-icon chatgpt-icon">
          ◎
        </span>
      `;

    case 'claude':
      return `
        <span class="ai-provider-icon claude-icon">
          C
        </span>
      `;

    case 'gemini':
      return `
        <span class="ai-provider-icon gemini-icon">
          ✦
        </span>
      `;
  }
}

function renderAiOptions() {
  if (!aiOptions) {
    return;
  }

  aiOptions.innerHTML = '';

  for (const provider of aiProviders) {
    const option =
      document.createElement(
        'button',
      );

    option.type = 'button';
    option.className = 'ai-option';

    option.setAttribute(
      'role',
      'menuitemradio',
    );

    option.setAttribute(
      'aria-checked',
      String(
        provider.id ===
          selectedAiProvider,
      ),
    );

    if (
      provider.id ===
      selectedAiProvider
    ) {
      option.classList.add(
        'selected',
      );
    }

    option.innerHTML = `
      ${getAiIcon(provider.id)}

      <span class="ai-option-name">
        ${provider.name}
      </span>

      <span class="ai-option-check">
        ${
          provider.id ===
          selectedAiProvider
            ? '✓'
            : ''
        }
      </span>
    `;

    option.addEventListener(
      'click',
      () => {
        selectedAiProvider =
          provider.id;

        window.localStorage.setItem(
          'auto-codez-ai-provider',
          provider.id,
        );

        renderAiOptions();
        closeAiMenu();

        showStatus(
          `${provider.name} selecionado.`,
        );
      },
    );

    aiOptions.appendChild(
      option,
    );
  }
}

function openAiMenu() {
  renderAiOptions();

  aiMenu?.classList.add(
    'visible',
  );

  aiSelectorButton?.setAttribute(
    'aria-expanded',
    'true',
  );
}

function closeAiMenu() {
  aiMenu?.classList.remove(
    'visible',
  );

  aiSelectorButton?.setAttribute(
    'aria-expanded',
    'false',
  );
}

function toggleAiMenu() {
  if (
    aiMenu?.classList.contains(
      'visible',
    )
  ) {
    closeAiMenu();
    return;
  }

  openAiMenu();
}

aiSelectorButton?.addEventListener(
  'click',
  (event) => {
    event.stopPropagation();
    toggleAiMenu();
  },
);

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId:
    | number
    | undefined;

  const timeoutPromise =
    new Promise<T>(
      (_, reject) => {
        timeoutId =
          window.setTimeout(
            () => {
              reject(
                new Error(
                  message,
                ),
              );
            },
            timeoutMs,
          );
      },
    );

  try {
    return await Promise.race([
      promise,
      timeoutPromise,
    ]);
  } finally {
    if (
      timeoutId !==
      undefined
    ) {
      window.clearTimeout(
        timeoutId,
      );
    }
  }
}

async function inspectSelectedAi() {
  if (!selectedAiProvider) {
    showStatus(
      'Selecione uma IA primeiro.',
      true,
    );

    openAiMenu();

    return;
  }

  const provider =
    getAiProvider(
      selectedAiProvider,
    );

  if (!provider) {
    return;
  }

  const inspectionId =
    ++aiInspectionSequence;

  showStatus(
    `Verificando ${provider.name}...`,
  );

  try {
    const result =
      await withTimeout(
        window.autoCodez.inspectExternalAi(
          provider.id,
        ),
        7000,
        `A verificação de ${provider.name} demorou demais.`,
      );

    if (
      inspectionId !==
      aiInspectionSequence
    ) {
      return;
    }

    if (!result.success) {
      showStatus(
        result.error ||
          `Não foi possível verificar ${provider.name}.`,
        true,
      );

      console.error(
        'AI_AUTOMATION_ERROR',
        result,
      );

      return;
    }

    console.log(
      'AI_AUTOMATION_DIAGNOSTIC',
      result,
    );

    if (!result.running) {
      showStatus(
        `${provider.name} não foi encontrada.`,
        true,
      );

      return;
    }

    const windows =
      result.windows || [];

    const controls =
      windows.reduce(
        (
          total,
          windowInfo,
        ) =>
          total +
          (
            windowInfo.controls
              ?.length || 0
          ),
        0,
      );

    showStatus(
      `${provider.name} encontrada. ${windows.length} janela(s), ${controls} controle(s).`,
    );
  } catch (error) {
    if (
      inspectionId !==
      aiInspectionSequence
    ) {
      return;
    }

    const message =
      error instanceof Error
        ? error.message
        : `Não foi possível verificar ${provider.name}.`;

    showStatus(
      message,
      true,
    );

    console.error(
      'AI_AUTOMATION_EXCEPTION',
      error,
    );
  }
}

window.addEventListener(
  'keydown',
  (event) => {
    if (
      event.ctrlKey &&
      event.shiftKey &&
      event.key.toLowerCase() ===
        'i'
    ) {
      event.preventDefault();
      void inspectSelectedAi();
    }
  },
);

document.addEventListener(
  'click',
  (event) => {
    if (
      !aiSelector ||
      !(event.target instanceof Node)
    ) {
      return;
    }

    if (
      !aiSelector.contains(
        event.target,
      )
    ) {
      closeAiMenu();
    }
  },
);

renderAiOptions();
hideProposal();

openFolderButton?.addEventListener(
  'click',
  async () => {
    if (pendingProposal) {
      const discard =
        window.confirm(
          'Existe uma alteração proposta pendente. Deseja descartá-la e abrir outro projeto?',
        );

      if (!discard) {
        return;
      }

      rejectProposal();
    }

    try {
      const result =
        await withTimeout(
          window.autoCodez.openFolder(),
          30000,
          'A abertura da pasta demorou demais.',
        );

      if (!result) {
        return;
      }

      disposeAllModels();

      projectRootPath =
        result.path;

      projectFiles =
        result.files;

      openTabs = [];
      activeTabPath = null;

      expandedDirectories.clear();

      const parts =
        result.path.split(
          /[\\/]/
        );

      const name =
        parts[
          parts.length - 1
        ] ||
        result.path;

      if (projectName) {
        projectName.textContent =
          name;
      }

      renderFileTree();
      renderTabs();
      renderEmptyEditor();
      updateSaveButton();
    } catch (error) {
      showStatus(
        error instanceof Error
          ? error.message
          : 'Não foi possível abrir a pasta.',
        true,
      );
    }
  },
);

async function openFile(
  file: ProjectFile,
) {
  if (
    file.type !==
    'file'
  ) {
    return;
  }

  if (pendingProposal) {
    if (
      pendingProposal.tabPath ===
      file.path
    ) {
      return;
    }

    const discard =
      window.confirm(
        'Existe uma alteração proposta pendente. Deseja descartá-la?',
      );

    if (!discard) {
      return;
    }

    rejectProposal();
  }

  const existingTab =
    openTabs.find(
      (tab) =>
        tab.path ===
        file.path,
    );

  if (existingTab) {
    activeTabPath =
      existingTab.path;

    activateTab(
      existingTab,
    );

    return;
  }

  if (!editor) {
    return;
  }

  const requestId =
    ++fileLoadSequence;

  if (editorInstance) {
    editorInstance.setModel(
      null,
    );

    editorInstance.dispose();
    editorInstance = null;
  }

  editorChangeDisposable?.dispose();
  editorChangeDisposable = null;

  editor.innerHTML = `
    <div class="loading-file">
      Carregando arquivo...
    </div>
  `;

  if (currentFile) {
    currentFile.textContent =
      `Carregando ${file.relativePath}...`;
  }

  try {
    const result =
      await withTimeout(
        window.autoCodez.readFile(
          file.path,
        ),
        15000,
        'A leitura do arquivo demorou demais.',
      );

    if (
      requestId !==
      fileLoadSequence
    ) {
      return;
    }

    if (!result.success) {
      editor.innerHTML = `
        <div class="loading-file error">
          ${escapeHtml(
            result.error ||
              'Erro ao abrir arquivo.',
          )}
        </div>
      `;

      if (currentFile) {
        currentFile.textContent =
          file.relativePath;
      }

      return;
    }

    const content =
      result.content || '';

    const language =
      getMonacoLanguage(
        file.name,
      );

    const existingModel =
      monaco.editor.getModel(
        monaco.Uri.file(
          file.path,
        ),
      );

    existingModel?.dispose();

    const model =
      monaco.editor.createModel(
        content,
        language,
        monaco.Uri.file(
          file.path,
        ),
      );

    const tab: OpenTab = {
      path: file.path,
      name: file.name,
      relativePath:
        file.relativePath,
      content,
      originalContent:
        content,
      modified: false,
      model,
    };

    openTabs.push(tab);
    activeTabPath =
      tab.path;

    activateTab(tab);
  } catch (error) {
    if (
      requestId !==
      fileLoadSequence
    ) {
      return;
    }

    const message =
      error instanceof Error
        ? error.message
        : 'Erro desconhecido ao abrir arquivo.';

    editor.innerHTML = `
      <div class="loading-file error">
        ${escapeHtml(
          message,
        )}
      </div>
    `;

    if (currentFile) {
      currentFile.textContent =
        file.relativePath;
    }

    showStatus(
      message,
      true,
    );
  }
}

function createEditor(
  container: HTMLDivElement,
  model: monaco.editor.ITextModel,
) {
  const instance =
    monaco.editor.create(
      container,
      {
        model,
        automaticLayout: true,
        theme: 'auto-codez',
        fontFamily:
          '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
        fontSize: 13,
        lineHeight: 21,
        minimap: {
          enabled: true,
        },
        smoothScrolling: true,
        cursorSmoothCaretAnimation:
          'on',
        padding: {
          top: 8,
          bottom: 20,
        },
        scrollBeyondLastLine:
          false,
        renderWhitespace:
          'selection',
        wordWrap: 'off',
        tabSize: 2,
        scrollbar: {
          verticalScrollbarSize: 10,
          horizontalScrollbarSize: 10,
        },
        overviewRulerLanes: 3,
        folding: true,
        lineNumbers: 'on',
        glyphMargin: false,
        guides: {
          indentation: true,
        },
        fixedOverflowWidgets: true,
        renderLineHighlight:
          'line',
        selectOnLineNumbers: true,
      },
    );

  instance.layout();

  window.requestAnimationFrame(
    () => {
      instance.layout();
      instance.setScrollTop(
        0,
      );
      instance.setPosition({
        lineNumber: 1,
        column: 1,
      });
      instance.revealLine(
        1,
      );
    },
  );

  return instance;
}

function activateTab(
  tab: OpenTab,
) {
  if (pendingProposal) {
    if (
      pendingProposal.tabPath ===
      tab.path
    ) {
      return;
    }

    rejectProposal();
  }

  activeTabPath =
    tab.path;

  renderTabs();
  renderFileTree();
  updateSaveButton();

  if (!editor) {
    return;
  }

  if (!editorInstance) {
    editor.innerHTML = '';

    editorInstance =
      createEditor(
        editor,
        tab.model,
      );

    attachEditorChangeListener();
  } else {
    editorInstance.setModel(
      tab.model,
    );

    editorInstance.layout();

    window.requestAnimationFrame(
      () => {
        editorInstance?.layout();
        editorInstance?.setScrollTop(
          0,
        );
        editorInstance?.setPosition({
          lineNumber: 1,
          column: 1,
        });
        editorInstance?.revealLine(
          1,
        );
      },
    );
  }

  if (currentFile) {
    currentFile.textContent =
      tab.relativePath;
  }

  editorInstance.focus();
}

function attachEditorChangeListener() {
  if (!editorInstance) {
    return;
  }

  editorChangeDisposable?.dispose();

  editorChangeDisposable =
    editorInstance.onDidChangeModelContent(
      () => {
        if (
          !activeTabPath ||
          pendingProposal
        ) {
          return;
        }

        const tab =
          openTabs.find(
            (item) =>
              item.path ===
              activeTabPath,
          );

        if (!tab) {
          return;
        }

        tab.content =
          tab.model.getValue();

        tab.modified =
          tab.content !==
          tab.originalContent;

        renderTabs();
        renderFileTree();
        updateSaveButton();
      },
    );
}

function renderTabs() {
  if (!tabs) {
    return;
  }

  tabs.innerHTML = '';

  for (
    const tab of openTabs
  ) {
    const tabElement =
      document.createElement(
        'div',
      );

    tabElement.className =
      'tab';

    if (
      tab.path ===
      activeTabPath
    ) {
      tabElement.classList.add(
        'active',
      );
    }

    tabElement.innerHTML = `
      <button
        class="tab-main"
        type="button"
      >
        <span class="tab-icon ${getFileColorClass(
          tab.name,
        )}">
          ${getFileIcon(
            tab.name,
          )}
        </span>

        <span class="tab-name"></span>

        <span class="tab-modified"></span>
      </button>

      <button
        class="tab-close"
        title="Fechar"
        type="button"
      >
        ×
      </button>
    `;

    const tabName =
      tabElement.querySelector<HTMLSpanElement>(
        '.tab-name',
      );

    const modified =
      tabElement.querySelector<HTMLSpanElement>(
        '.tab-modified',
      );

    if (tabName) {
      tabName.textContent =
        tab.name;
    }

    if (
      modified &&
      tab.modified
    ) {
      modified.textContent =
        '●';
    }

    const tabMain =
      tabElement.querySelector<HTMLButtonElement>(
        '.tab-main',
      );

    const tabClose =
      tabElement.querySelector<HTMLButtonElement>(
        '.tab-close',
      );

    tabMain?.addEventListener(
      'click',
      () => {
        activateTab(tab);
      },
    );

    tabClose?.addEventListener(
      'click',
      (event) => {
        event.stopPropagation();
        closeTab(
          tab.path,
        );
      },
    );

    tabs.appendChild(
      tabElement,
    );
  }
}

function closeTab(
  filePath: string,
) {
  if (
    pendingProposal?.tabPath ===
    filePath
  ) {
    const discard =
      window.confirm(
        'Existe uma alteração proposta pendente. Deseja fechar o arquivo e descartá-la?',
      );

    if (!discard) {
      return;
    }

    rejectProposal();
  }

  const tab =
    openTabs.find(
      (item) =>
        item.path ===
        filePath,
    );

  if (!tab) {
    return;
  }

  if (tab.modified) {
    const discard =
      window.confirm(
        `O arquivo "${tab.name}" possui alterações não salvas. Deseja fechar mesmo assim?`,
      );

    if (!discard) {
      return;
    }
  }

  ++fileLoadSequence;

  const index =
    openTabs.findIndex(
      (item) =>
        item.path ===
        filePath,
    );

  if (index < 0) {
    return;
  }

  if (
    activeTabPath ===
    filePath
  ) {
    editorChangeDisposable?.dispose();
    editorChangeDisposable = null;

    editorInstance?.setModel(
      null,
    );
  }

  tab.model.dispose();

  openTabs.splice(
    index,
    1,
  );

  if (
    activeTabPath ===
    filePath
  ) {
    const nextTab =
      openTabs[index] ||
      openTabs[index - 1] ||
      null;

    activeTabPath =
      nextTab?.path ||
      null;

    if (nextTab) {
      activateTab(
        nextTab,
      );
    } else {
      renderEmptyEditor();
    }
  }

  renderTabs();
  renderFileTree();
  updateSaveButton();
}

async function saveActiveFile() {
  if (
    !activeTabPath ||
    pendingProposal
  ) {
    return;
  }

  const tab =
    openTabs.find(
      (item) =>
        item.path ===
        activeTabPath,
    );

  if (
    !tab ||
    !tab.modified
  ) {
    return;
  }

  tab.content =
    tab.model.getValue();

  try {
    const result =
      await withTimeout(
        window.autoCodez.writeFile(
          tab.path,
          tab.content,
        ),
        15000,
        'A gravação do arquivo demorou demais.',
      );

    if (!result.success) {
      showStatus(
        result.error ||
          'Erro ao salvar arquivo.',
        true,
      );

      return;
    }

    tab.originalContent =
      tab.content;

    tab.modified = false;

    renderTabs();
    renderFileTree();
    updateSaveButton();

    showStatus(
      'Arquivo salvo.',
    );
  } catch (error) {
    showStatus(
      error instanceof Error
        ? error.message
        : 'Erro ao salvar arquivo.',
      true,
    );
  }
}

saveButton?.addEventListener(
  'click',
  () => {
    void saveActiveFile();
  },
);

window.addEventListener(
  'keydown',
  (event) => {
    if (
      (event.ctrlKey ||
        event.metaKey) &&
      event.key.toLowerCase() ===
        's'
    ) {
      event.preventDefault();
      void saveActiveFile();
    }

    if (
      pendingProposal &&
      event.key === 'Escape'
    ) {
      event.preventDefault();
      rejectProposal();
    }
  },
);

function updateSaveButton() {
  if (!saveButton) {
    return;
  }

  const activeTab =
    openTabs.find(
      (tab) =>
        tab.path ===
        activeTabPath,
    );

  saveButton.disabled =
    !activeTab?.modified ||
    pendingProposal !== null;
}

function renderEmptyEditor() {
  ++fileLoadSequence;

  disposeDiffEditor();

  editorChangeDisposable?.dispose();
  editorChangeDisposable = null;

  if (editorInstance) {
    editorInstance.setModel(
      null,
    );

    editorInstance.dispose();
    editorInstance = null;
  }

  if (
    editor &&
    currentFile
  ) {
    currentFile.textContent =
      'Nenhum arquivo selecionado';

    editor.innerHTML = `
      <div class="editor-empty">
        <div class="editor-empty-icon">
          { }
        </div>

        <div>
          Selecione um arquivo
        </div>
      </div>
    `;
  }

  hideProposal();
}

function disposeAllModels() {
  ++fileLoadSequence;

  disposeDiffEditor();

  editorChangeDisposable?.dispose();
  editorChangeDisposable = null;

  if (editorInstance) {
    editorInstance.setModel(
      null,
    );

    editorInstance.dispose();
    editorInstance = null;
  }

  for (
    const tab of openTabs
  ) {
    tab.model.dispose();
  }

  pendingProposal = null;
  hideProposal();
}

function disposeDiffEditor() {
  if (diffEditorInstance) {
    diffEditorInstance.setModel(
      null,
    );

    diffEditorInstance.dispose();
    diffEditorInstance = null;
  }

  if (pendingProposal) {
    pendingProposal.originalModel.dispose();
    pendingProposal.proposedModel.dispose();
  }

  pendingProposal = null;
}

function showProposal() {
  proposalBar?.classList.add(
    'visible',
  );

  updateSaveButton();
}

function hideProposal() {
  proposalBar?.classList.remove(
    'visible',
  );

  updateSaveButton();
}

function createProposal(
  proposedContent: string,
) {
  if (pendingProposal) {
    showStatus(
      'Já existe uma alteração proposta. Aceite ou rejeite a proposta atual.',
      true,
    );

    return;
  }

  if (
    !activeTabPath ||
    !editor
  ) {
    showStatus(
      'Abra um arquivo antes de criar uma proposta.',
      true,
    );

    return;
  }

  const tab =
    openTabs.find(
      (item) =>
        item.path ===
        activeTabPath,
    );

  if (!tab) {
    return;
  }

  const originalContent =
    tab.model.getValue();

  if (
    originalContent ===
    proposedContent
  ) {
    showStatus(
      'A proposta não possui alterações.',
      true,
    );

    return;
  }

  const language =
    getMonacoLanguage(
      tab.name,
    );

  const originalModel =
    monaco.editor.createModel(
      originalContent,
      language,
    );

  const proposedModel =
    monaco.editor.createModel(
      proposedContent,
      language,
    );

  pendingProposal = {
    tabPath: tab.path,
    originalContent,
    proposedContent,
    originalModel,
    proposedModel,
  };

  editorChangeDisposable?.dispose();
  editorChangeDisposable = null;

  if (editorInstance) {
    editorInstance.setModel(
      null,
    );

    editorInstance.dispose();
    editorInstance = null;
  }

  editor.innerHTML = '';

  diffEditorInstance =
    monaco.editor.createDiffEditor(
      editor,
      {
        automaticLayout: true,
        theme: 'auto-codez',
        fontFamily:
          '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
        fontSize: 13,
        lineHeight: 21,
        minimap: {
          enabled: false,
        },
        renderSideBySide: false,
        readOnly: true,
        originalEditable: false,
        enableSplitViewResizing:
          false,
        scrollBeyondLastLine:
          false,
        renderIndicators: true,
        padding: {
          top: 8,
          bottom: 20,
        },
        scrollbar: {
          verticalScrollbarSize: 10,
          horizontalScrollbarSize: 10,
        },
        folding: true,
        lineNumbers: 'on',
        glyphMargin: false,
        overviewRulerLanes: 3,
      },
    );

  diffEditorInstance.setModel({
    original:
      originalModel,
    modified:
      proposedModel,
  });

  diffEditorInstance.layout();

  window.requestAnimationFrame(
    () => {
      diffEditorInstance?.layout();

      const modifiedEditor =
        diffEditorInstance?.getModifiedEditor();

      modifiedEditor?.setScrollTop(
        0,
      );

      modifiedEditor?.setPosition({
        lineNumber: 1,
        column: 1,
      });

      modifiedEditor?.revealLine(
        1,
      );
    },
  );

  if (currentFile) {
    currentFile.textContent =
      `${tab.relativePath} • Alteração proposta`;
  }

  showProposal();
}

function restoreTabEditor(
  tab: OpenTab,
) {
  if (!editor) {
    return;
  }

  disposeDiffEditor();

  editor.innerHTML = '';

  if (editorInstance) {
    editorInstance.setModel(
      null,
    );

    editorInstance.dispose();
    editorInstance = null;
  }

  editorInstance =
    createEditor(
      editor,
      tab.model,
    );

  attachEditorChangeListener();

  activeTabPath =
    tab.path;

  if (currentFile) {
    currentFile.textContent =
      tab.relativePath;
  }

  renderTabs();
  renderFileTree();
  updateSaveButton();

  editorInstance.focus();
}

function acceptProposal() {
  if (!pendingProposal) {
    return;
  }

  const proposal =
    pendingProposal;

  const tab =
    openTabs.find(
      (item) =>
        item.path ===
        proposal.tabPath,
    );

  if (!tab) {
    rejectProposal();
    return;
  }

  const proposedContent =
    proposal.proposedContent;

  disposeDiffEditor();

  tab.model.setValue(
    proposedContent,
  );

  tab.content =
    proposedContent;

  tab.modified =
    tab.content !==
    tab.originalContent;

  restoreTabEditor(tab);

  hideProposal();

  showStatus(
    'Alteração aceita.',
  );
}

function rejectProposal() {
  if (!pendingProposal) {
    return;
  }

  const tabPath =
    pendingProposal.tabPath;

  disposeDiffEditor();

  const tab =
    openTabs.find(
      (item) =>
        item.path ===
        tabPath,
    );

  if (!tab) {
    hideProposal();
    return;
  }

  restoreTabEditor(tab);

  hideProposal();

  showStatus(
    'Alteração rejeitada.',
  );
}

acceptProposalButton?.addEventListener(
  'click',
  acceptProposal,
);

rejectProposalButton?.addEventListener(
  'click',
  rejectProposal,
);

function buildAiPrompt(): {
  request: string;
  projectRoot: string;
  activeFile: {
    path: string;
    relativePath: string;
    name: string;
    content: string;
  };
  files: {
    path: string;
    relativePath: string;
    name: string;
    content: string;
  }[];
} | null {
  if (!activeTabPath) {
    showStatus(
      'Abra um arquivo antes de enviar uma solicitação.',
      true,
    );

    return null;
  }

  if (!projectRootPath) {
    showStatus(
      'Abra um projeto antes de enviar uma solicitação.',
      true,
    );

    return null;
  }

  const tab =
    openTabs.find(
      (item) =>
        item.path ===
        activeTabPath,
    );

  if (!tab) {
    showStatus(
      'Não foi possível localizar o arquivo ativo.',
      true,
    );

    return null;
  }

  const request =
    prompt.value.trim();

  if (!request) {
    return null;
  }

  const files =
    projectFiles
      .filter(
        (file) =>
          file.type === 'file',
      )
      .map(
        (file) => ({
          path:
            file.path,
          relativePath:
            file.relativePath,
          name:
            file.name,
          content:
  openTabs.find(
    (tab) =>
      tab.path === file.path,
  )?.model.getValue() ||
  '',
        }),
      );

  const activeFile = {
    path:
      tab.path,
    relativePath:
      tab.relativePath,
    name:
      tab.name,
    content:
      tab.model.getValue(),
  };

  return {
    request,
    projectRoot:
      projectRootPath,
    activeFile,
    files,
  };
}

async function sendMessage() {
  if (!prompt) {
    return;
  }

  if (activeAiSessionId) {
    showStatus(
      'A IA ainda está processando a solicitação anterior.',
      true,
    );
    return;
  }

  if (pendingProposal) {
    showStatus(
      'Aceite ou rejeite a alteração atual antes de enviar outra solicitação.',
      true,
    );

    return;
  }

  if (!selectedAiProvider) {
    openAiMenu();

    showStatus(
      'Selecione uma IA primeiro.',
      true,
    );

    return;
  }

  const provider =
    getAiProvider(
      selectedAiProvider,
    );

  if (!provider) {
    return;
  }

  const sessionInput =
    buildAiPrompt();

  if (!sessionInput) {
    return;
  }

  sendButton!.disabled = true;

  try {
    showStatus(
      'Preparando solicitação...',
    );

    const result =
      await window.autoCodez.createAiSession({
        provider:
          selectedAiProvider,
        request:
          sessionInput.request,
        projectRoot:
          sessionInput.projectRoot,
        activeFile:
          sessionInput.activeFile,
        files:
          sessionInput.files,
      });

    if (!result.success) {
      showStatus(
        result.error ||
          'Não foi possível iniciar a sessão.',
        true,
      );

      sendButton.disabled = false;
      return;
    }

    activeAiSessionId =
      result.sessionId || null;

    prompt.value = '';

    prompt.style.height =
      'auto';

    showStatus(
      `Enviando para ${provider.name}...`,
    );
  } catch (error) {
    activeAiSessionId = null;
    sendButton.disabled = false;

    showStatus(
      error instanceof Error
        ? error.message
        : 'Não foi possível iniciar a sessão.',
      true,
    );
  }
}

sendButton?.addEventListener(
  'click',
  () => {
    void sendMessage();
  },
);

prompt?.addEventListener(
  'keydown',
  (event) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey
    ) {
      event.preventDefault();
      void sendMessage();
    }
  },
);

prompt?.addEventListener(
  'input',
  () => {
    if (!prompt) {
      return;
    }

    prompt.style.height =
      'auto';

    prompt.style.height =
      `${Math.min(
        prompt.scrollHeight,
        180,
      )}px`;
  },
);

function renderFileTree() {
  if (!fileList) {
    return;
  }

  fileList.innerHTML = '';

  if (
    projectFiles.length ===
    0
  ) {
    fileList.innerHTML = `
      <div class="empty-files">
        Nenhum arquivo encontrado.
      </div>
    `;

    return;
  }

  const tree =
    buildTree(
      projectFiles,
    );

  const fragment =
    document.createDocumentFragment();

  for (
    const item of tree
  ) {
    renderTreeItem(
      item,
      fragment,
      0,
    );
  }

  fileList.appendChild(
    fragment,
  );
}

type TreeNode = {
  file: ProjectFile;
  children: TreeNode[];
};

function buildTree(
  files: ProjectFile[],
): TreeNode[] {
  const roots: TreeNode[] = [];

  const nodes =
    new Map<
      string,
      TreeNode
    >();

  for (
    const file of files
  ) {
    nodes.set(
      file.path,
      {
        file,
        children: [],
      },
    );
  }

  for (
    const file of files
  ) {
    const node =
      nodes.get(
        file.path,
      );

    if (!node) {
      continue;
    }

    const parentPath =
      getParentPath(
        file.path,
      );

    if (
      parentPath &&
      nodes.has(parentPath)
    ) {
      nodes
        .get(parentPath)
        ?.children.push(
          node,
        );
    } else {
      roots.push(node);
    }
  }

  for (
    const node of nodes.values()
  ) {
    node.children.sort(
      (a, b) => {
        if (
          a.file.type !==
          b.file.type
        ) {
          return a.file.type ===
            'directory'
            ? -1
            : 1;
        }

        return a.file.name.localeCompare(
          b.file.name,
        );
      },
    );
  }

  roots.sort(
    (a, b) => {
      if (
        a.file.type !==
        b.file.type
      ) {
        return a.file.type ===
          'directory'
          ? -1
          : 1;
      }

      return a.file.name.localeCompare(
        b.file.name,
      );
    },
  );

  return roots;
}

function getParentPath(
  filePath: string,
): string | null {
  const normalized =
    filePath.replace(
      /[\\/]+$/,
      '',
    );

  const index =
    Math.max(
      normalized.lastIndexOf(
        '/',
      ),
      normalized.lastIndexOf(
        '\\',
      ),
    );

  if (index <= 0) {
    return null;
  }

  return normalized.substring(
    0,
    index,
  );
}

function renderTreeItem(
  node: TreeNode,
  fragment: DocumentFragment,
  depth: number,
) {
  const { file } =
    node;

  const item =
    document.createElement(
      'button',
    );

  item.className =
    `file-item ${file.type}`;

  item.style.paddingLeft =
    `${8 + depth * 18}px`;

  item.type = 'button';

  if (
    file.type ===
    'directory'
  ) {
    const expanded =
      expandedDirectories.has(
        file.path,
      );

    item.innerHTML = `
      <span class="folder-chevron ${
        expanded
          ? 'expanded'
          : ''
      }">
        ${getChevronIcon()}
      </span>

      <span class="file-icon folder-icon">
        ${getFolderIcon(
          expanded,
        )}
      </span>

      <span class="file-name"></span>
    `;

    const nameElement =
      item.querySelector<HTMLSpanElement>(
        '.file-name',
      );

    if (nameElement) {
      nameElement.textContent =
        file.name;
    }

    item.addEventListener(
      'click',
      () => {
        if (expanded) {
          expandedDirectories.delete(
            file.path,
          );
        } else {
          expandedDirectories.add(
            file.path,
          );
        }

        renderFileTree();
      },
    );

    fragment.appendChild(
      item,
    );

    if (expanded) {
      for (
        const child of
        node.children
      ) {
        renderTreeItem(
          child,
          fragment,
          depth + 1,
        );
      }
    }

    return;
  }

  item.innerHTML = `
    <span class="folder-chevron file-spacer"></span>

    <span class="file-icon ${getFileColorClass(
      file.name,
    )}">
      ${getFileIcon(
        file.name,
      )}
    </span>

    <span class="file-name"></span>

    <span class="file-status"></span>
  `;

  const nameElement =
    item.querySelector<HTMLSpanElement>(
      '.file-name',
    );

  const statusElement =
    item.querySelector<HTMLSpanElement>(
      '.file-status',
    );

  if (nameElement) {
    nameElement.textContent =
      file.name;
  }

  const tab =
    openTabs.find(
      (item) =>
        item.path ===
        file.path,
    );

  if (
    tab?.modified &&
    statusElement
  ) {
    statusElement.textContent =
      'U';
  }

  if (
    activeTabPath ===
    file.path
  ) {
    item.classList.add(
      'active',
    );
  }

  item.addEventListener(
    'click',
    () => {
      void openFile(file);
    },
  );

  fragment.appendChild(
    item,
  );
}

function getChevronIcon(): string {
  return `
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path
        d="M6 3.5L10.5 8L6 12.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  `;
}

function getFolderIcon(
  expanded: boolean,
): string {
  return `
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path
        d="M1.5 4.5C1.5 3.95 1.95 3.5 2.5 3.5H6L7.5 5H13.5C14.05 5 14.5 5.45 14.5 6V12C14.5 12.55 14.05 13 13.5 13H2.5C1.95 13 1.5 12.55 1.5 12V4.5Z"
        fill="currentColor"
      />
      ${
        expanded
          ? `
            <path
              d="M2.5 6H13.5"
              fill="none"
              stroke="#0b0d11"
              stroke-width="0.8"
            />
          `
          : ''
      }
    </svg>
  `;
}

function getFileIcon(
  fileName: string,
): string {
  const lowerName =
    fileName.toLowerCase();

  if (
    lowerName ===
    '.gitignore'
  ) {
    return `
      <svg viewBox="0 0 16 16" width="16" height="16">
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="currentColor"
        />
        <path
          d="M5 8H11M8 5V11"
          stroke="#0b0d11"
          stroke-width="1.2"
        />
      </svg>
    `;
  }

  if (
    lowerName ===
    'dockerfile'
  ) {
    return `
      <svg viewBox="0 0 16 16" width="16" height="16">
        <path
          d="M2 7H12V11H2Z"
          fill="currentColor"
        />
        <path
          d="M4 5H6V7H4ZM7 5H9V7H7ZM10 5H12V7H10Z"
          fill="currentColor"
        />
      </svg>
    `;
  }

  const extension =
    fileName
      .split('.')
      .pop()
      ?.toLowerCase();

  switch (extension) {
    case 'html':
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path
            d="M2.5 2.5H13.5L12.5 13L8 14L3.5 13Z"
            fill="currentColor"
          />
          <path
            d="M5 6H11M5.5 8H10.5M5.8 10H10.2"
            stroke="#0b0d11"
            stroke-width="1"
          />
        </svg>
      `;

    case 'css':
    case 'scss':
    case 'less':
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path
            d="M3 2H13L12 14L8 15L4 14Z"
            fill="currentColor"
          />
          <path
            d="M5 6H11M5 8H10M5 10H9"
            stroke="#0b0d11"
            stroke-width="1"
          />
        </svg>
      `;

    case 'js':
    case 'jsx':
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <rect
            x="1.5"
            y="1.5"
            width="13"
            height="13"
            rx="1"
            fill="currentColor"
          />
          <text
            x="8"
            y="11.2"
            text-anchor="middle"
            font-size="6"
            font-family="Arial"
            font-weight="700"
            fill="#0b0d11"
          >JS</text>
        </svg>
      `;

    case 'ts':
    case 'tsx':
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <rect
            x="1.5"
            y="1.5"
            width="13"
            height="13"
            rx="1"
            fill="currentColor"
          />
          <text
            x="8"
            y="11.2"
            text-anchor="middle"
            font-size="5.5"
            font-family="Arial"
            font-weight="700"
            fill="#ffffff"
          >TS</text>
        </svg>
      `;

    case 'json':
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <text
            x="8"
            y="11.5"
            text-anchor="middle"
            font-size="10"
            font-family="monospace"
            font-weight="700"
            fill="currentColor"
          >{}</text>
        </svg>
      `;

    case 'md':
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path
            d="M2 4H14V12H2Z"
            fill="currentColor"
          />
          <path
            d="M4 10V6L6 8L8 6V10M10 8H12M11 7V9"
            stroke="#0b0d11"
            stroke-width="1"
            fill="none"
          />
        </svg>
      `;

    case 'py':
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path
            d="M8 1.5C5 1.5 4 2.6 4 4.2V6H8V7H3C1.8 7 1.5 8.2 1.5 9.8C1.5 11.6 2.2 12.5 4 12.5H6V10.5C6 8.8 7 8 8.5 8H12C13.6 8 14.5 7 14.5 5.5V4C14.5 2.3 12.8 1.5 10.5 1.5Z"
            fill="currentColor"
          />
        </svg>
      `;

    case 'java':
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path
            d="M5 10C3 11 4 12.5 8 12.5C11.5 12.5 13 11 12 10"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path
            d="M8 2C10 4 5 5 8 7C10 8.2 7 9 7 10"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
          />
        </svg>
      `;

    case 'c':
    case 'cpp':
    case 'h':
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <circle
            cx="8"
            cy="8"
            r="6"
            fill="currentColor"
          />
          <text
            x="8"
            y="10.3"
            text-anchor="middle"
            font-size="7"
            font-family="Arial"
            font-weight="700"
            fill="#0b0d11"
          >C</text>
        </svg>
      `;

    case 'xml':
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path
            d="M3 4L1.5 8L3 12M13 4L14.5 8L13 12M7 3L9 13"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
          />
        </svg>
      `;

    case 'yaml':
    case 'yml':
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path
            d="M3 3H13V13H3Z"
            fill="currentColor"
          />
          <path
            d="M5 6H11M5 8H10M5 10H9"
            stroke="#0b0d11"
            stroke-width="1"
          />
        </svg>
      `;

    case 'sql':
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <ellipse
            cx="8"
            cy="4"
            rx="5"
            ry="2.2"
            fill="currentColor"
          />
          <path
            d="M3 4V10C3 11.2 5.2 12.2 8 12.2C10.8 12.2 13 11.2 13 10V4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
          />
        </svg>
      `;

    default:
      return `
        <svg viewBox="0 0 16 16" width="16" height="16">
          <path
            d="M3 1.5H9L13 5.5V14.5H3Z"
            fill="currentColor"
          />
          <path
            d="M9 1.5V5.5H13"
            fill="none"
            stroke="#0b0d11"
            stroke-width="1"
          />
        </svg>
      `;
  }
}

function getFileColorClass(
  fileName: string,
): string {
  const lowerName =
    fileName.toLowerCase();

  if (
    lowerName ===
    '.gitignore'
  ) {
    return 'file-color-git';
  }

  if (
    lowerName ===
    'dockerfile'
  ) {
    return 'file-color-docker';
  }

  const extension =
    fileName
      .split('.')
      .pop()
      ?.toLowerCase();

  switch (extension) {
    case 'html':
      return 'file-color-html';

    case 'css':
    case 'scss':
    case 'less':
      return 'file-color-css';

    case 'js':
    case 'jsx':
      return 'file-color-js';

    case 'ts':
    case 'tsx':
      return 'file-color-ts';

    case 'json':
      return 'file-color-json';

    case 'md':
      return 'file-color-md';

    case 'py':
      return 'file-color-python';

    case 'java':
      return 'file-color-java';

    case 'c':
    case 'cpp':
    case 'h':
      return 'file-color-c';

    case 'xml':
      return 'file-color-xml';

    case 'yaml':
    case 'yml':
      return 'file-color-yaml';

    case 'sql':
      return 'file-color-sql';

    case 'sh':
      return 'file-color-shell';

    case 'bat':
    case 'ps1':
      return 'file-color-terminal';

    default:
      return 'file-color-default';
  }
}

function getMonacoLanguage(
  fileName: string,
): string {
  const lowerName =
    fileName.toLowerCase();

  if (
    lowerName ===
    '.gitignore'
  ) {
    return 'shell';
  }

  if (
    lowerName ===
    'dockerfile'
  ) {
    return 'dockerfile';
  }

  const extension =
    fileName
      .split('.')
      .pop()
      ?.toLowerCase();

  switch (extension) {
    case 'ts':
    case 'tsx':
      return 'typescript';

    case 'js':
    case 'jsx':
      return 'javascript';

    case 'json':
      return 'json';

    case 'html':
      return 'html';

    case 'css':
      return 'css';

    case 'scss':
      return 'scss';

    case 'less':
      return 'less';

    case 'md':
      return 'markdown';

    case 'py':
      return 'python';

    case 'java':
      return 'java';

    case 'c':
      return 'c';

    case 'cpp':
      return 'cpp';

    case 'h':
      return 'cpp';

    case 'xml':
      return 'xml';

    case 'yaml':
    case 'yml':
      return 'yaml';

    case 'sql':
      return 'sql';

    case 'sh':
      return 'shell';

    case 'bat':
      return 'bat';

    case 'ps1':
      return 'powershell';

    default:
      return 'plaintext';
  }
}

function escapeHtml(
  value: string,
): string {
  return value
    .replaceAll(
      '&',
      '&amp;',
    )
    .replaceAll(
      '<',
      '&lt;',
    )
    .replaceAll(
      '>',
      '&gt;',
    )
    .replaceAll(
      '"',
      '&quot;',
    );
}

function getProjectRoot(): string | null {
  return projectRootPath;
}

function getOpenFileContent(
  filePath: string,
): string {
  const tab =
    openTabs.find(
      (item) =>
        item.path ===
        filePath,
    );

  if (tab) {
    return tab.model.getValue();
  }

  return '';
}

function showStatus(
  message: string,
  error = false,
) {
  if (!status) {
    return;
  }

  status.textContent =
    message;

  status.className =
    `status visible ${
      error
        ? 'error'
        : ''
    }`;

  window.setTimeout(
    () => {
      status.className =
        'status';
    },
    2200,
  );
}