export type AiProviderId =
  | 'chatgpt'
  | 'claude'
  | 'gemini';

export type AiRequestPurpose =
  | 'analyze'
  | 'modify'
  | 'create'
  | 'debug'
  | 'explain';

export type AiProjectFile = {
  path: string;
  relativePath: string;
  name: string;
  content: string;
};

export type AiProjectContext = {
  projectRoot: string;
  activeFile: string | null;
  files: AiProjectFile[];
  serialized: string;
};

export type AiRequest = {
  provider: AiProviderId;
  prompt: string;
  purpose: AiRequestPurpose;
  projectContext?: AiProjectContext;
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