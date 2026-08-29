export type AiProviderId =
  | 'chatgpt'
  | 'claude'
  | 'gemini';

export type AiRequest = {
  provider: AiProviderId;
  prompt: string;
  timeoutMs?: number;
};

export type AiResponse = {
  provider: AiProviderId;
  content: string;
  receivedAt: number;
};

export interface AiConnector {
  readonly provider: AiProviderId;

  isAvailable(): Promise<boolean>;

  prepare(): Promise<boolean>;

  send(
    request: AiRequest,
  ): Promise<AiResponse>;

  readResponse(): Promise<AiResponse | null>;
}