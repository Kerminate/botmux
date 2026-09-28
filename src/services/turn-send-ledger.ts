import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

export type TurnSendKind = 'progress' | 'final' | 'auxiliary';

export interface TurnSendLedgerKey {
  larkAppId: string;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
}

interface TurnSendLedgerRecord extends TurnSendLedgerKey {
  version: 1;
  nonIdempotentSequence?: {
    fingerprint: string;
    target: string;
    stepCount: number;
    completedSteps: number;
    inFlightStep?: number;
  };
  final?: {
    fingerprint: string;
    messageId: string;
    deliveredAtMs: number;
  };
}

export interface TurnSendLedgerResult {
  messageId: string;
  replayed: boolean;
}

/**
 * Cross-process final-answer fence for every primary `botmux send` path.
 *
 * Reply-card state remains responsible for card rendering and PATCH reuse. This
 * ledger is deliberately payload/route agnostic: once a turn has published a
 * final answer, no other primary route or recipient can mint a second one.
 */
export class TurnSendLedger {
  readonly directory: string;

  constructor(dataDir: string) {
    this.directory = join(dataDir, 'turn-send-ledger');
  }

  id(key: TurnSendLedgerKey): string {
    return createHash('sha256').update(JSON.stringify([
      key.larkAppId,
      key.sessionId,
      key.turnId,
    ])).digest('hex').slice(0, 32);
  }

  private path(key: TurnSendLedgerKey): string {
    return join(this.directory, `${this.id(key)}.json`);
  }

  private fingerprint(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private read(key: TurnSendLedgerKey): TurnSendLedgerRecord | undefined {
    const path = this.path(key);
    if (!existsSync(path)) return undefined;
    const directoryStat = lstatSync(this.directory);
    const fileStat = lstatSync(path);
    if (directoryStat.isSymbolicLink() || fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error('Unsafe turn-send ledger record');
    }
    const record = JSON.parse(readFileSync(path, 'utf8')) as TurnSendLedgerRecord;
    if (record.version !== 1 || this.id(record) !== this.id(key)) {
      throw new Error('Invalid turn-send ledger record');
    }
    if (record.final && (!record.final.fingerprint || !record.final.messageId)) {
      throw new Error('Invalid turn-send final record');
    }
    const sequence = record.nonIdempotentSequence;
    if (sequence && (
      !sequence.fingerprint
      || !sequence.target
      || !Number.isSafeInteger(sequence.stepCount)
      || sequence.stepCount <= 0
      || !Number.isSafeInteger(sequence.completedSteps)
      || sequence.completedSteps < 0
      || sequence.completedSteps > sequence.stepCount
      || (sequence.inFlightStep !== undefined && (
        !Number.isSafeInteger(sequence.inFlightStep)
        || sequence.inFlightStep !== sequence.completedSteps
        || sequence.inFlightStep >= sequence.stepCount
      ))
    )) {
      throw new Error('Invalid turn-send non-idempotent sequence record');
    }
    return record;
  }

  private write(key: TurnSendLedgerKey, record: TurnSendLedgerRecord): void {
    atomicWriteFileSync(this.path(key), JSON.stringify(record), {
      mode: 0o600,
      followTargetSymlink: false,
      durable: true,
    });
  }

  /**
   * Cheap effect-boundary check used before payload preparation that itself may
   * call external providers (TTS/uploads/lookups). `execute` repeats the same
   * decision under the publication lock, so this is an early fail-closed gate,
   * not the concurrency authority.
   */
  async replayOrThrow(
    key: TurnSendLedgerKey,
    kind: TurnSendKind,
    renderedContent: string,
  ): Promise<TurnSendLedgerResult | undefined> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Unsafe turn-send ledger directory');
    return withFileLock(this.path(key), async () => {
      const final = this.read(key)?.final;
      if (!final || kind === 'auxiliary') return undefined;
      if (kind === 'progress') {
        throw new Error('This turn has finished; progress was not delivered');
      }
      if (final.fingerprint !== this.fingerprint(renderedContent)) {
        throw new Error('This turn already delivered a different final answer');
      }
      return { messageId: final.messageId, replayed: true };
    }, { maxWaitMs: 60_000 });
  }

