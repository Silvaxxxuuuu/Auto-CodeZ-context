import type {
  AiConnector,
  AiRequest,
  AiResponse,
} from '../../ai/aiConnector';

import {
  findAiTab,
  focusBrowserInput,
  focusBrowserTab,
  pasteClipboardAndSend,
} from '../browser';

import {
  findWindowHandleByTitle,
  focusFirstEditableElement,
  focusWindow,
} from '../windows-ui';

export class ChatGptConnector
  implements AiConnector
{
  readonly provider =
    'chatgpt' as const;

  async isAvailable(): Promise<boolean> {
    const browserTab =
      await findAiTab([
        'ChatGPT',
      ]);

    if (browserTab) {
      return true;
    }

    const appHandle =
      await findWindowHandleByTitle([
        'ChatGPT',
      ]);

    return appHandle !== null;
  }

  async prepare(): Promise<boolean> {
  const browserTab =
    await findAiTab([
      'ChatGPT',
    ]);

  if (browserTab) {
    return true;
  }

  const appHandle =
    await findWindowHandleByTitle([
      'ChatGPT',
    ]);

  return appHandle !== null;
}

  async send(
    request: AiRequest,
  ): Promise<AiResponse> {
    if (
      request.provider !==
      this.provider
    ) {
      throw new Error(
        'O conector do ChatGPT recebeu um provider inválido.',
      );
    }

    if (
      !request.prompt.trim()
    ) {
      throw new Error(
        'O prompt do ChatGPT está vazio.',
      );
    }

    const browserTab =
      await findAiTab([
        'ChatGPT',
      ]);

    if (browserTab) {
      const selected =
        await focusBrowserTab(
          browserTab,
        );

      if (!selected) {
        throw new Error(
          'Não foi possível selecionar a aba do ChatGPT.',
        );
      }

      const inputFocused =
        await focusBrowserInput(
          browserTab,
        );

      if (!inputFocused) {
        throw new Error(
          'Não foi possível focar o campo de mensagem do ChatGPT.',
        );
      }

      const sent =
        await pasteClipboardAndSend();

      if (!sent) {
        throw new Error(
          'Não foi possível enviar o prompt para o ChatGPT.',
        );
      }

      return {
        provider:
          this.provider,
        content:
          'Solicitação enviada ao ChatGPT.',
        receivedAt:
          Date.now(),
      };
    }

    const appHandle =
      await findWindowHandleByTitle([
        'ChatGPT',
      ]);

    if (!appHandle) {
      throw new Error(
        'O ChatGPT não está aberto.',
      );
    }

    const focused =
      await focusWindow(
        appHandle,
      );

    if (!focused) {
      throw new Error(
        'Não foi possível focar o ChatGPT.',
      );
    }

    const inputFocused =
      await focusFirstEditableElement(
        appHandle,
      );

    if (!inputFocused) {
      throw new Error(
        'Não foi possível focar o campo de mensagem do ChatGPT.',
      );
    }

    const sent =
      await pasteClipboardAndSend();

    if (!sent) {
      throw new Error(
        'Não foi possível enviar o prompt para o ChatGPT.',
      );
    }

    return {
      provider:
        this.provider,
      content:
        'Solicitação enviada ao ChatGPT.',
      receivedAt:
        Date.now(),
    };
  }

  async readResponse(): Promise<AiResponse | null> {
    return null;
  }
}