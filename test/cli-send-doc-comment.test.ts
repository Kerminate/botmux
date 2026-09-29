import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const fixture = fileURLToPath(new URL('./fixtures/send-doc-comment-capture.ts', import.meta.url));
const repo = fileURLToPath(new URL('..', import.meta.url));

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-doc-comment-send-'));
  const dataDir = join(root, 'data');
  const sessionId = 'sid_doc_comment_send';
  const turnId = 'turn_doc_comment_send';
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId, turnId }));
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: 'cli_test', larkAppSecret: 'test-secret', cliId: 'codex', replyCardMode: 'legacy',
  }]));
  seedPersistedSessionRows(dataDir, 'cli_test', { [sessionId]: {
    sessionId, status: 'active', cliId: 'codex', larkAppId: 'cli_test',
    chatId: 'doc:doc_test', rootMessageId: 'om_root', scope: 'thread', workingDir: root,
    docCommentTargets: { [turnId]: {
      fileToken: 'doc_test', fileType: 'docx', commentId: 'comment_test', turnId,
    } },
  } });
  const run = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => spawnSyncTsScript(fixture, ['send', '--no-mention', ...args], {
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir,
      BOTS_CONFIG: join(root, 'bots.json'), BOTMUX_SESSION_ID: sessionId,
      BOTMUX_TURN_ID: turnId, BOTMUX_LARK_APP_ID: 'cli_test', ...extraEnv },
    encoding: 'utf8', timeout: 30_000,
  });
  return { root, run };
}

describe('botmux send document-comment response kind', () => {
  it('treats an omitted response kind as the one final document reply', () => {
    const f = createFixture();
    try {
      const result = f.run(['complete answer']);
      const requests = String(result.stdout).split('\n').filter(line => line.startsWith('CAPTURE_DOC_REPLY='));
      expect(result.status, String(result.stderr)).toBe(0);
      expect(requests).toHaveLength(1);
      expect(JSON.parse(String(result.stdout).trim().split('\n').at(-1)!)).toMatchObject({
        success: true,
        kind: 'doc-comment',
      });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects an explicitly non-final document reply with actionable guidance', () => {
    const f = createFixture();
    try {
      const result = f.run(['--response-kind', 'progress', 'interim comment']);
      expect(result.status).toBe(2);
      expect(String(result.stderr)).toContain('文档评论轮只允许一条 final 回复');
      expect(String(result.stderr)).not.toContain('Non-idempotent delivery sequences require a final response');
      expect(String(result.stdout)).not.toContain('CAPTURE_DOC_REPLY=');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('retries after a provider business response proves the first request was not delivered', () => {
    const f = createFixture();
    const rejectOnceMarker = join(f.root, 'reject-once');
    try {
      const first = f.run(['complete answer'], {
        BOTMUX_TEST_DOC_REJECT_ONCE: rejectOnceMarker,
      });
      expect(first.status).toBe(1);
      expect(String(first.stderr)).toContain('User Token');

      const retry = f.run(['complete answer'], {
        BOTMUX_TEST_DOC_REJECT_ONCE: rejectOnceMarker,
      });
      expect(retry.status, String(retry.stderr)).toBe(0);
      expect(String(retry.stdout).split('\n').filter(line => line.startsWith('CAPTURE_DOC_REPLY='))).toHaveLength(1);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
