/**
 * Worker wiring for the per-session sandbox tree on a detach-style exit.
 *
 * The real lifecycle (tmux / PTY × oncall / scratch / credential-only, daemon
 * restart and transfer) is exercised in
 * sandbox-relay-lifecycle.integration.test.ts, which needs tmux + bwrap and
 * skips without them. These source-shape checks keep the single decision point
 * pinned on every runner.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function functionBody(signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('\n}\n', start));
}

describe('sandbox tree on a detach-style worker exit', () => {
  it('decides "outlives the worker" once, after every flavour established its tree', () => {
    const decision = 'const sandboxTreeOutlivesPane = sandboxTreeSurvivesWorkerExit({';
    const at = source.indexOf(decision);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(source.indexOf(decision, at + 1)).toBe(-1);
    expect(source.slice(at, source.indexOf('});', at))).toContain('ownsTree: sandboxCleanup !== null');
    // Every spawn-time tree handle (oncall, scratch Linux/macOS, credential-only;
    // fresh or reattach) is taken before the decision reads it.
    const spawnStart = source.indexOf('async function spawnCli(');
    const spawnEnd = source.indexOf('\nfunction killCli(', spawnStart);
    const handles = [...source.slice(spawnStart, spawnEnd).matchAll(/sandboxCleanup = (?:sbx|att|credentialRelay)\.cleanup;/g)];
    expect(handles.length).toBeGreaterThanOrEqual(8);
    for (const handle of handles) expect(spawnStart + handle.index!).toBeLessThan(at);
    // Applied in spawnCli (reattach up front; armed once the pane exists; a
    // failed fresh launch whose pane is not proven gone; cleared by a post-spawn
    // failure exit only after proving the pane gone) and reset by killCli;
    // nothing else re-derives a second rule.
    expect([...source.matchAll(/^\s+sandboxTreeOutlivesWorker = /gm)]).toHaveLength(5);
    expect(source).toContain('sandboxTreeOutlivesWorker = !retireFailedFreshPersistentPane();');
    expect(functionBody('function killCli(')).toContain('sandboxTreeOutlivesWorker = false;');
  });

  it('arms preservation as soon as the pane exists; post-spawn failure exits clear it only for a pane proven gone', () => {
    const decisionAt = source.indexOf('const sandboxTreeOutlivesPane = sandboxTreeSurvivesWorkerExit({');
    // Before the pane is created only a warm reattach (live pane) keeps it, so a
    // fresh launch that fails before creating it rolls the tree back.
    const preSpawn = source.indexOf('sandboxTreeOutlivesWorker = willReattachPersistent && sandboxTreeOutlivesPane;');
    expect(preSpawn).toBeGreaterThan(decisionAt);
    const spawnAt = source.indexOf('backend.spawn(spawnBin, spawnArgs, {', preSpawn);
    expect(spawnAt).toBeGreaterThan(preSpawn);
    // Armed right after the spawn returns — BEFORE the provenance commit and the
    // Codex App generation finalize, both of which can fail with the pane alive.
    const armAt = source.indexOf('sandboxTreeOutlivesWorker = sandboxTreeOutlivesPane;', spawnAt);
    const commitAt = source.indexOf('if (pendingProvenanceCommit) {', spawnAt);
    const finalizeAt = source.indexOf('finalizeCodexAppControlGeneration(\n', spawnAt);
    expect(armAt).toBeGreaterThan(spawnAt);
    expect(armAt).toBeLessThan(commitAt);
    expect(armAt).toBeLessThan(finalizeAt);
    expect(source.slice(spawnAt, armAt)).not.toMatch(/\bawait\b/);
    // tearDownAndRefuse (late-flip reattach / commit failure): cleared only after
    // the post-kill probe proved `missing`.
    const teardownAt = source.indexOf('const tearDownAndRefuse = (why: string): never => {', armAt);
    const teardown = source.slice(teardownAt, source.indexOf('\n    };\n', teardownAt));
    const missingGate = teardown.indexOf("if (postKill !== 'missing') {");
    const clearAt = teardown.indexOf('sandboxTreeOutlivesWorker = false;');
    expect(missingGate).toBeGreaterThan(0);
    expect(clearAt).toBeGreaterThan(missingGate);
    // Codex App finalize failure: kill, then clear only on an authoritative probe.
    const finalizeCatch = source.slice(finalizeAt, source.indexOf('    throw err;\n  }\n', finalizeAt));
    expect(finalizeCatch).toContain("if (probeOwnPersistentPane() === 'missing') sandboxTreeOutlivesWorker = false;");
  });

  it('a fresh launch that fails after creating its pane retires exactly that pane before rolling back', () => {
    const at = source.indexOf('const retireFailedFreshPersistentPane = (): boolean => {');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = source.slice(at, source.indexOf('\n  };\n', at));
    expect(body).toContain('retireSessionCreatedBySpawn?.()');
    // Only an authoritative `missing` lets the tree go.
    expect(body).toMatch(/if \(probe === 'missing'\) \{[\s\S]*?return true;/);
    expect(body.trimEnd().endsWith('return false;')).toBe(true);
    const catchAt = source.indexOf('sandboxTreeOutlivesWorker = !retireFailedFreshPersistentPane();');
    expect(source.slice(catchAt - 600, catchAt)).toContain('if (!willReattachPersistent && sandboxTreeOutlivesPane) {');
  });

  it('a parent-exit shutdown preserves the tree exactly when the pane outlives the worker', () => {
    const body = functionBody('function shutdownWorkerForParentExit(');
    expect(body).toContain('const preserveSandbox = sandboxTreeOutlivesWorker;');
    expect(body).toContain('killCli({ preserveSandbox });');
  });

  it('a crashed worker keeps the tree of a pane that is still running', () => {
    const body = functionBody('function teardownSandboxBestEffort(');
    expect(body).toMatch(/if \(!sandboxTreeOutlivesWorker\) \{\s*try \{ sandboxCleanup\?\.\(\); \}/);
    // The watcher and this generation's capability leaf still go away.
    expect(body).toContain('sandboxStopWatcher?.()');
    expect(body).toContain('unlinkManagedOriginCapabilityFiles();');
  });

  it('never recreates the oncall outbox on a warm reattach', () => {
    expect(source).toContain('if (outbox && !willReattachPersistent) {');
    const armAt = source.indexOf('const att = attachSandboxOutbox({ sessionId: cfg.sessionId, dataDir });');
    expect(armAt).toBeGreaterThanOrEqual(0);
    expect(source.slice(armAt, armAt + 400)).toContain('refusing to reattach session');
  });
});
