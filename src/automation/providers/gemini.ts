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

const GEMINI_URL = 'https://gemini.google.com/app';
const GEMINI_TAB_TERMS = ['Gemini', 'gemini.google.com', 'Google Gemini'];

export class GeminiConnector implements AiConnector {
  readonly provider = 'gemini' as const;

  private responseReader: AiResponseReaderState | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async prepare(): Promise<boolean> {
    const browserTab = await waitForAiTab(
      GEMINI_TAB_TERMS,
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
      GEMINI_TAB_TERMS,
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

    const browserTab = await waitForAiTab(
      GEMINI_TAB_TERMS,
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
        'Não foi possível selecionar a aba correta do Gemini.',
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
        'O campo de mensagem do Gemini não foi identificado com segurança no conteúdo da página. O prompt não foi enviado.',
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
