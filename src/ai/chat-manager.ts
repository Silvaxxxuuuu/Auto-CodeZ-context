import crypto from 'node:crypto';
import type { AIMessage, ChatRecord, IntelligenceLevel, PermissionLevel } from './types';

const STATE_FILE = 'chats.json';

interface ChatStorage { read<T>(name: string, fallback: T): Promise<T>; write<T>(name: string, value: T): Promise<void>; }

function titleFromMessage(content: string): string {
  const value = content.trim().replace(/\s+/g, ' ');
  return value ? value.slice(0, 64) : 'Novo chat';
}

export class ChatManager {
  private chats: ChatRecord[] = [];

  constructor(private readonly storage: ChatStorage) {}

  async init(): Promise<void> {
    const stored = await this.storage.read<ChatRecord[]>(STATE_FILE, []);
    this.chats = Array.isArray(stored) ? stored : [];
  }

  async list(): Promise<ChatRecord[]> { return this.chats.map((chat) => ({ ...chat, messages: [...chat.messages] })); }

  async create(input: { providerId?: string; model?: string; intelligence: string; permissionLevel: string; projectId?: string }): Promise<ChatRecord> {
    const now = Date.now();
    const chat: ChatRecord = {
      id: crypto.randomUUID(),
      title: 'Novo chat',
      providerId: input.providerId || 'unconfigured',
      model: input.model || '',
      intelligence: input.intelligence as IntelligenceLevel,
      permissionLevel: input.permissionLevel as PermissionLevel,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.chats.unshift(chat);
    await this.persist();
    return { ...chat, messages: [] };
  }

  async addMessage(chatId: string, message: AIMessage): Promise<ChatRecord> {
    const chat = this.require(chatId);
    chat.messages.push(message);
    if (message.role === 'user' && chat.title === 'Novo chat') chat.title = titleFromMessage(message.content);
    chat.updatedAt = Date.now();
    await this.persist();
    return { ...chat, messages: [...chat.messages] };
  }

  async update(chat: ChatRecord): Promise<ChatRecord> {
    const index = this.chats.findIndex((item) => item.id === chat.id);
    if (index < 0) throw new Error('Chat não encontrado.');
    const next = { ...chat, messages: [...chat.messages], updatedAt: Date.now() };
    this.chats[index] = next;
    await this.persist();
    return { ...next, messages: [...next.messages] };
  }

  async updateSettings(input: { chatId: string; providerId: string; model: string; intelligence: string; permissionLevel: string }): Promise<ChatRecord> {
    const chat = this.require(input.chatId);
    chat.providerId = input.providerId;
    chat.model = input.model;
    chat.intelligence = input.intelligence as IntelligenceLevel;
    chat.permissionLevel = input.permissionLevel as PermissionLevel;
    chat.updatedAt = Date.now();
    await this.persist();
    return { ...chat, messages: [...chat.messages] };
  }

  async rename(chatId: string, title: string): Promise<ChatRecord> {
    const chat = this.require(chatId);
    const normalized = title.trim().replace(/\s+/g, ' ');
    if (!normalized) throw new Error('O nome do chat não pode ficar vazio.');
    if (normalized.length > 80) throw new Error('O nome do chat deve ter no máximo 80 caracteres.');
    chat.title = normalized;
    chat.updatedAt = Date.now();
    await this.persist();
    return { ...chat, messages: [...chat.messages] };
  }

  async remove(chatId: string): Promise<ChatRecord[]> {
    this.chats = this.chats.filter((chat) => chat.id !== chatId);
    await this.persist();
    return this.list();
  }

  private require(chatId: string): ChatRecord {
    const chat = this.chats.find((item) => item.id === chatId);
    if (!chat) throw new Error('Chat não encontrado.');
    return chat;
  }

  private async persist(): Promise<void> { await this.storage.write(STATE_FILE, this.chats); }
}
