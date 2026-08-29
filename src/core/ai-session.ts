import {
  type AiProviderId,
  type AiResponse,
} from '../ai/aiConnector';

export type {
  AiProviderId,
} from '../ai/aiConnector';

export type AiSessionFile = {
  path: string;
  relativePath: string;
  name: string;
  content: string;
};

export type AiSessionActiveFile =
  AiSessionFile;

export type AiSessionRequest = {
  provider: AiProviderId;
  request: string;
  projectRoot: string;
  activeFile: AiSessionActiveFile;
  files: AiSessionFile[];
};

export type AiSessionState =
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

export type AiSessionResult = {
  sessionId: string;
  provider: AiProviderId;
  response: AiResponse;
};

export type AiSessionEvent = {
  sessionId: string;
  state: AiSessionState;
  timestamp: number;
};

export class AiSession {
  readonly id: string;
  readonly provider: AiProviderId;
  readonly request: string;
  readonly projectRoot: string;
  readonly activeFile: AiSessionActiveFile;
  readonly files: AiSessionFile[];
  readonly prompt: string;
  readonly createdAt: number;

  private stateValue: AiSessionState =
    'idle';

  private errorValue:
    | string
    | null = null;

  private responseValue:
    | AiResponse
    | null = null;

  private updatedAtValue: number;

  constructor(
    request: AiSessionRequest,
  ) {
    this.id =
      crypto.randomUUID();

    this.provider =
      request.provider;

    this.request =
      request.request;

    this.projectRoot =
      request.projectRoot;

    this.activeFile =
      request.activeFile;

    this.files =
      [...request.files];

    this.prompt =
      buildSessionPrompt(
        request,
      );

    this.createdAt =
      Date.now();

    this.updatedAtValue =
      this.createdAt;
  }

  get state(): AiSessionState {
    return this.stateValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  get response(): AiResponse | null {
    return this.responseValue;
  }

  get updatedAt(): number {
    return this.updatedAtValue;
  }

  setState(
    state: AiSessionState,
  ): void {
    this.stateValue =
      state;

    this.updatedAtValue =
      Date.now();

    if (
      state !== 'failed'
    ) {
      this.errorValue =
        null;
    }
  }

  setResponse(
    response: AiResponse,
  ): void {
    this.responseValue =
      response;

    this.errorValue =
      null;

    this.stateValue =
      'receiving';

    this.updatedAtValue =
      Date.now();
  }

  fail(
    error: string,
  ): void {
    this.errorValue =
      error;

    this.stateValue =
      'failed';

    this.updatedAtValue =
      Date.now();
  }

  cancel(): void {
    this.stateValue =
      'cancelled';

    this.updatedAtValue =
      Date.now();
  }

  isFinished(): boolean {
    return (
      this.stateValue ===
        'completed' ||
      this.stateValue ===
        'failed' ||
      this.stateValue ===
        'cancelled'
    );
  }

  isActive(): boolean {
    return !this.isFinished();
  }

  toEvent(): AiSessionEvent {
    return {
      sessionId:
        this.id,
      state:
        this.stateValue,
      timestamp:
        this.updatedAtValue,
    };
  }

  toResult(): AiSessionResult {
    if (!this.responseValue) {
      throw new Error(
        'A sessão ainda não possui uma resposta.',
      );
    }

    return {
      sessionId:
        this.id,
      provider:
        this.provider,
      response:
        this.responseValue,
    };
  }
}

export function createAiSession(
  request: AiSessionRequest,
): AiSession {
  return new AiSession(
    request,
  );
}

function buildSessionPrompt(
  request: AiSessionRequest,
): string {
  const sections: string[] =
    [];

  sections.push(
    'Você está trabalhando com o Auto CodeZ.',
  );

  sections.push(
    '',
    'O Auto CodeZ é um ambiente de desenvolvimento que permite trabalhar com projetos locais usando IAs externas.',
  );

  sections.push(
    '',
    'Sua tarefa é analisar o pedido do usuário considerando o contexto fornecido do projeto.',
  );

  sections.push(
    '',
    'REGRAS:',
    '1. Preserve o comportamento existente sempre que possível.',
    '2. Altere somente o que for necessário para atender ao pedido.',
    '3. Não remova funcionalidades existentes sem uma solicitação explícita.',
    '4. Considere dependências entre arquivos antes de propor alterações.',
    '5. Mantenha o padrão de código já utilizado pelo projeto.',
    '6. Não invente arquivos, APIs ou bibliotecas sem necessidade.',
    '7. Quando uma alteração exigir múltiplos arquivos, identifique todos os arquivos afetados.',
    '8. A resposta será processada pelo Auto CodeZ posteriormente.',
  );

  sections.push(
    '',
    'FORMATO DA RESPOSTA:',
    'Explique brevemente o que será alterado.',
    'Depois, apresente as alterações de código necessárias.',
    'Identifique claramente o caminho de cada arquivo afetado.',
    'Não omita arquivos necessários para que a alteração funcione.',
  );

  sections.push(
    '',
    `PROJETO: ${request.projectRoot}`,
  );

  sections.push(
    '',
    `ARQUIVO ATIVO: ${request.activeFile.relativePath}`,
  );

  sections.push(
    '',
    'PEDIDO DO USUÁRIO:',
    request.request,
  );

  sections.push(
    '',
    'ARQUIVOS DO PROJETO:',
  );

  for (
    const file of request.files
  ) {
    sections.push(
      '',
      `===== ${file.relativePath} =====`,
      file.content,
    );
  }

  sections.push(
    '',
    'ANALISE O PEDIDO E O CONTEXTO DO PROJETO.',
  );

  return sections.join(
    '\n',
  );
}