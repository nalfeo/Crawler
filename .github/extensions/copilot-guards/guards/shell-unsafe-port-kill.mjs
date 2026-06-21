import path from 'node:path';

import { normalizeCommand } from '../lib/shell.mjs';

const LEGACY_SHARED_PORTS = [3000, 3001, 3002, 3003, 3010, 5173];

function normalizePath(value) {
  return value.toLowerCase().replaceAll('/', '\\');
}

function normalizeWorkspacePath(value) {
  if (!value) {
    return '';
  }
  const trimmed = String(value).trim();
  return normalizePath(resolveWorkspacePath(trimmed));
}

function resolveWorkspacePath(value) {
  const trimmed = String(value).trim();
  return path.win32.isAbsolute(trimmed) ? path.win32.normalize(trimmed) : path.resolve(trimmed);
}

function segmentTargetsLegacySharedPorts(segment) {
  return LEGACY_SHARED_PORTS.some((port) => new RegExp(`\\b${port}\\b`).test(segment));
}

function segmentScopesToCurrentWorkspace(segment, cwd) {
  if (!cwd) {
    return false;
  }
  const normalizedSegment = normalizePath(segment);
  const normalizedCwd = normalizeWorkspacePath(cwd);
  return normalizedSegment.includes(normalizedCwd);
}

function denyReason(segment, cwd) {
  const currentCwd = cwd ? resolveWorkspacePath(cwd) : '(unknown)';
  return (
    'Refusing to kill listeners or Crawler processes by shared port/process scan without ' +
    `scoping the selection to this session workspace. Current workspace: \`${currentCwd}\`. ` +
    `Detected segment: \`${segment}\`. Use the per-session derived ports, or filter the target ` +
    'process command line by the current workspace before calling Stop-Process.'
  );
}

function commandUsesPortOwnershipLookup(command) {
  return (
    /\bGet-NetTCPConnection\b/i.test(command) &&
    /\bOwningProcess\b/i.test(command) &&
    /\bStop-Process\b/i.test(command)
  );
}

function commandUsesBroadCrawlerProcessScan(command) {
  return (
    /\bGet-CimInstance\b/i.test(command) &&
    /\bWin32_Process\b/i.test(command) &&
    /\bCommandLine\b/i.test(command) &&
    /\bCrawler\b/i.test(command) &&
    /\bStop-Process\b/i.test(command)
  );
}

export default {
  id: 'shell-unsafe-port-kill',
  category: 'shell',
  failClosed: true,
  matches(toolName, toolArgs) {
    if (toolName !== 'powershell') return false;
    const cmd = String(toolArgs?.command || '');
    return (
      /\bStop-Process\b/i.test(cmd) &&
      (/\bGet-NetTCPConnection\b/i.test(cmd) || /\bWin32_Process\b/i.test(cmd))
    );
  },
  check(toolArgs, ctx) {
    const cmd = String(toolArgs?.command || '');
    const segments = normalizeCommand(cmd);
    const fullCommand = segments.join(' ; ');

    if (
      commandUsesPortOwnershipLookup(fullCommand) &&
      segmentTargetsLegacySharedPorts(fullCommand) &&
      !segmentScopesToCurrentWorkspace(fullCommand, ctx.cwd)
    ) {
      return { decision: 'deny', reason: denyReason(fullCommand, ctx.cwd) };
    }

    if (
      commandUsesBroadCrawlerProcessScan(fullCommand) &&
      !segmentScopesToCurrentWorkspace(fullCommand, ctx.cwd)
    ) {
      return { decision: 'deny', reason: denyReason(fullCommand, ctx.cwd) };
    }

    return { decision: 'allow' };
  },
};