  async execute(
    key: TurnSendLedgerKey,
    kind: TurnSendKind,
    renderedContent: string,
    dispatch: (providerUuid?: string) => Promise<string>,
  ): Promise<TurnSendLedgerResult> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Unsafe turn-send ledger directory');
    return withFileLock(this.path(key), async () => {
      const record = this.read(key) ?? { ...key, version: 1 as const };
      if (!record.final && record.nonIdempotentSequence) {
        const step = record.nonIdempotentSequence.inFlightStep;
        if (step !== undefined) throw new Error(`delivery of step ${step + 1} is unknown`);
        throw new Error('This turn has an incomplete non-idempotent delivery sequence');
      }
      if (record.final && kind !== 'auxiliary') {
        if (kind === 'progress') {
          throw new Error('This turn has finished; progress was not delivered');
        }
        if (record.final.fingerprint !== this.fingerprint(renderedContent)) {
          throw new Error('This turn already delivered a different final answer');
        }
        return { messageId: record.final.messageId, replayed: true };
      }

      const providerUuid = kind === 'final'
        ? `bts_${createHash('sha256').update(`${this.id(key)}:${this.fingerprint(renderedContent)}`).digest('hex').slice(0, 32)}`
        : undefined;
      const messageId = await dispatch(providerUuid);
      if (!messageId && kind === 'final') throw new Error('Missing primary message ID');
      if (kind === 'final') {
        record.final = {
          fingerprint: this.fingerprint(renderedContent),
          messageId,
          deliveredAtMs: Date.now(),
        };
        this.write(key, record);
      }
      return { messageId, replayed: false };
    }, { maxWaitMs: 60_000 });
  }

  /**
   * Checkpoint a sequence whose provider offers no idempotency key (document
   * comment chunks are the current caller). Each step is marked in-flight and
   * durably written before the provider call. If the process loses the
   * response, a retry fails closed at that step: repeating it could duplicate
   * content already accepted by the provider.
   */
  async executeNonIdempotentSequence(
    key: TurnSendLedgerKey,
    kind: TurnSendKind,
    renderedContent: string,
    stepCount: number,
    dispatchStep: (index: number) => Promise<void>,
    messageId: string,
  ): Promise<TurnSendLedgerResult> {
    if (kind !== 'final') throw new Error('Non-idempotent delivery sequences require a final response');
    if (!Number.isSafeInteger(stepCount) || stepCount <= 0) throw new Error('Non-idempotent delivery sequence must contain at least one step');
    if (!messageId) throw new Error('Missing non-idempotent delivery message ID');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Unsafe turn-send ledger directory');
    return withFileLock(this.path(key), async () => {
      const record = this.read(key) ?? { ...key, version: 1 as const };
      const fingerprint = this.fingerprint(renderedContent);
      if (record.final) {
        if (record.final.fingerprint !== fingerprint) {
          throw new Error('This turn already delivered a different final answer');
        }
        return { messageId: record.final.messageId, replayed: true };
      }

      const sequence = record.nonIdempotentSequence ?? {
        fingerprint,
        target: messageId,
        stepCount,
        completedSteps: 0,
      };
      if (sequence.fingerprint !== fingerprint
        || sequence.target !== messageId
        || sequence.stepCount !== stepCount) {
        throw new Error('This turn already started a different non-idempotent delivery sequence');
      }
      record.nonIdempotentSequence = sequence;
      if (sequence.inFlightStep !== undefined) {
        throw new Error(`delivery of step ${sequence.inFlightStep + 1} is unknown`);
      }

      for (let index = sequence.completedSteps; index < stepCount; index++) {
        sequence.inFlightStep = index;
        this.write(key, record);
        await dispatchStep(index);
        sequence.completedSteps = index + 1;
        delete sequence.inFlightStep;
        this.write(key, record);
      }

      record.final = { fingerprint, messageId, deliveredAtMs: Date.now() };
      this.write(key, record);
      return { messageId, replayed: false };
    }, { maxWaitMs: 60_000 });
  }
}
