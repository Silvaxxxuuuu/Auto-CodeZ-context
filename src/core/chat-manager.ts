import crypto from 'node:crypto';
import type { ChatRecord, AIMessage, IntelligenceLevel, PermissionLevel, ProviderId } from '../ai/types';
import { LocalStorage } from './storage';

export const UNCONFIGURED_PROVIDER_ID = 'unconfigured';
export const UNCONFIGURED_MODEL_ID = 'unconfigured';

export class ChatManager {
  private chats: ChatRecord[] = [];
  private readonly persistedChatIds = new Set<string>();
  private lastUpdatedAt = 0;

  constructor(private readonly storage: LocalStorage) {}

  async init(): Promise<void> {
    const stored = await this.storage.read<ChatRecord[]>('chats.json', []);
    this.chats = stored.filter((chat) => chat.messages.length > 0);
    this.persistedChatIds.clear();
    for (const chat of this.chats) this.persistedChatIds.add(chat.id);
    this.lastUpdatedAt = this.chats.reduce((latest, chat) => Math.max(latest, chat.updatedAt, chat.createdAt), 0);
    if (this.chats.length !== stored.length) await this.persist();
  }

  async list(): Promise<ChatRecord[]> {
    return [...this.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private nextTimestamp(): number {
    const now = Date.now();
    this.lastUpdatedAt = Math.max(now, this.lastUpdatedAt + 1);
    return this.lastUpdatedAt;
  }

  private async persist(): Promise<void> {
    await this.storage.write('chats.json', this.chats.filter((chat) => this.persistedChatIds.has(chat.id)));
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
    return chat;
  }

  async update(chat: ChatRecord): Promise<void> {
    const index = this.chats.findIndex((item) => item.id === chat.id);
    if (index < 0) throw new Error('Chat não encontrado.');
    chat.updatedAt = this.nextTimestamp();
    this.chats[index] = chat;
    if (this.persistedChatIds.has(chat.id)) await this.persist();
  }

  async delete(chatId: string): Promise<void> {
    const index = this.chats.findIndex((item) => item.id === chatId);
    if (index < 0) throw new Error('Chat não encontrado.');
    this.chats.splice(index, 1);
    const wasPersisted = this.persistedChatIds.delete(chatId);
    if (wasPersisted) await this.persist();
  }

  async addMessage(chatId: string, message: AIMessage): Promise<ChatRecord> {
    const chat = this.chats.find((item) => item.id === chatId);
    if (!chat) throw new Error('Chat não encontrado.');
    chat.messages.push({ ...message, createdAt: message.createdAt || Date.now() });
    if (message.role === 'user') {
      if (chat.title === 'Novo chat') chat.title = message.content.slice(0, 52) || 'Novo chat';
      this.persistedChatIds.add(chat.id);
    }
    await this.update(chat);
    return chat;
  }
}
