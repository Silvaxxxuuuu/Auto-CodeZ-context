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
  focusBrowserMessageInput,
  focusBrowserTab,
  pasteClipboardAndSend,
  waitForAiTab,
} from '../browser';

import {
  clipboard,
  shell,
} from 'electron';

const GEMINI_URL = 'https://gemini.google.com/app';

export class GeminiConnector implements AiConnector {
  readonly provider = 'gemini' as const;

  private responseReader: AiResponseReaderState | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async prepare(): Promise<boolean> {
    const browserTab = await waitForAiTab(
      ['Gemini', 'gemini.google.com', 'Google Gemini'],
      2,
      300,
    );

    if (browserTab) {
      return true;
    }

    try {
      await shell.openExternal(GEMINI_URL);
    }
    catch {
      return false;
    }

    const openedTab = await waitForAiTab(
      ['Gemini', 'gemini.google.com', 'Google Gemini'],
      30,
      500,
    );

    return openedTab !== null;
  }

  async send(request: AiRequest): Promise<AiResponse> {
    if (request.provider !== this.provider) {
      throw new Error(
        'O conector do Gemini recebeu um provider inválido.',
      );
    }

    if (!request.prompt.trim()) {
      throw new Error('O prompt do Gemini está vazio.');
    }

    clipboard.writeText(request.prompt);

    const browserTab = await waitForAiTab(
      ['Gemini', 'gemini.google.com', 'Google Gemini'],
      10,
      300,
    );

    if (!browserTab) {
      throw new Error(
        'Não foi possível localizar a aba do Gemini no navegador.',
      );
    }

    const selected = await focusBrowserTab(browserTab);

    if (!selected) {
      throw new Error(
        'Não foi possível selecionar a aba do Gemini.',
      );
    }

    const inputFocused = await focusBrowserMessageInput(
      browserTab,
      this.provider,
    );

    if (!inputFocused) {
      throw new Error(
        'Não foi possível identificar com segurança o campo de mensagem do Gemini.',
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
        'Não foi possível enviar o prompt para o Gemini.',
      );
    }

    return {
      provider: this.provider,
      content: 'Solicitação enviada ao Gemini.',
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
