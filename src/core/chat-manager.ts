import crypto from 'node:crypto';
import type { ChatRecord, AIMessage, IntelligenceLevel, PermissionLevel, ProviderId } from '../ai/types';
import { LocalStorage } from './storage';

export const UNCONFIGURED_PROVIDER_ID = 'unconfigured';
export const UNCONFIGURED_MODEL_ID = 'unconfigured';

export class ChatManager {
  private chats: ChatRecord[] = [];
  private lastUpdatedAt = 0;

  constructor(private readonly storage: LocalStorage) {}

  async init(): Promise<void> {
    const stored = await this.storage.read<ChatRecord[]>('chats.json', []);
    this.chats = stored;
    this.lastUpdatedAt = stored.reduce((latest, chat) => Math.max(latest, chat.updatedAt, chat.createdAt), 0);
  }

  async list(): Promise<ChatRecord[]> {
    return [...this.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private nextTimestamp(): number {
    const now = Date.now();
    this.lastUpdatedAt = Math.max(now, this.lastUpdatedAt + 1);
    return this.lastUpdatedAt;
  }

  async create(input: { title?: string; projectId?: string; providerId?: ProviderId; model?: string; intelligence: IntelligenceLevel; permissionLevel: PermissionLevel }): Promise<ChatRecord> {
    const now = this.nextTimestamp();
    const chat: ChatRecord = {
      id: crypto.randomUUID(),
      title: input.title?.trim() || 'Novo chat',
      projectId: input.projectId,
      providerId: input.providerId || UNCONFIGURED_PROVIDER_ID,
      model: input.model || UNCONFIGURED_MODEL_ID,
      intelligence: input.intelligence,
      permissionLevel: input.permissionLevel,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.chats.unshift(chat);
    await this.storage.write('chats.json', this.chats);
    return chat;
  }

  async update(chat: ChatRecord): Promise<void> {
    const index = this.chats.findIndex((item) => item.id === chat.id);
    if (index < 0) throw new Error('Chat não encontrado.');
    chat.updatedAt = this.nextTimestamp();
    this.chats[index] = chat;
    await this.storage.write('chats.json', this.chats);
  }

  async delete(chatId: string): Promise<void> {
    const index = this.chats.findIndex((item) => item.id === chatId);
    if (index < 0) throw new Error('Chat não encontrado.');
    this.chats.splice(index, 1);
    await this.storage.write('chats.json', this.chats);
  }

  async addMessage(chatId: string, message: AIMessage): Promise<ChatRecord> {
    const chat = this.chats.find((item) => item.id === chatId);
    if (!chat) throw new Error('Chat não encontrado.');
    chat.messages.push({ ...message, createdAt: message.createdAt || Date.now() });
    if (chat.title === 'Novo chat' && message.role === 'user') chat.title = message.content.slice(0, 52) || 'Novo chat';
    await this.update(chat);
    return chat;
  }
}
