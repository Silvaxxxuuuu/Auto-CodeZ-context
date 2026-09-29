import crypto from 'node:crypto';

export type ProgressSignalKind =
  | 'file'
  | 'directory'
  | 'command'
  | 'process'
  | 'instance'
  | 'test'
  | 'build'
  | 'web'
  | 'plan'
  | 'error'
  | 'result'
  | 'source'
  | 'integration'
  | 'plugin';

export type ProgressSignal = {
  kind: ProgressSignalKind;
  key: string;
};

export type ProgressToolCall = {
  name: string;
  input: Record<string, unknown>;
};

export type ProgressObservation = {
  calls: ProgressToolCall[];
  signals?: ProgressSignal[];
  waiting?: 'approval' | 'external';
};

export type ProgressLoopPattern = {
  period: number;
  cycles: number;
};

export type ProgressWatchdogAction = 'continue' | 'replan' | 'stop_loop';

export type ProgressWatchdogDecision = {
  action: ProgressWatchdogAction;
  reason: 'progress' | 'waiting' | 'observing' | 'repeated-pattern' | 'stagnation' | 'loop-after-replan';
  novelSignals: number;
  stagnantRounds: number;
  loopScore: number;
  replanAttempts: number;
  totalObservedRounds: number;
  pattern?: ProgressLoopPattern;
};

export type ProgressWatchdogSnapshot = {
  version: 1;
  seenSignalHashes: string[];
  recentRoundFingerprints: string[];
  stagnantRounds: number;
  loopScore: number;
  replanAttempts: number;
  totalObservedRounds: number;
};

