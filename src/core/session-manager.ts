import { EventEmitter } from 'node:events';

import {
  AiConnectorManager,
} from '../ai/aiConnectorManager';

import type {
  AiResponse,
} from '../ai/aiConnector';

import {
  AiSession,
  AiSessionRequest,
  AiSessionState,
  AiSessionResult,
  createAiSession,
} from './ai-session';

const RESPONSE_TIMEOUT_MS = 120000;
const RESPONSE_POLL_INTERVAL_MS = 250;

export type AiSessionStateChange = {
  sessionId: string;
  state: AiSessionState;
  session: AiSession;
};

export type AiSessionManagerEvent =
  | 'created'
  | 'state-changed'
  | 'completed'
  | 'failed'
  | 'cancelled';

export class SessionManager
  extends EventEmitter {
  private readonly sessions =
    new Map<string, AiSession>();

  private readonly connectorManager:
    AiConnectorManager;

  private activeSessionId:
    string | null = null;

  constructor(
    connectorManager: AiConnectorManager,
  ) {
    super();

    this.connectorManager =
      connectorManager;
  }

  create(
    request: AiSessionRequest,
  ): AiSession {
    if (
      this.activeSessionId
    ) {
      const active =
        this.getActive();

      if (
        active &&
        !active.isFinished()
      ) {
        throw new Error(
          'Já existe uma sessão de IA em execução.',
        );
      }
    }

    const session =
      createAiSession(
        request,
      );

    this.sessions.set(
      session.id,
      session,
    );

    this.activeSessionId =
      session.id;

    this.emit(
      'created',
      session,
    );

    return session;
  }

  get(
    sessionId: string,
  ): AiSession | null {
    return (
      this.sessions.get(
        sessionId,
      ) || null
    );
  }

  getActive(): AiSession | null {
    if (
      !this.activeSessionId
    ) {
      return null;
    }

    return this.get(
      this.activeSessionId,
    );
  }

  getAll(): AiSession[] {
    return Array.from(
      this.sessions.values(),
    );
  }

  getActiveSessionId():
    string | null {
    return this.activeSessionId;
  }

  hasActiveSession(): boolean {
    const session =
      this.getActive();

    return (
      session !== null &&
      !session.isFinished()
    );
  }

  async execute(
    session: AiSession,
  ): Promise<AiSessionResult | null> {
    if (
      this.get(session.id) !==
      session
    ) {
      throw new Error(
        'A sessão não pertence a este Session Manager.',
      );
    }

    if (
      session.isFinished()
    ) {
      throw new Error(
        'A sessão já foi finalizada.',
      );
    }

    try {
      this.changeState(
        session,
        'preparing',
      );

      const available =
        await this.connectorManager.isAvailable(
          session.provider,
        );

      if (!available) {
        throw new Error(
          `O provider ${session.provider} não está disponível neste sistema.`,
        );
      }

      const connector =
        this.connectorManager.get(
          session.provider,
        );

      if (!connector) {
        throw new Error(
          `Nenhum conector registrado para ${session.provider}.`,
        );
      }

      const prepared =
        await connector.prepare();

      if (!prepared) {
        throw new Error(
          `Não foi possível preparar a IA ${session.provider}.`,
        );
      }

      this.throwIfCancelled(
        session,
      );

      this.changeState(
        session,
        'sending',
      );

      await connector.send({
        provider:
          session.provider,
        prompt:
          session.prompt,
        purpose: 'modify',
      });

      this.throwIfCancelled(
        session,
      );

      this.changeState(
        session,
        'waiting',
      );

      const response =
        await this.waitForResponse(
          session,
          connector,
        );

      this.throwIfCancelled(
        session,
      );

      this.changeState(
        session,
        'receiving',
      );

      session.setResponse(
        response,
      );

      this.changeState(
        session,
        'completed',
      );

      this.emit(
        'completed',
        session,
      );

      return session.toResult();
    } catch (error) {
      if (
        session.state ===
        'cancelled'
      ) {
        this.emit(
          'cancelled',
          session,
        );

        return null;
      }

      const message =
        error instanceof Error
          ? error.message
          : 'Erro desconhecido durante a sessão de IA.';

      session.fail(
        message,
      );

      this.emit(
        'state-changed',
        this.createStateChange(
          session,
        ),
      );

      this.emit(
        'failed',
        session,
      );

      return null;
    } finally {
      if (
        this.activeSessionId ===
        session.id
      ) {
        this.activeSessionId =
          null;
      }
    }
  }

  cancel(
    sessionId: string,
  ): boolean {
    const session =
      this.get(sessionId);

    if (!session) {
      return false;
    }

    if (
      session.isFinished()
    ) {
      return false;
    }

    session.cancel();

    this.emit(
      'state-changed',
      this.createStateChange(
        session,
      ),
    );

    this.emit(
      'cancelled',
      session,
    );

    if (
      this.activeSessionId ===
      session.id
    ) {
      this.activeSessionId =
        null;
    }

    return true;
  }

  remove(
    sessionId: string,
  ): boolean {
    if (
      this.activeSessionId ===
      sessionId
    ) {
      this.activeSessionId =
        null;
    }

    return this.sessions.delete(
      sessionId,
    );
  }

  clearFinished(): void {
    for (
      const [
        sessionId,
        session,
      ] of this.sessions
    ) {
      if (
        session.isFinished()
      ) {
        this.sessions.delete(
          sessionId,
        );
      }
    }

    if (
      this.activeSessionId &&
      !this.sessions.has(
        this.activeSessionId,
      )
    ) {
      this.activeSessionId =
        null;
    }
  }

  onStateChange(
    listener: (
      change:
        AiSessionStateChange,
    ) => void,
  ): () => void {
    this.on(
      'state-changed',
      listener,
    );

    return () => {
      this.off(
        'state-changed',
        listener,
      );
    };
  }

  private async waitForResponse(
    session: AiSession,
    connector: {
      readResponse:
        () => Promise<AiResponse | null>;
    },
  ): Promise<AiResponse> {
    const deadline =
      Date.now() +
      RESPONSE_TIMEOUT_MS;

    while (
      Date.now() < deadline
    ) {
      this.throwIfCancelled(
        session,
      );

      const response =
        await connector.readResponse();

      if (
        response &&
        response.content.trim()
      ) {
        return response;
      }

      await this.delay(
        RESPONSE_POLL_INTERVAL_MS,
      );
    }

    throw new Error(
      `A IA ${session.provider} não respondeu dentro do tempo limite de ${RESPONSE_TIMEOUT_MS / 1000} segundos.`,
    );
  }

  private throwIfCancelled(
    session: AiSession,
  ): void {
    if (
      session.state ===
      'cancelled'
    ) {
      throw new Error(
        'A sessão foi cancelada.',
      );
    }
  }

  private delay(
    milliseconds: number,
  ): Promise<void> {
    return new Promise(
      (resolve) => {
        setTimeout(
          resolve,
          milliseconds,
        );
      },
    );
  }

  private changeState(
    session: AiSession,
    state: AiSessionState,
  ): void {
    session.setState(
      state,
    );

    this.emit(
      'state-changed',
      this.createStateChange(
        session,
      ),
    );
  }

  private createStateChange(
    session: AiSession,
  ): AiSessionStateChange {
    return {
      sessionId:
        session.id,
      state:
        session.state,
      session,
    };
  }
}

export function createSessionManager(
  connectorManager:
    AiConnectorManager,
): SessionManager {
  return new SessionManager(
    connectorManager,
  );
}