import type { LinkRefLedger } from './link-ref-ledger.js';
import { LinkRefError, type LinkRefTurnKey } from './link-ref-types.js';

const LINK_REF_SOURCE = String.raw`\{\{botmux_link:(lr_[0-9a-f]{32})\}\}`;
const LINK_REF_PATTERN = new RegExp(LINK_REF_SOURCE, 'g');
const FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})(.*)$/u;

interface RefSpan {
  start: number;
  end: number;
  refId: string;
  escaped: boolean;
}

export interface ExecutableLinkRefs {
  refIds: string[];
  expand(resolved: ReadonlyMap<string, string>): string;
}

export interface OutboundLinkRefPayload {
  text?: string;
  preparedText?: string;
  card?: Record<string, unknown>;
  expectedLinks?: string[];
}

export interface ResolvedOutboundLinkRefs extends OutboundLinkRefPayload {
  refCount: number;
}

function countRun(text: string, index: number, char: '`'): number {
  let end = index;
  while (text[end] === char) end += 1;
  return end - index;
}

function lineEnd(text: string, index: number): number {
  const newline = text.indexOf('\n', index);
  return newline < 0 ? text.length : newline;
}

function tokenize(text: string): RefSpan[] {
  const spans: RefSpan[] = [];
  let offset = 0;
  let fence: { char: '`' | '~'; length: number } | undefined;
  let inlineTicks = 0;

  while (offset < text.length) {
    const end = lineEnd(text, offset);
    const line = text.slice(offset, end);
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fence) {
      if (fenceMatch) {
        const run = fenceMatch[2]!;
        const char = run[0] as '`' | '~';
        if (char === fence.char && run.length >= fence.length && fenceMatch[3]!.trim() === '') {
          fence = undefined;
        }
      }
      offset = end < text.length ? end + 1 : end;
      continue;
    }
    if (fenceMatch && inlineTicks === 0) {
      const run = fenceMatch[2]!;
      fence = { char: run[0] as '`' | '~', length: run.length };
      offset = end < text.length ? end + 1 : end;
      continue;
    }

    for (let index = offset; index < end;) {
      if (text[index] === '`') {
        const run = countRun(text, index, '`');
        if (inlineTicks === 0) inlineTicks = run;
        else if (run === inlineTicks) inlineTicks = 0;
        index += run;
        continue;
      }
      LINK_REF_PATTERN.lastIndex = index;
      const match = LINK_REF_PATTERN.exec(text);
      if (!match || match.index >= end) break;
      for (; index < match.index;) {
        if (text[index] === '`') {
          const run = countRun(text, index, '`');
          if (inlineTicks === 0) inlineTicks = run;
          else if (run === inlineTicks) inlineTicks = 0;
          index += run;
        } else {
          index += 1;
        }
      }
      const slashCount = (() => {
        let count = 0;
        for (let cursor = match.index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) count += 1;
        return count;
      })();
      const escaped = slashCount % 2 === 1;
      if (inlineTicks === 0) {
        spans.push({
          start: escaped ? match.index - 1 : match.index,
          end: LINK_REF_PATTERN.lastIndex,
          refId: match[1]!,
          escaped,
        });
      }
      index = LINK_REF_PATTERN.lastIndex;
    }
    offset = end < text.length ? end + 1 : end;
  }
  return spans;
}

export function findExecutableLinkRefs(text: string): ExecutableLinkRefs {
  const spans = tokenize(text);
  const refIds = [...new Set(spans.filter((span) => !span.escaped).map((span) => span.refId))];
  return {
    refIds,
    expand(resolved) {
      if (spans.length === 0) return text;
      let output = '';
      let cursor = 0;
      for (const span of spans) {
        output += text.slice(cursor, span.start);
        if (span.escaped) {
          output += text.slice(span.start + 1, span.end);
        } else {
          const value = resolved.get(span.refId);
          if (value === undefined) throw new LinkRefError('link_ref_unknown');
          output += value;
        }
        cursor = span.end;
      }
      return output + text.slice(cursor);
    },
  };
}

function walkStrings(value: unknown, replace: (text: string) => string): unknown {
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map((entry) => walkStrings(entry, replace));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walkStrings(entry, replace)]));
}

function validExpectedLink(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function tokenizeOutboundPayload(payload: OutboundLinkRefPayload): Map<string, ExecutableLinkRefs> {
  const tokenized = new Map<string, ExecutableLinkRefs>();
  const getTokenized = (text: string): ExecutableLinkRefs => {
    const existing = tokenized.get(text);
    if (existing) return existing;
    const found = findExecutableLinkRefs(text);
    tokenized.set(text, found);
    return found;
  };
  if (payload.text !== undefined) getTokenized(payload.text);
  if (payload.preparedText !== undefined) getTokenized(payload.preparedText);
  if (payload.expectedLinks) for (const expectedLink of payload.expectedLinks) getTokenized(expectedLink);
  if (payload.card) walkStrings(payload.card, (text) => { getTokenized(text); return text; });
  return tokenized;
}

export function findOutboundExecutableLinkRefs(payload: OutboundLinkRefPayload): string[] {
  return [...new Set(
    [...tokenizeOutboundPayload(payload).values()].flatMap((entry) => entry.refIds),
  )];
}

export function expandOutboundLinkRefs(
  payload: OutboundLinkRefPayload,
  resolved: ReadonlyMap<string, string>,
): ResolvedOutboundLinkRefs {
  const tokenized = tokenizeOutboundPayload(payload);
  const getTokenized = (text: string): ExecutableLinkRefs => tokenized.get(text)
    ?? findExecutableLinkRefs(text);
  const replace = (text: string): string => getTokenized(text).expand(resolved);
  const expectedLinks = payload.expectedLinks?.map(replace);
  if (expectedLinks?.some((value) => !validExpectedLink(value))) {
    throw new LinkRefError('expected_link_invalid_after_link_ref');
  }
  return {
    ...(payload.text === undefined ? {} : { text: replace(payload.text) }),
    ...(payload.preparedText === undefined ? {} : { preparedText: replace(payload.preparedText) }),
    ...(payload.card === undefined ? {} : { card: walkStrings(payload.card, replace) as Record<string, unknown> }),
    ...(expectedLinks === undefined ? {} : { expectedLinks }),
    refCount: findOutboundExecutableLinkRefs(payload).length,
  };
}

export function resolveOutboundLinkRefs(
  ledger: LinkRefLedger,
  key: LinkRefTurnKey,
  payload: OutboundLinkRefPayload,
): ResolvedOutboundLinkRefs {
  const refIds = findOutboundExecutableLinkRefs(payload);
  const resolved = refIds.length === 0 ? new Map<string, string>() : ledger.resolveBatch(key, refIds);
  return expandOutboundLinkRefs(payload, resolved);
}