export type ProgressWatchdogOptions = {
  replanLoopScore?: number;
  stagnationRounds?: number;
  maxCyclePeriod?: number;
  historyLimit?: number;
  maxReplansWithoutProgress?: number;
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULTS = {
  replanLoopScore: 4,
  stagnationRounds: 6,
  maxCyclePeriod: 4,
  historyLimit: 16,
  maxReplansWithoutProgress: 1,
} as const;

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableValue(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
      .join(',')}}`;
  }
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' && !Number.isFinite(value)) return JSON.stringify(String(value));
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function toolCallFingerprint(call: ProgressToolCall): string {
  const name = typeof call.name === 'string' ? call.name.trim() : '';
  if (!name) throw new Error('ProgressWatchdog recebeu uma tool call sem nome.');
  return sha256(`${name}:${stableValue(call.input)}`);
}

function roundFingerprint(calls: ProgressToolCall[]): string {
  if (!Array.isArray(calls) || calls.length === 0) return sha256('no-tools');
  return sha256(calls.map(toolCallFingerprint).join('|'));
}

function progressSignalHash(signal: ProgressSignal): string {
  if (!signal || typeof signal !== 'object') throw new Error('ProgressWatchdog recebeu um sinal inválido.');
  const key = typeof signal.key === 'string' ? signal.key.trim() : '';
  if (!key) throw new Error('ProgressWatchdog recebeu um sinal sem chave.');
  return sha256(`${signal.kind}:${key}`);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} deve ser um inteiro >= 1.`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} deve ser um inteiro >= 0.`);
  return value;
}

function detectCycle(history: string[], maxPeriod: number): ProgressLoopPattern | undefined {
  for (let period = 1; period <= Math.min(maxPeriod, Math.floor(history.length / 2)); period += 1) {
    const tailStart = history.length - period;
    const previousStart = tailStart - period;
    let equal = true;
    for (let offset = 0; offset < period; offset += 1) {
      if (history[previousStart + offset] !== history[tailStart + offset]) {
        equal = false;
        break;
      }
    }
    if (!equal) continue;

    let cycles = 2;
    let cursor = previousStart - period;
    while (cursor >= 0) {
      let same = true;
      for (let offset = 0; offset < period; offset += 1) {
        if (history[cursor + offset] !== history[tailStart + offset]) {
          same = false;
          break;
        }
      }
      if (!same) break;
      cycles += 1;
      cursor -= period;
    }
    return { period, cycles };
  }
  return undefined;
}

function cloneSnapshot(snapshot: ProgressWatchdogSnapshot): ProgressWatchdogSnapshot {
  return {
    ...snapshot,
    seenSignalHashes: [...snapshot.seenSignalHashes],
    recentRoundFingerprints: [...snapshot.recentRoundFingerprints],
  };
}

function assertSnapshot(snapshot: ProgressWatchdogSnapshot): void {
  if (!snapshot || snapshot.version !== 1) throw new Error('Snapshot do ProgressWatchdog inválido.');
  if (!Array.isArray(snapshot.seenSignalHashes) || snapshot.seenSignalHashes.some((value) => typeof value !== 'string' || !HASH_PATTERN.test(value))) {
    throw new Error('Snapshot do ProgressWatchdog contém sinais inválidos.');
  }
  if (new Set(snapshot.seenSignalHashes).size !== snapshot.seenSignalHashes.length) {
    throw new Error('Snapshot do ProgressWatchdog contém sinais duplicados.');
  }
  if (!Array.isArray(snapshot.recentRoundFingerprints) || snapshot.recentRoundFingerprints.some((value) => typeof value !== 'string' || !HASH_PATTERN.test(value))) {
    throw new Error('Snapshot do ProgressWatchdog contém fingerprints inválidos.');
  }
  nonNegativeInteger(snapshot.stagnantRounds, 'stagnantRounds');
  nonNegativeInteger(snapshot.loopScore, 'loopScore');
  nonNegativeInteger(snapshot.replanAttempts, 'replanAttempts');
  nonNegativeInteger(snapshot.totalObservedRounds, 'totalObservedRounds');
}

export class ProgressWatchdog {
  private readonly replanLoopScore: number;
  private readonly stagnationRounds: number;
  private readonly maxCyclePeriod: number;
  private readonly historyLimit: number;
  private readonly maxReplansWithoutProgress: number;

  private readonly seenSignalHashes = new Set<string>();
  private recentRoundFingerprints: string[] = [];
  private stagnantRounds = 0;
  private loopScore = 0;
  private replanAttempts = 0;
  private totalObservedRounds = 0;

  constructor(options: ProgressWatchdogOptions = {}) {
    this.replanLoopScore = positiveInteger(options.replanLoopScore ?? DEFAULTS.replanLoopScore, 'replanLoopScore');
    this.stagnationRounds = positiveInteger(options.stagnationRounds ?? DEFAULTS.stagnationRounds, 'stagnationRounds');
    this.maxCyclePeriod = positiveInteger(options.maxCyclePeriod ?? DEFAULTS.maxCyclePeriod, 'maxCyclePeriod');
    this.historyLimit = positiveInteger(options.historyLimit ?? DEFAULTS.historyLimit, 'historyLimit');
    this.maxReplansWithoutProgress = positiveInteger(options.maxReplansWithoutProgress ?? DEFAULTS.maxReplansWithoutProgress, 'maxReplansWithoutProgress');
    if (this.historyLimit < this.maxCyclePeriod * 2) {
      throw new Error('historyLimit precisa comportar pelo menos dois ciclos do maior período observado.');
    }
  }

  observe(observation: ProgressObservation): ProgressWatchdogDecision {
    if (!observation || !Array.isArray(observation.calls)) throw new Error('Observação do ProgressWatchdog inválida.');

    if (observation.waiting) {
      return this.decision('continue', 'waiting', 0);
    }

    this.totalObservedRounds += 1;

    const signalHashes = (observation.signals ?? []).map(progressSignalHash);
    const novelSignalHashes = signalHashes.filter((hash) => !this.seenSignalHashes.has(hash));

    if (novelSignalHashes.length > 0) {
      for (const hash of signalHashes) this.seenSignalHashes.add(hash);
      this.recentRoundFingerprints = [];
      this.stagnantRounds = 0;
      this.loopScore = 0;
      this.replanAttempts = 0;
      return this.decision('continue', 'progress', novelSignalHashes.length);
    }

    for (const hash of signalHashes) this.seenSignalHashes.add(hash);

    const fingerprint = roundFingerprint(observation.calls);
    this.recentRoundFingerprints.push(fingerprint);
    if (this.recentRoundFingerprints.length > this.historyLimit) {
      this.recentRoundFingerprints.splice(0, this.recentRoundFingerprints.length - this.historyLimit);
    }

    this.stagnantRounds += 1;
    const pattern = detectCycle(this.recentRoundFingerprints, this.maxCyclePeriod);
    this.loopScore += 1 + (pattern ? 2 : 0);

    const interventionReason = pattern && this.loopScore >= this.replanLoopScore
      ? 'repeated-pattern'
      : this.stagnantRounds >= this.stagnationRounds
        ? 'stagnation'
        : undefined;

    if (!interventionReason) {
      return this.decision('continue', 'observing', 0, pattern);
    }

    if (this.replanAttempts < this.maxReplansWithoutProgress) {
      this.replanAttempts += 1;
      const decision = this.decision('replan', interventionReason, 0, pattern);
      this.recentRoundFingerprints = [];
      this.stagnantRounds = 0;
      this.loopScore = 0;
      return decision;
    }

    return this.decision('stop_loop', 'loop-after-replan', 0, pattern);
  }

  snapshot(): ProgressWatchdogSnapshot {
    return {
      version: 1,
      seenSignalHashes: [...this.seenSignalHashes].sort(),
      recentRoundFingerprints: [...this.recentRoundFingerprints],
      stagnantRounds: this.stagnantRounds,
      loopScore: this.loopScore,
      replanAttempts: this.replanAttempts,
      totalObservedRounds: this.totalObservedRounds,
    };
  }

  restore(snapshot: ProgressWatchdogSnapshot): void {
    assertSnapshot(snapshot);
    if (snapshot.recentRoundFingerprints.length > this.historyLimit) {
      throw new Error('Snapshot do ProgressWatchdog excede o historyLimit configurado.');
    }
    if (snapshot.replanAttempts > this.maxReplansWithoutProgress) {
      throw new Error('Snapshot do ProgressWatchdog excede o limite de replans configurado.');
    }

    const copy = cloneSnapshot(snapshot);
    this.seenSignalHashes.clear();
    for (const hash of copy.seenSignalHashes) this.seenSignalHashes.add(hash);
    this.recentRoundFingerprints = copy.recentRoundFingerprints;
    this.stagnantRounds = copy.stagnantRounds;
    this.loopScore = copy.loopScore;
    this.replanAttempts = copy.replanAttempts;
    this.totalObservedRounds = copy.totalObservedRounds;
  }

  private decision(
    action: ProgressWatchdogAction,
    reason: ProgressWatchdogDecision['reason'],
    novelSignals: number,
    pattern?: ProgressLoopPattern,
  ): ProgressWatchdogDecision {
    return {
      action,
      reason,
      novelSignals,
      stagnantRounds: this.stagnantRounds,
      loopScore: this.loopScore,
      replanAttempts: this.replanAttempts,
      totalObservedRounds: this.totalObservedRounds,
      ...(pattern ? { pattern: { ...pattern } } : {}),
    };
  }
}
