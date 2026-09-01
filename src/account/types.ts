export type AccountId = string;
export type DeviceId = string;
export type SessionId = string;
export type SyncOperationId = string;

export type IdentityProvider = 'email' | 'google' | 'github';

export interface AccountProfile {
  id: AccountId;
  email: string;
  displayName: string;
  avatarUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AccountSession {
  id: SessionId;
  accountId: AccountId;
  deviceId: DeviceId;
  identityProvider: IdentityProvider;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface DeviceRecord {
  id: DeviceId;
  accountId?: AccountId;
  name: string;
  platform: NodeJS.Platform;
  appVersion: string;
  createdAt: number;
  lastSeenAt: number;
  isCurrent: boolean;
  sessionId?: SessionId;
}

export type SyncEntityType =
  | 'chat'
  | 'chat_history'
  | 'configuration'
  | 'preference'
  | 'library_item'
  | 'project'
  | 'backup'
  | 'integration'
  | 'device'
  | 'account_metadata';

export type SyncOperation = 'create' | 'update' | 'delete';
export type SyncStatus = 'pending' | 'in_flight' | 'synced' | 'failed' | 'conflict';

export interface SyncQueueItem<TPayload = unknown> {
  id: SyncOperationId;
  entityType: SyncEntityType;
  entityId: string;
  operation: SyncOperation;
  deviceId: DeviceId;
  baseRevision: number;
  localRevision: number;
  payload: TPayload;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  status: Exclude<SyncStatus, 'synced' | 'conflict'>;
  lastError?: string;
}

export interface SyncConflict<TPayload = unknown> {
  id: string;
  entityType: SyncEntityType;
  entityId: string;
  localDeviceId: DeviceId;
  remoteDeviceId: DeviceId;
  localRevision: number;
  remoteRevision: number;
  localPayload: TPayload;
  remotePayload: TPayload;
  createdAt: number;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface SyncRevision {
  entityType: SyncEntityType;
  entityId: string;
  revision: number;
  deviceId: DeviceId;
  updatedAt: number;
}

export interface SyncSnapshot {
  status: 'offline' | 'synchronized' | 'syncing' | 'pending' | 'error' | 'conflict';
  pendingCount: number;
  conflictCount: number;
  lastSuccessfulSyncAt?: number;
  lastError?: string;
}
