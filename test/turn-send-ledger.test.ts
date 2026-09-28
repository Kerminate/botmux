import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';

const key = {
  larkAppId: 'cli_test',
  sessionId: 'session_test',
  turnId: 'turn_test',
  dispatchAttempt: 1,
};

describe('TurnSendLedger', () => {
  it('reuses the first message id for an identical final retry', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      const dispatch = vi.fn(async () => 'om_first');

      await expect(ledger.execute(key, 'final', 'answer with https://example.test/', dispatch))
        .resolves.toEqual({ messageId: 'om_first', replayed: false });
      await expect(ledger.execute(key, 'final', 'answer with https://example.test/', dispatch))
        .resolves.toEqual({ messageId: 'om_first', replayed: true });
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a different final and ordinary progress after final', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      await ledger.execute(key, 'final', 'first answer', async () => 'om_first');
      const dispatch = vi.fn(async () => 'om_late');

      await expect(ledger.execute(key, 'final', 'changed answer', dispatch))
        .rejects.toThrow('different final answer');
      await expect(ledger.execute(key, 'progress', 'late progress', dispatch))
        .rejects.toThrow('finished; progress was not delivered');
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('allows explicitly auxiliary output after final', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      await ledger.execute(key, 'final', 'answer', async () => 'om_first');

      await expect(ledger.execute(key, 'auxiliary', 'supplement', async () => 'om_aux'))
        .resolves.toEqual({ messageId: 'om_aux', replayed: false });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent final sends so only one provider call wins', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      let release!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const first = vi.fn(async () => { await blocked; return 'om_first'; });
      const second = vi.fn(async () => 'om_second');

      const a = ledger.execute(key, 'final', 'same answer', first);
      await new Promise(resolve => setTimeout(resolve, 50));
      const b = ledger.execute(key, 'final', 'same answer', second);
      release();

      await expect(a).resolves.toEqual({ messageId: 'om_first', replayed: false });
      await expect(b).resolves.toEqual({ messageId: 'om_first', replayed: true });
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('treats dispatch attempts of one logical turn as the same final slot', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      const firstDispatch = vi.fn(async () => 'om_first');
      const retryDispatch = vi.fn(async () => 'om_retry');

      await expect(ledger.execute({ ...key, dispatchAttempt: 1 }, 'final', 'same answer', firstDispatch))
        .resolves.toEqual({ messageId: 'om_first', replayed: false });
      await expect(ledger.execute({ ...key, dispatchAttempt: 2 }, 'final', 'same answer', retryDispatch))
        .resolves.toEqual({ messageId: 'om_first', replayed: true });
      expect(firstDispatch).toHaveBeenCalledTimes(1);
      expect(retryDispatch).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('reconciles a crash after provider acceptance with the same stable uuid', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      let acceptedUuid: string | undefined;
      const firstDispatch = vi.fn(async (providerUuid?: string) => {
        acceptedUuid = providerUuid;
        throw new Error('provider accepted but the client lost its response');
      });

      await expect(ledger.execute(key, 'final', 'same answer', firstDispatch))
        .rejects.toThrow('lost its response');
      expect(acceptedUuid).toMatch(/^bts_[a-f0-9]{32}$/);
      expect(readdirSync(ledger.directory).filter(name => name.endsWith('.json'))).toHaveLength(0);

      const retryDispatch = vi.fn(async (providerUuid?: string) => {
        expect(providerUuid).toBe(acceptedUuid);
        return 'om_reconciled';
      });
      await expect(ledger.execute({ ...key, dispatchAttempt: 2 }, 'final', 'same answer', retryDispatch))
        .resolves.toEqual({ messageId: 'om_reconciled', replayed: false });
      expect(retryDispatch).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('resumes known completed non-idempotent steps but refuses an unknown in-flight step', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      const firstAttempt = vi.fn(async (index: number) => {
        if (index === 1) throw new Error('provider response lost');
      });

      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'long answer', 3, firstAttempt, 'doc:comment-1',
      )).rejects.toThrow('provider response lost');
      expect(firstAttempt.mock.calls.map(call => call[0])).toEqual([0, 1]);

      const retry = vi.fn(async () => {});
      await expect(ledger.executeNonIdempotentSequence(
        { ...key, dispatchAttempt: 2 }, 'final', 'long answer', 3, retry, 'doc:comment-1',
      )).rejects.toThrow('delivery of step 2 is unknown');
      expect(retry).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('records a completed non-idempotent sequence as the turn final', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-send-ledger-'));
    try {
      const ledger = new TurnSendLedger(dataDir);
      const firstAttempt = vi.fn(async () => {});

      await expect(ledger.executeNonIdempotentSequence(
        key, 'final', 'long answer', 2, firstAttempt, 'doc:comment-1',
      )).resolves.toEqual({ messageId: 'doc:comment-1', replayed: false });
      expect(firstAttempt.mock.calls.map(call => call[0])).toEqual([0, 1]);

      const retry = vi.fn(async () => {});
      await expect(ledger.executeNonIdempotentSequence(
        { ...key, dispatchAttempt: 2 }, 'final', 'long answer', 2, retry, 'doc:comment-1',
      )).resolves.toEqual({ messageId: 'doc:comment-1', replayed: true });
      expect(retry).not.toHaveBeenCalled();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
