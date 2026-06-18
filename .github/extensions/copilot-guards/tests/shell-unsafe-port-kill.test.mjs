import test from 'node:test';
import assert from 'node:assert/strict';

import guard from '../guards/shell-unsafe-port-kill.mjs';

const ctx = {
  cwd: 'C:\\Users\\nalfeo\\.copilot\\repos\\copilot-worktrees\\Crawler\\nalfeo-example',
};

function run(command, extraCtx = ctx) {
  return guard.check({ command }, extraCtx);
}

test('denies shared-port Stop-Process lookup without workspace scoping', () => {
  const result = run(
    '$ports = @(3000,3010); $pids = Get-NetTCPConnection -LocalPort $ports -State Listen | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($pid in $pids) { Stop-Process -Id $pid -Force }',
  );
  assert.equal(result.decision, 'deny');
});

test('denies broad crawler process scans without workspace scoping', () => {
  const result = run(
    "$extraPids = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { ($_.CommandLine -match 'Crawler') -and ($_.CommandLine -match 'vite|lab|sidecar') } | Select-Object -ExpandProperty ProcessId; foreach ($pid in $extraPids) { Stop-Process -Id $pid -Force }",
  );
  assert.equal(result.decision, 'deny');
});

test('allows shared-port cleanup when command is scoped to current workspace', () => {
  const result = run(
    '$cwd = "C:\\Users\\nalfeo\\.copilot\\repos\\copilot-worktrees\\Crawler\\nalfeo-example"; $pids = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$cwd*" } | Select-Object -ExpandProperty ProcessId; foreach ($pid in $pids) { Stop-Process -Id $pid -Force }',
  );
  assert.equal(result.decision, 'allow');
});

test('allows non-legacy port cleanup', () => {
  const result = run(
    '$pids = Get-NetTCPConnection -LocalPort 4451 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($pid in $pids) { Stop-Process -Id $pid -Force }',
  );
  assert.equal(result.decision, 'allow');
});

test('matches only powershell port-kill style commands', () => {
  assert.equal(
    guard.matches('powershell', {
      command: 'Get-NetTCPConnection -LocalPort 3000 | Stop-Process -Id 1',
    }),
    true,
  );
  assert.equal(guard.matches('bash', { command: 'lsof -ti :3000 | xargs kill -9' }), false);
  assert.equal(
    guard.matches('powershell', { command: 'Get-NetTCPConnection -LocalPort 3000' }),
    false,
  );
});
