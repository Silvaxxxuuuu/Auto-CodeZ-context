import crypto from 'node:crypto';
import type { ChatRecord, AIMessage, IntelligenceLevel, PermissionLevel, ProviderId } from '../ai/types';
import { LocalStorage } from './storage';

export class ChatManager {
  private chats: ChatRecord[] = [];

  constructor(private readonly storage: LocalStorage) {}

  async init(): Promise<void> {
    const stored = await this.storage.read<ChatRecord[]>('chats.json', []);
    this.chats = stored.filter((chat) => chat.messages.length > 0);
  }

  async list(): Promise<ChatRecord[]> {
    return [...this.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(input: { title?: string; projectId?: string; providerId: ProviderId; model: string; intelligence: IntelligenceLevel; permissionLevel: PermissionLevel }): Promise<ChatRecord> {
    const now = Date.now();
    const chat: ChatRecord = { id: crypto.randomUUID(), title: input.title?.trim() || 'Novo chat', projectId: input.projectId, providerId: input.providerId, model: input.model, intelligence: input.intelligence, permissionLevel: input.permissionLevel, messages: [], createdAt: now, updatedAt: now };
    this.chats.unshift(chat);
    return chat;
  }

  async update(chat: ChatRecord): Promise<void> {
    const index = this.chats.findIndex((item) => item.id === chat.id);
    if (index < 0) throw new Error('Chat não encontrado.');
    chat.updatedAt = Date.now();
    this.chats[index] = chat;
    const persisted = this.chats.filter((item) => item.messages.length > 0);
    await this.storage.write('chats.json', persisted);
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
