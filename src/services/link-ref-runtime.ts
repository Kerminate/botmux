import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CliTurnPayload } from '../types.js';
import { addCodexAppContext } from '../utils/codex-app-context.js';
import { collectLinkRefCandidates } from './link-ref-extractor.js';
import { LinkRefLedger } from './link-ref-ledger.js';
import { renderLinkRefCompanion } from './link-ref-presenter.js';
import {
  findExecutableLinkRefs,
  resolveOutboundLinkRefs,
  type OutboundLinkRefPayload,
  type ResolvedOutboundLinkRefs,
} from './link-ref-resolver.js';
import {
  LinkRefError,
  type LinkRefDiagnostic,
  type LinkRefExtractionStats,
  type LinkRefMode,
  type LinkRefSourceInput,
  type LinkRefTurnKey,
} from './link-ref-types.js';

export interface LinkRefRuntime {
  prepareTurn(input: {
    key: LinkRefTurnKey;
    mode: LinkRefMode;
    payload: CliTurnPayload;
  }): CliTurnPayload;
  registerSources(input: {
    key: LinkRefTurnKey;
    mode: 'observe' | 'enabled';
    sources: readonly LinkRefSourceInput[];
  }): { companion?: string; stats: LinkRefExtractionStats };
  resolveForDaemon(
    key: LinkRefTurnKey,
    mode: LinkRefMode,
    payload: OutboundLinkRefPayload,
  ): ResolvedOutboundLinkRefs;
  restoreMode(key: LinkRefTurnKey): 'enabled' | undefined;
  prepareFinalDraft(input: {
    key: LinkRefTurnKey;
    mode: LinkRefMode;
    content: string;
  }): { content: string; draftPending: boolean };
  clearPendingDraft(key: LinkRefTurnKey): void;
  settleTurn(key: LinkRefTurnKey): void;
  deleteSession(appId: string, sessionId: string): number;
  pruneExpired(nowMs?: number): { expired: number; removed: number };
  recordDiagnostic(event: LinkRefDiagnostic): void;
  close(): void;
}

export function createLinkRefRuntime(
  dataDir: string,
  deps: {
    ledger?: () => LinkRefLedger;
    onDiagnostic?: (event: LinkRefDiagnostic) => void;
  } = {},
): LinkRefRuntime {
  let openedLedger: LinkRefLedger | undefined;
  const ledger = (): LinkRefLedger => {
    openedLedger ??= deps.ledger?.() ?? new LinkRefLedger(dataDir);
    return openedLedger;
  };
  const recordDiagnostic = (event: LinkRefDiagnostic): void => {
    deps.onDiagnostic?.(event);
  };
  const runtime: LinkRefRuntime = {
    prepareTurn({ key, mode, payload }) {
      const sources = payload.linkRefs?.sources ?? [];
      if (mode === 'disabled') {
        const { linkRefs: _linkRefs, ...legacy } = payload;
        return legacy;
      }
      const frozen: CliTurnPayload = { ...payload, linkRefs: { mode } };
      if (sources.length === 0) return frozen;
      const result = runtime.registerSources({ key, mode, sources });
      if (mode !== 'enabled' || !result.companion) return frozen;
      const additionalContext = { ...frozen.codexAppInput?.additionalContext };
      if (frozen.codexAppInput) {
        addCodexAppContext(additionalContext, 'botmux_link_refs', result.companion, 'untrusted');
      }
      return {
        ...frozen,
        content: `${frozen.content}\n\n${result.companion}`,
        ...(frozen.codexAppInput
          ? { codexAppInput: { ...frozen.codexAppInput, additionalContext } }
          : {}),
      };
    },
    registerSources({ key, mode, sources }) {
      const extraction = collectLinkRefCandidates(sources);
      if (mode === 'observe') {
        recordDiagnostic({
          mode,
          scannedBytes: extraction.stats.scannedBytes,
          found: extraction.stats.found,
          filtered: extraction.stats.filteredCredential + extraction.stats.filteredMetadata + extraction.stats.filteredInvalid,
        });
        return { stats: extraction.stats };
      }
      if (extraction.candidates.length === 0) return { stats: extraction.stats };
      try {
        const store = ledger();
        store.openTurn(key);
        const registration = store.registerBatch(key, extraction.candidates);
        recordDiagnostic({
          mode,
          scannedBytes: extraction.stats.scannedBytes,
          found: extraction.stats.found,
          registered: registration.registered.length,
          deduplicated: registration.deduplicated,
          limited: registration.filteredByLimit,
          ...(registration.failure ? { errorCode: registration.failure } : {}),
        });
        const companion = renderLinkRefCompanion(registration.registered);
        return { ...(companion ? { companion } : {}), stats: extraction.stats };
      } catch (error) {
        recordDiagnostic({
          mode,
          found: extraction.stats.found,
          outcome: 'registration_failed',
          errorCode: typeof error === 'object' && error && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'link_ref_ledger_unavailable',
        });
        return { stats: extraction.stats };
      }
    },
    resolveForDaemon(key, mode, payload) {
      if (mode === 'disabled' || mode === 'observe') return { ...payload, refCount: 0 };
      return resolveOutboundLinkRefs(ledger(), key, payload);
    },
    restoreMode(key) {
      if (!openedLedger && !deps.ledger
        && !existsSync(join(dataDir, 'link-refs', 'link-refs.sqlite'))) return undefined;
      const row = ledger().readTurn(key);
      return row?.mode === 'enabled' && row.state === 'open' && row.expiresAtMs > Date.now()
        ? 'enabled'
        : undefined;
    },
    prepareFinalDraft({ key, mode, content }) {
      if (mode !== 'enabled') return { content, draftPending: false };
      const executable = findExecutableLinkRefs(content);
      if (executable.refIds.length === 0) {
        return { content: executable.expand(new Map()), draftPending: false };
      }
      const store = ledger();
      let draft: string;
      try {
        const persisted = store.readPendingDraft(key);
        draft = persisted ?? content;
        if (persisted === undefined) store.savePendingDraft(key, draft);
      } catch {
        throw new LinkRefError('link_ref_ledger_unavailable');
      }
      try {
        const resolved = resolveOutboundLinkRefs(store, key, { text: draft });
        return { content: resolved.text ?? draft, draftPending: true };
      } catch (error) {
        if (error instanceof LinkRefError) throw error;
        throw new LinkRefError('link_ref_ledger_unavailable');
      }
    },
    clearPendingDraft(key) {
      openedLedger?.clearPendingDraft(key);
    },
    settleTurn(key) {
      openedLedger?.settleTurn(key);
    },
    deleteSession(appId, sessionId) {
      return openedLedger?.deleteSession(appId, sessionId) ?? 0;
    },
    pruneExpired(nowMs) {
      return openedLedger?.pruneExpired(nowMs) ?? { expired: 0, removed: 0 };
    },
    recordDiagnostic,
    close() {
      openedLedger?.close();
      openedLedger = undefined;
    },
  };
  return runtime;
}

let currentRuntime: LinkRefRuntime | undefined;

export function setLinkRefRuntime(runtime: LinkRefRuntime | undefined): void {
  currentRuntime = runtime;
}

export function getLinkRefRuntime(): LinkRefRuntime | undefined {
  return currentRuntime;
}

export function initializeLinkRefRuntime(dataDir: string): LinkRefRuntime {
  const runtime = createLinkRefRuntime(dataDir);
  currentRuntime?.close();
  currentRuntime = runtime;
  return runtime;
}

export function closeLinkRefRuntime(): void {
  currentRuntime?.close();
  currentRuntime = undefined;
}
