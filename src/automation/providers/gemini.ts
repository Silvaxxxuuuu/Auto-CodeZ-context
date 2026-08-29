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
  findWindowHandleByTitle,
  focusFirstEditableElement,
  focusWindow,
} from '../windows-ui';

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
    const browserTab = await findAiTab(['Gemini']);

    if (browserTab) {
      return true;
    }

    const appHandle = await findWindowHandleByTitle([
      'Gemini',
      'gemini.google.com',
      'Google Gemini',
    ]);

    if (appHandle !== null) {
      return true;
    }

    try {
      await shell.openExternal(GEMINI_URL);
    }
    catch {
      return false;
    }

    const openedTab = await waitForAiTab(
      ['Gemini'],
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

    const browserTab = await findAiTab(['Gemini']);

    if (browserTab) {
      const selected = await focusBrowserTab(browserTab);

      if (!selected) {
        throw new Error(
          'Não foi possível selecionar a aba do Gemini.',
        );
      }

      const inputFocused = await focusBrowserInput(browserTab);

      if (!inputFocused) {
        throw new Error(
          'Não foi possível focar o campo de mensagem do Gemini.',
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

    const appHandle = await findWindowHandleByTitle([
      'Gemini',
      'gemini.google.com',
      'Google Gemini',
    ]);

    if (!appHandle) {
      throw new Error('O Gemini não está aberto.');
    }

    const focused = await focusWindow(appHandle);

    if (!focused) {
      throw new Error('Não foi possível focar o Gemini.');
    }

    const inputFocused = await focusFirstEditableElement(appHandle);

    if (!inputFocused) {
      throw new Error(
        'Não foi possível focar o campo de mensagem do Gemini.',
      );
    }

    this.responseReader = await captureResponseReaderState(
      appHandle,
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
