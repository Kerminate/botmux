import type {
  LinkRefExtractionStats,
  LinkRefMode,
  LinkRefSourceInput,
  LinkRefSourceType,
} from '../services/link-ref-types.js';

export const LINK_REF_REGISTER_MAX_BODY_BYTES = 1024 * 1024;

const REGISTER_BODY_KEYS = new Set([
  'sourceType',
  'sourceId',
  'value',
  'originCapability',
  'originTurnId',
  'originDispatchAttempt',
]);

export function emptyLinkRefExtractionStats(): LinkRefExtractionStats {
  return {
    scannedBytes: 0,
    found: 0,
    candidateCount: 0,
    filteredCredential: 0,
    filteredMetadata: 0,
    filteredInvalid: 0,
  };
}

export function parseLinkRefRegistrationBody(
  value: unknown,
): { ok: true; source: LinkRefSourceInput } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return { ok: false };
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !REGISTER_BODY_KEYS.has(key))) return { ok: false };
  if (!Object.hasOwn(body, 'value')) return { ok: false };
  if (body.sourceType !== 'history' && body.sourceType !== 'quoted') return { ok: false };
  if (body.sourceId !== undefined
      && (typeof body.sourceId !== 'string'
        || body.sourceId.length === 0
        || Buffer.byteLength(body.sourceId) > 1024)) {
    return { ok: false };
  }
  return {
    ok: true,
    source: {
      sourceType: body.sourceType,
      kind: 'structured',
      value: body.value,
      ...(typeof body.sourceId === 'string' ? { sourceId: body.sourceId } : {}),
    },
  };
}

export interface CliLinkRefRegistrationPayload {
  sourceType: Extract<LinkRefSourceType, 'history' | 'quoted'>;
  sourceId?: string;
  value: unknown;
}

export interface CliLinkRefRegistrationResult {
  companion?: string;
  stats?: Partial<LinkRefExtractionStats>;
}

export async function decorateCliLinkRefResult<T extends object>(input: {
  mode: LinkRefMode;
  sourceType: Extract<LinkRefSourceType, 'history' | 'quoted'>;
  sourceId?: string;
  value: T;
  register: (payload: CliLinkRefRegistrationPayload) => Promise<CliLinkRefRegistrationResult>;
}): Promise<T | (T & { linkRefs: { companion: string } })> {
  if (input.mode === 'disabled') return input.value;
  try {
    const result = await input.register({
      sourceType: input.sourceType,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      value: input.value,
    });
    if (input.mode !== 'enabled' || !result.companion) return input.value;
    return { ...input.value, linkRefs: { companion: result.companion } };
  } catch {
    return input.value;
  }
}
