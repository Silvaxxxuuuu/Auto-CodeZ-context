import { OperationalLedger, type OperationalLedgerEvent, type OperationalLedgerPage, type OperationalLedgerQuery } from './operational-ledger';

export type OperationalLedgerScope = Pick<OperationalLedgerQuery, 'chatId' | 'runId' | 'projectId' | 'sessionId' | 'pluginId'>;

export type OperationalSessionSummary = {
  eventCount: number;
  firstSequence?: number;
  lastSequence?: number;
  startedAt?: number;
  updatedAt?: number;
  lastState?: string;
  categories: Record<string, number>;
  tools: Array<{ name: string; count: number; failures: number }>;
  resources: string[];
  artifactIds: string[];
  sourceRefs: string[];
  errors: string[];
  diff: { files: number; addedLines: number; removedLines: number };
};

function matchesScope(event: OperationalLedgerEvent, scope: OperationalLedgerScope): boolean {
  if (scope.chatId !== undefined && event.chatId !== scope.chatId) return false;
  if (scope.runId !== undefined && event.runId !== scope.runId) return false;
  if (scope.projectId !== undefined && event.projectId !== scope.projectId) return false;
  if (scope.sessionId !== undefined && event.sessionId !== scope.sessionId) return false;
  if (scope.pluginId !== undefined && event.pluginId !== scope.pluginId) return false;
  return true;
}

function boundedLimit(limit: number | undefined, fallback: number, maximum: number): number {
  const value = limit ?? fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error('Limite de recuperação do ledger inválido.');
  return value;
}

function pageFromEvents(events: OperationalLedgerEvent[], limit: number): OperationalLedgerPage {
  const selected = events.slice(0, limit).map((event) => structuredClone(event));
  return {
    events: selected,
    ...(selected.length ? { firstSequence: selected[0].sequence, lastSequence: selected[selected.length - 1].sequence } : {}),
    hasMore: events.length > selected.length,
  };
}

export class OperationalLedgerRetrieval {
  constructor(private readonly ledger: OperationalLedger) {}

  sessionSummary(scope: OperationalLedgerScope): OperationalSessionSummary {
    const events = this.ledger.listAll().filter((event) => matchesScope(event, scope));
    const categories: Record<string, number> = {};
    const tools = new Map<string, { name: string; count: number; failures: number }>();
    const resources = new Set<string>();
    const artifactIds = new Set<string>();
    const sourceRefs = new Set<string>();
    const errors: string[] = [];
    let addedLines = 0;
    let removedLines = 0;
    const changedResources = new Set<string>();

    for (const event of events) {
      categories[event.category] = (categories[event.category] ?? 0) + 1;
      if (event.toolName) {
        const current = tools.get(event.toolName) ?? { name: event.toolName, count: 0, failures: 0 };
        current.count += 1;
        if (event.state === 'failed') current.failures += 1;
        tools.set(event.toolName, current);
      }
      for (const resource of event.resources ?? []) {
        resources.add(resource);
        if (event.diff) changedResources.add(resource);
      }
      for (const artifactId of event.artifactIds ?? []) artifactIds.add(artifactId);
      for (const source of event.sourceRefs ?? []) sourceRefs.add(source);
      if (event.error) errors.push(event.error);
      if (event.diff) {
        addedLines += event.diff.addedLines;
        removedLines += event.diff.removedLines;
      }
    }

    const first = events[0];
    const last = events.at(-1);
    return {
      eventCount: events.length,
      ...(first ? { firstSequence: first.sequence, startedAt: first.timestamp } : {}),
      ...(last ? { lastSequence: last.sequence, updatedAt: last.timestamp, lastState: last.state } : {}),
      categories,
      tools: [...tools.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)).slice(0, 64),
      resources: [...resources].slice(0, 256),
      artifactIds: [...artifactIds].slice(0, 256),
      sourceRefs: [...sourceRefs].slice(0, 128),
      errors: errors.slice(-32).reverse(),
      diff: {
        files: changedResources.size,
        addedLines,
        removedLines,
      },
    };
  }

  recentEvents(scope: OperationalLedgerScope, limit?: number, beforeSequence?: number): OperationalLedgerPage {
    return this.ledger.query({
      ...scope,
      ...(beforeSequence !== undefined ? { beforeSequence } : {}),
      limit: boundedLimit(limit, 50, 500),
      direction: 'backward',
    });
  }

  changes(scope: OperationalLedgerScope, limit?: number, beforeSequence?: number): OperationalLedgerPage {
    const maximum = boundedLimit(limit, 50, 200);
    const events = this.filteredRecent(scope, beforeSequence, (event) => Boolean(event.diff || event.resources?.length));
    return pageFromEvents(events, maximum);
  }

  errors(scope: OperationalLedgerScope, limit?: number, beforeSequence?: number): OperationalLedgerPage {
    const maximum = boundedLimit(limit, 50, 200);
    const events = this.filteredRecent(scope, beforeSequence, (event) => event.state === 'failed' || Boolean(event.error));
    return pageFromEvents(events, maximum);
  }

  artifacts(scope: OperationalLedgerScope, limit?: number, beforeSequence?: number): OperationalLedgerPage {
    const maximum = boundedLimit(limit, 50, 200);
    const events = this.filteredRecent(scope, beforeSequence, (event) => Boolean(event.artifactIds?.length));
    return pageFromEvents(events, maximum);
  }

  sources(scope: OperationalLedgerScope, limit?: number, beforeSequence?: number): OperationalLedgerPage {
    const maximum = boundedLimit(limit, 50, 200);
    const events = this.filteredRecent(scope, beforeSequence, (event) => Boolean(event.sourceRefs?.length));
    return pageFromEvents(events, maximum);
  }

  private filteredRecent(
    scope: OperationalLedgerScope,
    beforeSequence: number | undefined,
    predicate: (event: OperationalLedgerEvent) => boolean,
  ): OperationalLedgerEvent[] {
    if (beforeSequence !== undefined && (!Number.isInteger(beforeSequence) || beforeSequence < 1)) throw new Error('Cursor do ledger inválido.');
    return this.ledger.listAll()
      .filter((event) => matchesScope(event, scope))
      .filter((event) => beforeSequence === undefined || event.sequence < beforeSequence)
      .filter(predicate)
      .reverse();
  }
}
