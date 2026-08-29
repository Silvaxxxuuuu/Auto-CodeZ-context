import type {
  AiConnector,
  AiRequest,
  AiResponse,
} from '../../ai/aiConnector';

import {
  captureResponseReaderState,
  readNewAiResponse,
  type AiResponseReaderState,
} from '../ai-response-reader';

import { focusAndSendChromiumAiPrompt } from '../chromium-ai-input';

import {
  focusBrowserTab,
  waitForAiTab,
} from '../browser';

import {
  clipboard,
  shell,
} from 'electron';

const CLAUDE_URL = 'https://claude.ai/new';
const CLAUDE_TAB_TERMS = ['Claude', 'claude.ai', 'Anthropic'];

export class ClaudeConnector implements AiConnector {
  readonly provider = 'claude' as const;

  private responseReader: AiResponseReaderState | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async prepare(): Promise<boolean> {
    const browserTab = await waitForAiTab(
      CLAUDE_TAB_TERMS,
      2,
      300,
    );

    if (browserTab) {
      return true;
    }

    try {
      await shell.openExternal(CLAUDE_URL);
    }
    catch {
      return false;
    }

    const openedTab = await waitForAiTab(
      CLAUDE_TAB_TERMS,
      30,
      500,
    );

    return openedTab !== null;
  }

  async send(request: AiRequest): Promise<AiResponse> {
    if (request.provider !== this.provider) {
      throw new Error(
        'O conector do Claude recebeu um provider inválido.',
      );
    }

    if (!request.prompt.trim()) {
      throw new Error('O prompt do Claude está vazio.');
    }

    const browserTab = await waitForAiTab(
      CLAUDE_TAB_TERMS,
      10,
      300,
    );

    if (!browserTab) {
      throw new Error(
        'Não foi possível localizar a aba do Claude no navegador.',
      );
    }

    const selected = await focusBrowserTab(browserTab);

    if (!selected) {
      throw new Error(
        'Não foi possível selecionar a aba correta do Claude.',
      );
    }

    clipboard.writeText(request.prompt);

    this.responseReader = await captureResponseReaderState(
      browserTab.handle,
      request.prompt,
    );

    const sent = await focusAndSendChromiumAiPrompt(
      browserTab,
      this.provider,
    );

    if (!sent) {
      this.responseReader = null;
      throw new Error(
        'O campo de mensagem do Claude não foi identificado com segurança no conteúdo da página. O prompt não foi enviado.',
      );
    }

    return {
      provider: this.provider,
      content: 'Solicitação enviada ao Claude.',
      receivedAt: Date.now(),
    };
  }

  async readResponse(): Promise<AiResponse | null> {
    const response = await readNewAiResponse(
      this.responseReader,
      this.provider,
    );

    if (response) {
      this.responseReader = null;
    }

    return response;
  }
}
