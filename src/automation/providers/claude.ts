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

import {
  findAiTab,
  focusBrowserInput,
  focusBrowserTab,
  pasteClipboardAndSend,
  waitForAiTab,
} from '../browser';

import {
  clipboard,
  shell,
} from 'electron';

const CLAUDE_URL = 'https://claude.ai/new';

export class ClaudeConnector implements AiConnector {
  readonly provider = 'claude' as const;

  private responseReader: AiResponseReaderState | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async prepare(): Promise<boolean> {
    const browserTab = await findAiTab(['Claude', 'claude.ai', 'Anthropic']);

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
      ['Claude', 'claude.ai', 'Anthropic'],
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

    clipboard.writeText(request.prompt);

    const browserTab = await waitForAiTab(
      ['Claude', 'claude.ai', 'Anthropic'],
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
        'Não foi possível selecionar a aba do Claude.',
      );
    }

    const inputFocused = await focusBrowserInput(browserTab);

    if (!inputFocused) {
      throw new Error(
        'Não foi possível focar o campo de mensagem do Claude.',
      );
    }

    this.responseReader = await captureResponseReaderState(
      browserTab.handle,
      request.prompt,
    );

    const sent = await pasteClipboardAndSend();

    if (!sent) {
      this.responseReader = null;
      throw new Error(
        'Não foi possível enviar o prompt para o Claude.',
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
