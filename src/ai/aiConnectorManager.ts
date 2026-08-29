import {
  AiConnector,
  AiProviderId,
  AiRequest,
  AiResponse,
} from './aiConnector';

export class AiConnectorManager {
  private readonly connectors =
    new Map<AiProviderId, AiConnector>();

  register(
    connector: AiConnector,
  ): void {
    this.connectors.set(
      connector.provider,
      connector,
    );
  }

  unregister(
    provider: AiProviderId,
  ): void {
    this.connectors.delete(
      provider,
    );
  }

  get(
    provider: AiProviderId,
  ): AiConnector | null {
    return (
      this.connectors.get(
        provider,
      ) || null
    );
  }

  has(
    provider: AiProviderId,
  ): boolean {
    return this.connectors.has(
      provider,
    );
  }

  async isAvailable(
    provider: AiProviderId,
  ): Promise<boolean> {
    const connector =
      this.get(provider);

    if (!connector) {
      return false;
    }

    try {
      return await connector.isAvailable();
    } catch {
      return false;
    }
  }

  async send(
    request: AiRequest,
  ): Promise<AiResponse> {
    const connector =
      this.get(request.provider);

    if (!connector) {
      throw new Error(
        `Nenhum conector registrado para ${request.provider}.`,
      );
    }

    return connector.send(
      request,
    );
  }

  async readResponse(
    provider: AiProviderId,
  ): Promise<AiResponse | null> {
    const connector =
      this.get(provider);

    if (!connector) {
      throw new Error(
        `Nenhum conector registrado para ${provider}.`,
      );
    }

    return connector.readResponse();
  }

  getRegisteredProviders(): AiProviderId[] {
    return Array.from(
      this.connectors.keys(),
    );
  }
}