import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));
const refId = 'lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const placeholder = `{{botmux_link:${refId}}}`;
const unknownPlaceholder = '{{botmux_link:lr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}}';
const dacuHost = ['dacu', 'bytedance', 'net'].join('.');
const baseUrl = `https://${dacuHost}/preview_platform/problem`;
const fullUrl = baseUrl
  + '?b=2&a=1&a=&redirect=%2Ffoo%3Fx%3D1#timeline';

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-send-link-ref-'));
  const dataDir = join(root, 'data');
  const sessionId = 'sid_link_ref_send';
  const turnId = 'om_link_ref_send';
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
    sessionId,
    turnId,
    linkRefMode: 'enabled',
  }));
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
  }]));
  seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
    sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
    chatId: 'oc_test', rootMessageId: 'om_root', scope: 'thread', chatType: 'group', workingDir: root,
  } });
  return { root, dataDir, sessionId, turnId };
}

function run(input: {
  args: string[];
  stdin?: string;
  preparedText?: string;
}) {
  const state = fixtureRoot();
  let preparedPath: string | undefined;
  if (input.preparedText !== undefined) {
    preparedPath = join(state.root, 'prepared.md');
    writeFileSync(preparedPath, input.preparedText);
  }
  const result = spawnSyncTsScript(fixture, input.args, {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      HOME: state.root,
      SESSION_DATA_DIR: state.dataDir,
      BOTS_CONFIG: join(state.root, 'bots.json'),
      BOTMUX_SESSION_ID: state.sessionId,
      BOTMUX_TURN_ID: state.turnId,
      BOTMUX_LARK_APP_ID: 'cli_test',
      BOTMUX_DAEMON_IPC_PORT: '7951',
      BOTMUX_TEST_LINK_REF_ID: refId,
      BOTMUX_TEST_LINK_REF_URL: fullUrl,
      ...(preparedPath ? { BOTMUX_CARD_PREPARED_CONTENT_FILE: preparedPath } : {}),
    },
    input: input.stdin,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const lines = String(result.stdout).split('\n');
  const requests = lines.filter(line => line.startsWith('CAPTURE_REPLY='));
  const resolves = lines.filter(line => line.startsWith('CAPTURE_LINK_REF_RESOLVE='));
  return { ...state, preparedPath, result, requests, resolves };
}

describe('botmux send LinkRef expansion', () => {
  it.each([
    ['positional progress', ['send', '--no-mention', '--response-kind', 'progress', `授权：${placeholder}`], undefined],
    ['stdin auxiliary', ['send', '--no-mention', '--response-kind', 'auxiliary'], `授权：${placeholder}`],
  ] as const)('expands exact registered URLs from %s', (_label, args, stdin) => {
    const output = run({ args: [...args], ...(stdin === undefined ? {} : { stdin }) });
    try {
      expect(output.result.status, String(output.result.stderr)).toBe(0);
      expect(output.resolves).toHaveLength(1);
      expect(output.requests).toHaveLength(1);
      expect(output.requests[0]).toContain(fullUrl);
      expect(output.requests[0]).not.toContain(placeholder);
    } finally { rmSync(output.root, { recursive: true, force: true }); }
  });

  it('expands content-file final and validates a LinkRef expected-link after expansion', () => {
    const state = fixtureRoot();
    const contentPath = join(state.root, 'answer.md');
    writeFileSync(contentPath, `授权：${placeholder}`);
    const result = spawnSyncTsScript(fixture, [
      'send', '--no-mention', '--response-kind', 'final',
      '--content-file', contentPath,
      '--expected-link', placeholder,
    ], {
      cwd: repo,
      env: {
        PATH: process.env.PATH, HOME: state.root, SESSION_DATA_DIR: state.dataDir,
        BOTS_CONFIG: join(state.root, 'bots.json'), BOTMUX_SESSION_ID: state.sessionId,
        BOTMUX_TURN_ID: state.turnId, BOTMUX_LARK_APP_ID: 'cli_test',
        BOTMUX_DAEMON_IPC_PORT: '7951', BOTMUX_TEST_LINK_REF_ID: refId,
        BOTMUX_TEST_LINK_REF_URL: fullUrl,
      },
      encoding: 'utf8', timeout: 30_000,
    });
    try {
      const requests = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='));
      expect(result.status, String(result.stderr)).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain(fullUrl);
      expect(readFileSync(contentPath, 'utf8')).toBe(`授权：${placeholder}`);
    } finally { rmSync(state.root, { recursive: true, force: true }); }
  });

  it('expands nested custom-card strings but preserves inline-code literals', () => {
    const card = {
      schema: '2.0',
      body: { elements: [
        { tag: 'markdown', content: `授权：[打开](${placeholder})，示例 \`${placeholder}\`` },
        { tag: 'button', text: { tag: 'plain_text', content: '授权' }, url: placeholder },
        { tag: 'column_set', values: [placeholder] },
      ] },
    };
    const output = run({ args: [
      'send', '--no-mention', '--response-kind', 'auxiliary',
      '--card-json', JSON.stringify(card), '--expected-link', placeholder,
    ] });
    try {
      expect(output.result.status, String(output.result.stderr)).toBe(0);
      expect(output.requests).toHaveLength(1);
      expect(output.requests[0]).toContain(fullUrl);
      expect(output.requests[0]).toContain(placeholder);
    } finally { rmSync(output.root, { recursive: true, force: true }); }
  });

  it('expands prepared Markdown in memory without rewriting its source file', () => {
    const prepared = `授权：${placeholder}`;
    const output = run({
      args: ['send', '--no-mention', '--response-kind', 'auxiliary', 'raw fallback', '--expected-link', placeholder],
      preparedText: prepared,
    });
    try {
      expect(output.result.status, String(output.result.stderr)).toBe(0);
      expect(output.requests[0]).toContain(fullUrl);
      expect(readFileSync(output.preparedPath!, 'utf8')).toBe(prepared);
    } finally { rmSync(output.root, { recursive: true, force: true }); }
  });

  it('leaves an intentional base URL untouched and performs no resolve IPC', () => {
    const output = run({ args: [
      'send', '--no-mention', '--response-kind', 'auxiliary', `入口：${baseUrl}`,
      '--expected-link', baseUrl,
    ] });
    try {
      expect(output.result.status, String(output.result.stderr)).toBe(0);
      expect(output.resolves).toHaveLength(0);
      expect(output.requests[0]).toContain(baseUrl);
      expect(output.requests[0]).not.toContain('?b=2');
    } finally { rmSync(output.root, { recursive: true, force: true }); }
  });

  it('fails closed before provider dispatch for an unknown LinkRef', () => {
    const output = run({ args: [
      'send', '--no-mention', '--response-kind', 'auxiliary', `授权：${unknownPlaceholder}`,
    ] });
    try {
      expect(output.result.status).toBe(2);
      expect(String(output.result.stderr)).toContain('botmux send refused: link_ref_unknown');
      expect(output.requests).toHaveLength(0);
    } finally { rmSync(output.root, { recursive: true, force: true }); }
  });
});
