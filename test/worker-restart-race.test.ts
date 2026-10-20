/**
 * worker.ts is a process entrypoint (installs IPC/signal handlers on import),
 * so — like worker-durable-expiry-order.test.ts — pin the exact wiring of
 * PR #507's two restart-race fixes by asserting source structure. The pure
 * decision they feed is executed in restart-followup-policy.test.ts; these
 * assertions guard the ordering/guards that a refactor could silently break.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function restartCaseBranch(): string {
  const start = workerSource.indexOf("case 'restart': {");
  const end = workerSource.indexOf("case 'expire_durable_turn':", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workerSource.slice(start, end);
}

describe('worker restart P1 — drain reliable terminal before ambiguous emit', () => {
  it('the restart case delegates durable settle to settleDurableTurnForRestart with drain wired before emit', () => {
    const branch = restartCaseBranch();
    const call = branch.indexOf('settleDurableTurnForRestart({');
    expect(call).toBeGreaterThanOrEqual(0);
    const deps = branch.slice(call, branch.indexOf('});', call) + 3);
    // the settle orchestration (unit-tested in restart-followup-policy.test.ts)
    // enforces drain → re-check → emit; here just pin that the restart case
    // injects the right callbacks so a just-completed turn claims the deduper.
    const drain = deps.indexOf('drainReliableTerminalBeforeInterrupt()');
    const emit = deps.indexOf("emitTurnTerminal(currentBotmuxTurnId!, 'ambiguous'");
    const isStill = deps.indexOf('isStillInFlight:');
    expect(drain).toBeGreaterThanOrEqual(0);
    expect(emit).toBeGreaterThan(0);
    expect(isStill).toBeGreaterThan(0);
    // the drain callback is declared before the emitAmbiguous callback in deps.
    expect(emit).toBeGreaterThan(drain);
  });

  it('the shared drain helper is gated on reliableTurnTerminal (matches onExit)', () => {
    const fn = workerSource.indexOf('function drainReliableTerminalBeforeInterrupt');
    expect(fn).toBeGreaterThanOrEqual(0);
    const body = workerSource.slice(fn, fn + 600);
    expect(body).toContain("cliAdapter?.reliableTurnTerminal !== true");
    expect(body).toContain('bridgeDrainAndMaybeEmit()');
    expect(body).toContain('codexBridgeDrainAndMaybeEmit');
  });

  it('onExit reuses the same shared drain helper (no divergent duplicate)', () => {
    // Both the CLI onExit path and the restart IPC path must drain identically;
    // the shared helper is the single source, so onExit calls it too.
    const onExitAmbiguous = workerSource.search(/'ambiguous',\n\s+'cli_exit'/);
    expect(onExitAmbiguous).toBeGreaterThan(0);
    const before = workerSource.slice(onExitAmbiguous - 400, onExitAmbiguous);
    expect(before).toContain('drainReliableTerminalBeforeInterrupt()');
  });
});

describe('worker restart P2 — merge guard + replacement-exit recovery (no spurious re-restart)', () => {
  it('retains a coalesced cwd update without replacing the active correlated restart attempt', () => {
    const branch = restartCaseBranch();
    const cwdUpdate = branch.indexOf('if (msg.updateWorkingDir && lastInitConfig)');
    const guard = branch.indexOf('if (cliRestartInProgress || tmuxRestartTimer)');
    const attempt = branch.indexOf('activeRestartAttemptId = msg.attemptId;', guard);
    const freshness = branch.indexOf("codexRunnerFreshness = 'restarting_fresh';", attempt);

    expect(cwdUpdate).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(cwdUpdate);
    expect(attempt).toBeGreaterThan(guard);
    expect(freshness).toBeGreaterThan(attempt);
    // The in-flight branch exits before touching the correlated attempt. This
    // lets a role-switch cwd update join a manual restart without stealing its
    // eventual prompt-ready result.
    expect(branch.slice(guard, attempt)).toContain('break;');
  });

  it('the merge guard plainly breaks — it does NOT arm any "restart requested" flag', () => {
    const branch = restartCaseBranch();
    const guard = branch.indexOf('if (cliRestartInProgress || tmuxRestartTimer)');
    const brk = branch.indexOf('break;', guard);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(brk).toBeGreaterThan(guard);
    // Codex-2 regression guard: a source-carrying flag would misread a healthy
    // duplicate /restart as a crash and force a budget-burning re-restart.
    expect(workerSource).not.toContain('pendingRestartAfterInFlight');
    expect(workerSource).not.toContain('restartRequestedDuringInFlight');
  });

  it('the continuation feeds ONLY backend liveness + cwd into decideRestartFollowup', () => {
    const start = workerSource.indexOf('async function restartCliProcess');
    const end = workerSource.indexOf('// ─── HTTP', start);
    const body = workerSource.slice(start, end);
    const decide = body.indexOf('decideRestartFollowup({');
    expect(decide).toBeGreaterThan(0);
    const call = body.slice(decide, decide + 260);
    expect(call).toContain('backendAlive: !!backend');
    expect(call).toContain('currentWorkingDir: lastInitConfig?.workingDir');
    // recovery must NOT depend on any merged-request signal.
    expect(call).not.toContain('restartRequestedDuringInFlight');
  });
});

describe('#1863 correlated restart receipts', () => {
  function fnBody(signature: string): string {
    const fn = workerSource.indexOf(signature);
    expect(fn).toBeGreaterThanOrEqual(0);
    return workerSource.slice(fn, workerSource.indexOf('\n}\n', fn));
  }

  it('the merge guard folds the restart into the window by value; adoption never displaces an owner', () => {
    const branch = restartCaseBranch();
    const guard = branch.indexOf('if (cliRestartInProgress || tmuxRestartTimer)');
    const fold = branch.indexOf('foldRestartIntoWindow(msg.attemptId);', guard);
    expect(fold).toBeGreaterThan(guard);
    expect(fold).toBeLessThan(branch.indexOf('break;', guard));
    const body = fnBody('function foldRestartIntoWindow(');
    expect(body).toContain('const requested = restartLaunchSettings(lastInitConfig);');
    expect(body).toContain('windowLaunch: restartWindowLaunch');
    expect(body).toContain('convergencePending: !!pendingLaunchConvergence');
    // converge → pending (never the owner); otherwise adopt only if unowned.
    const converge = body.indexOf("if (disposition === 'converge') {");
    const pending = body.indexOf('pendingLaunchConvergence = { attemptId: attemptId ?? pendingLaunchConvergence?.attemptId, requested };', converge);
    const adopt = body.indexOf('activeRestartAttemptId ??= attemptId;', pending);
    expect(converge).toBeGreaterThan(0);
    expect(pending).toBeGreaterThan(converge);
    expect(body.slice(pending, adopt)).toContain('return;');
    expect(adopt).toBeGreaterThan(pending);
    // A fresh (non-merged) restart drops a leftover pending request.
    const fresh = branch.indexOf('pendingLaunchConvergence = undefined;', branch.indexOf('break;', guard));
    expect(fresh).toBeGreaterThan(0);
    expect(fresh).toBeLessThan(branch.indexOf('activeRestartAttemptId = msg.attemptId;', guard));
  });

  it('each restart window captures its launch snapshot with restartCfg and hands it any pending request', () => {
    const start = workerSource.indexOf('async function restartCliProcess');
    const body = workerSource.slice(start, workerSource.indexOf('// ─── HTTP', start));
    const reset = body.indexOf('restartWindowLaunch = undefined;');
    const cfg = body.indexOf('const restartCfg = { ...lastInitConfig');
    const snap = body.indexOf('restartWindowLaunch = restartLaunchSettings(restartCfg);', cfg);
    const adopt = body.indexOf('adoptPendingLaunchConvergence();', snap);
    expect(reset).toBeGreaterThan(0);
    expect(cfg).toBeGreaterThan(reset);
    expect(body.slice(cfg, snap)).not.toContain('await ');
    expect(adopt).toBeGreaterThan(snap);
    expect(adopt).toBeLessThan(body.indexOf('await spawnCli(restartCfg', cfg));
    const upgrade = fnBody('async function autoUpgradeCodex(');
    const upReset = upgrade.indexOf('restartWindowLaunch = undefined;');
    const upCfg = upgrade.indexOf('const restartCfg = restoreCfg(launch);');
    const upSnap = upgrade.indexOf('restartWindowLaunch = restartLaunchSettings(restartCfg);', upCfg);
    expect(upReset).toBeGreaterThan(0);
    expect(upReset).toBeLessThan(upgrade.indexOf('await Promise.race('));
    expect(upSnap).toBeGreaterThan(upCfg);
    expect(upSnap).toBeLessThan(upgrade.indexOf('await spawnCli(restartCfg'));
  });

  it('the continuation converges a pending folded request before settling anything', () => {
    const start = workerSource.indexOf('async function restartCliProcess');
    const body = workerSource.slice(start, workerSource.indexOf('// ─── HTTP', start));
    const decide = body.indexOf('decideRestartFollowup({');
    const call = body.slice(decide, body.indexOf('});', decide));
    expect(call).toContain('spawnedLaunch,');
    expect(call).toContain('requestedLaunch: pendingLaunchConvergence?.requested,');
    const followup = body.indexOf("if (followup.kind !== 'none') {", decide);
    const adoptForFollowup = body.indexOf('adoptPendingLaunchConvergence();', followup);
    const respawn = body.indexOf('void restartCliProcess(reason', followup);
    expect(adoptForFollowup).toBeGreaterThan(followup);
    expect(respawn).toBeGreaterThan(adoptForFollowup);
    const ret = body.indexOf('return;', respawn);
    const adoptSatisfied = body.indexOf('adoptPendingLaunchConvergence();', ret);
    const settle = body.indexOf("settleRestartAttemptOnReady('restart continuation finished at the prompt'", ret);
    expect(adoptSatisfied).toBeGreaterThan(ret);
    expect(settle).toBeGreaterThan(adoptSatisfied);
  });

  it('a fatal worker error fails a pending folded attempt too', () => {
    const body = fnBody('async function sendFatalWorkerErrorAndExit(');
    expect(body).toContain('const pendingAttemptId = pendingLaunchConvergence?.attemptId;');
    expect(body.indexOf('pendingLaunchConvergence = undefined;')).toBeLessThan(body.indexOf("type: 'error'"));
  });

  it('every success receipt goes through settleRestartAttemptOnReady, gated on an `emit` decision', () => {
    const body = fnBody('function settleRestartAttemptOnReady(');
    const decide = body.indexOf('decideRestartReceipt({');
    const call = body.slice(decide, body.indexOf('});', decide));
    expect(call).toContain('backendInstalled: !!backend');
    expect(call).toContain('upgradeInFlight: !!codexAutoUpgrade');
    const emitGate = body.indexOf("if (receipt === 'emit') {", decide);
    const republish = body.indexOf("if (opts.republishPromptReady) send({ type: 'prompt_ready' });", emitGate);
    const success = body.indexOf("category: 'prompt_ready'", emitGate);
    expect(emitGate).toBeGreaterThan(decide);
    // Off the ready edge, the daemon's cliReady comes back before the receipt.
    expect(republish).toBeGreaterThan(emitGate);
    expect(success).toBeGreaterThan(republish);
    // No other success receipt anywhere in the worker.
    expect(workerSource.split("category: 'prompt_ready'").length - 1).toBe(1);
    expect(fnBody('function markPromptReady(): void {')).toContain("settleRestartAttemptOnReady('prompt-ready');");
  });

  it('the restart continuation settles (and republishes prompt_ready for) an attempt adopted after the ready edge', () => {
    const start = workerSource.indexOf('async function restartCliProcess');
    const body = workerSource.slice(start, workerSource.indexOf('// ─── HTTP', start));
    const followup = body.indexOf("if (followup.kind !== 'none') {");
    const settle = body.indexOf("settleRestartAttemptOnReady('restart continuation finished at the prompt', { republishPromptReady: true });");
    expect(followup).toBeGreaterThan(0);
    // Only on the converged path: a pending follow-up respawn returns first.
    expect(settle).toBeGreaterThan(body.indexOf('return;', followup));
    expect(body.slice(body.lastIndexOf('\n', settle - 40), settle)).toContain('if (isPromptReady) {');
  });

  it('a Codex auto-upgrade converges through restore passes that share one upgrade context', () => {
    const body = fnBody('async function autoUpgradeCodex(');
    // One explicit context every pass inherits.
    const ctx = body.indexOf('const upgradeContext = {');
    const ctxBody = body.slice(ctx, body.indexOf('} as const;', ctx));
    expect(ctxBody).toContain('executable: target.path');
    expect(ctxBody).toContain('version: target.version');
    expect(ctxBody).toContain('killOptions: { preservePending: true, preservePolicyCapability: true, preserveInjections: true }');
    const cfgFn = body.slice(body.indexOf('const restoreCfg = ('), body.indexOf('});', body.indexOf('const restoreCfg = (')));
    expect(cfgFn).toContain('cliSessionId: upgradeContext.threadId');
    expect(cfgFn).toContain('cliPathOverride: upgradeContext.executable');
    // Every pass: teardown with the context's kill options, exact-resume stage,
    // spawn, ready, then runtime + thread verification.
    const pass = body.slice(body.indexOf('const restorePass = async'), body.indexOf('return replacement;'));
    const kill = pass.indexOf('killCli(upgradeContext.killOptions);');
    const restoring = pass.indexOf("codexAutoUpgrade!.stage = 'restoring';", kill);
    const spawn = pass.indexOf('await spawnCli(restartCfg', restoring);
    const verify = pass.indexOf('item.version !== upgradeContext.version', spawn);
    expect(kill).toBeGreaterThan(0);
    expect(restoring).toBeGreaterThan(kill);
    expect(spawn).toBeGreaterThan(restoring);
    expect(verify).toBeGreaterThan(spawn);
    expect(body).not.toContain('killCli({');
    // Convergence is another restore pass, never the ordinary restart path.
    expect(body).not.toContain('restartCliProcess(');
    const loop = body.indexOf('stopping = await restorePass(pass, launch, stopping);');
    const decide = body.indexOf('decideUpgradeLaunchConvergence({', loop);
    const limit = body.indexOf('if (pass >= MAX_RESTORE_PASSES) {', decide);
    expect(loop).toBeGreaterThan(0);
    expect(decide).toBeGreaterThan(loop);
    expect(limit).toBeGreaterThan(decide);
    const settle = body.indexOf("if (isPromptReady) settleRestartAttemptOnReady('Codex auto-upgrade verified', { republishPromptReady: true });", limit);
    expect(settle).toBeGreaterThan(limit);
    const catchAt = body.indexOf('} catch (error) {', settle);
    const failPending = body.indexOf('failPendingLaunchConvergence();', catchAt);
    const failed = body.indexOf("status: 'failed',", catchAt);
    expect(failPending).toBeGreaterThan(catchAt);
    expect(failed).toBeGreaterThan(failPending);
  });
});
