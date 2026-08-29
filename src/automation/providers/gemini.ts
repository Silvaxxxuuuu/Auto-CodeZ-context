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

export class GeminiConnector
  implements AiConnector
{
  readonly provider =
    'gemini' as const;

  async isAvailable(): Promise<boolean> {
    const browserTab =
      await findAiTab([
        'Gemini',
      ]);

    return browserTab !== null;
  }

  async prepare(): Promise<boolean> {
  const browserTab =
    await findAiTab([
      'Gemini',
    ]);

  return browserTab !== null;
}

  async send(
    request: AiRequest,
  ): Promise<AiResponse> {
    if (
      request.provider !==
      this.provider
    ) {
      throw new Error(
        'O conector do Gemini recebeu um provider inválido.',
      );
    }

    if (
      !request.prompt.trim()
    ) {
      throw new Error(
        'O prompt do Gemini está vazio.',
      );
    }

    const browserTab =
      await findAiTab([
        'Gemini',
      ]);

    if (!browserTab) {
      throw new Error(
        'O Gemini não está aberto.',
      );
    }

    const selected =
      await focusBrowserTab(
        browserTab,
      );

    if (!selected) {
      throw new Error(
        'Não foi possível selecionar a aba do Gemini.',
      );
    }

    const inputFocused =
      await focusBrowserInput(
        browserTab,
      );

    if (!inputFocused) {
      throw new Error(
        'Não foi possível focar o campo de mensagem do Gemini.',
      );
    }

    const sent =
      await pasteClipboardAndSend();

    if (!sent) {
      throw new Error(
        'Não foi possível enviar o prompt para o Gemini.',
      );
    }

    return {
      provider:
        this.provider,
      content:
        'Solicitação enviada ao Gemini.',
      receivedAt:
        Date.now(),
    };
  }

  async readResponse(): Promise<AiResponse | null> {
    return null;
  }
}