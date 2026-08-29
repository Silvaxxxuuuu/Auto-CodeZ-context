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

export class ClaudeConnector
  implements AiConnector
{
  readonly provider =
    'claude' as const;

  async isAvailable(): Promise<boolean> {
    const browserTab =
      await findAiTab([
        'Claude',
      ]);

    if (browserTab) {
      return true;
    }

    const appHandle =
      await findWindowHandleByTitle([
        'Claude',
        'claude.ai',
        'Anthropic',
      ]);

    return appHandle !== null;
  }

  async prepare(): Promise<boolean> {
    const browserTab =
      await findAiTab([
        'Claude',
      ]);

    if (browserTab) {
      return true;
    }

    const appHandle =
      await findWindowHandleByTitle([
        'Claude',
        'claude.ai',
        'Anthropic',
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
        'O conector do Claude recebeu um provider inválido.',
      );
    }

    if (
      !request.prompt.trim()
    ) {
      throw new Error(
        'O prompt do Claude está vazio.',
      );
    }

    const browserTab =
      await findAiTab([
        'Claude',
      ]);

    if (browserTab) {
      const selected =
        await focusBrowserTab(
          browserTab,
        );

      if (!selected) {
        throw new Error(
          'Não foi possível selecionar a aba do Claude.',
        );
      }

      const inputFocused =
        await focusBrowserInput(
          browserTab,
        );

      if (!inputFocused) {
        throw new Error(
          'Não foi possível focar o campo de mensagem do Claude.',
        );
      }

      const sent =
        await pasteClipboardAndSend();

      if (!sent) {
        throw new Error(
          'Não foi possível enviar o prompt para o Claude.',
        );
      }

      return {
        provider:
          this.provider,
        content:
          'Solicitação enviada ao Claude.',
        receivedAt:
          Date.now(),
      };
    }

    const appHandle =
      await findWindowHandleByTitle([
        'Claude',
        'claude.ai',
        'Anthropic',
      ]);

    if (!appHandle) {
      throw new Error(
        'O Claude não está aberto.',
      );
    }

    const focused =
      await focusWindow(
        appHandle,
      );

    if (!focused) {
      throw new Error(
        'Não foi possível focar o Claude.',
      );
    }

    const inputFocused =
      await focusFirstEditableElement(
        appHandle,
      );

    if (!inputFocused) {
      throw new Error(
        'Não foi possível focar o campo de mensagem do Claude.',
      );
    }

    const sent =
      await pasteClipboardAndSend();

    if (!sent) {
      throw new Error(
        'Não foi possível enviar o prompt para o Claude.',
      );
    }

    return {
      provider:
        this.provider,
      content:
        'Solicitação enviada ao Claude.',
      receivedAt:
        Date.now(),
    };
  }

  async readResponse(): Promise<AiResponse | null> {
    return null;
  }
}