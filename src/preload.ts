import {
  contextBridge,
  ipcRenderer,
} from 'electron';

type ClipboardResult = {
  success: boolean;
  content?: string;
  error?: string;
};

type ProjectContextResult = {
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
};

type ExternalAiResult = {
  success: boolean;
  error?: string;
};

type AiControl = {
  name?: string;
  automationId?: string;
  controlType?: string;
  className?: string;
  framework?: string;
  processId?: number;
  enabled?: boolean;
  offscreen?: boolean;
};

type AiWindow = {
  title: string;
  processId: number;
  className: string;
  framework: string;
  controls: AiControl[];
};

type InspectExternalAiResult = {
  success: boolean;
  running?: boolean;
  provider?: string;
  windows?: AiWindow[];
  error?: string;
};

type AiResponseResult = {
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
};

contextBridge.exposeInMainWorld(
  'autoCodez',
  {
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
) =>
  ipcRenderer.invoke(
    'create-ai-session',
    request,
  ),

cancelAiSession: (
  sessionId: string,
) =>
  ipcRenderer.invoke(
    'cancel-ai-session',
    sessionId,
  ),

onAiSessionState: (
  callback: (
    state: {
      sessionId: string;
      state:
        | 'idle'
        | 'preparing'
        | 'waiting'
        | 'receiving'
        | 'completed'
        | 'failed'
        | 'cancelled';
    },
  ) => void,
) => {
  const listener = (
    _event: Electron.IpcRendererEvent,
    state: {
      sessionId: string;
      state:
        | 'idle'
        | 'preparing'
        | 'waiting'
        | 'receiving'
        | 'completed'
        | 'failed'
        | 'cancelled';
    },
  ) => {
    callback(state);
  };

  ipcRenderer.on(
    'ai-session-state',
    listener,
  );

  return () => {
    ipcRenderer.removeListener(
      'ai-session-state',
      listener,
    );
  };
},
    sendAiRequest: (
  request: {
    provider:
      | 'chatgpt'
      | 'claude'
      | 'gemini';
    prompt: string;
    timeoutMs?: number;
  },
) =>
  ipcRenderer.invoke(
    'send-ai-request',
    request,
  ),
    openFolder: () =>
      ipcRenderer.invoke(
        'open-folder',
      ),

    readFile: (
      filePath: string,
    ) =>
      ipcRenderer.invoke(
        'read-file',
        filePath,
      ),

    writeFile: (
      filePath: string,
      content: string,
    ) =>
      ipcRenderer.invoke(
        'write-file',
        filePath,
        content,
      ),

    openExternalAi: (
      provider: string,
    ): Promise<ExternalAiResult> =>
      ipcRenderer.invoke(
        'open-external-ai',
        provider,
      ),

    writeClipboard: (
      text: string,
    ): Promise<ClipboardResult> =>
      ipcRenderer.invoke(
        'write-clipboard',
        text,
      ),

    readClipboard:
      (): Promise<ClipboardResult> =>
        ipcRenderer.invoke(
          'read-clipboard',
        ),

    inspectExternalAi: (
      provider: string,
    ): Promise<InspectExternalAiResult> =>
      ipcRenderer.invoke(
        'inspect-external-ai',
        provider,
      ),

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
    ): Promise<ProjectContextResult> =>
      ipcRenderer.invoke(
        'build-project-context',
        input,
      ),
  },
);