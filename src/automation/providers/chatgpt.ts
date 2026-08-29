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
  focusBrowserInput,
  focusBrowserTab,
  pasteClipboardAndSend,
  waitForAiTab,
} from '../browser';

import {
  clipboard,
  shell,
} from 'electron';

const CHATGPT_URL = 'https://chatgpt.com/';

export class ChatGptConnector implements AiConnector {
  readonly provider = 'chatgpt' as const;

  private responseReader: AiResponseReaderState | null = null;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async prepare(): Promise<boolean> {
    const browserTab = await waitForAiTab(
      ['ChatGPT', 'chatgpt.com', 'OpenAI'],
      2,
      300,
    );

    if (browserTab) {
      return true;
    }

    try {
      await shell.openExternal(CHATGPT_URL);
    }
    catch {
      return false;
    }

    const openedTab = await waitForAiTab(
      ['ChatGPT', 'chatgpt.com', 'OpenAI'],
      30,
      500,
    );

    return openedTab !== null;
  }

  async send(request: AiRequest): Promise<AiResponse> {
    if (request.provider !== this.provider) {
      throw new Error(
        'O conector do ChatGPT recebeu um provider inválido.',
      );
    }

    if (!request.prompt.trim()) {
      throw new Error('O prompt do ChatGPT está vazio.');
    }

    clipboard.writeText(request.prompt);

    const browserTab = await waitForAiTab(
      ['ChatGPT', 'chatgpt.com', 'OpenAI'],
      10,
      300,
    );

    if (!browserTab) {
      throw new Error(
        'Não foi possível localizar a aba do ChatGPT no navegador.',
      );
    }

    const selected = await focusBrowserTab(browserTab);

    if (!selected) {
      throw new Error(
        'Não foi possível selecionar a aba do ChatGPT.',
      );
    }

    const inputFocused = await focusBrowserInput(browserTab);

    if (!inputFocused) {
      throw new Error(
        'Não foi possível focar o campo de mensagem do ChatGPT.',
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
        'Não foi possível enviar o prompt para o ChatGPT.',
      );
    }

    return {
      provider: this.provider,
      content: 'Solicitação enviada ao ChatGPT.',
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
