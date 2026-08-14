import log, { type LogLevelDesc, type Logger as LogLevelLogger } from 'loglevel';

const ROOT_LOGGER = 'crawler';
const STORAGE_KEY = 'crawler.logLevel';
const levelNames = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;

export type LogLevel = (typeof levelNames)[number];
export type Logger = Pick<
  LogLevelLogger,
  'trace' | 'debug' | 'info' | 'warn' | 'error' | 'setLevel' | 'getLevel'
>;

export const DEFAULT_LOG_BUFFER_SIZE = 500;
let logBufferLimit = DEFAULT_LOG_BUFFER_SIZE;
let nextLogSequence = 0;
const logBuffer: Array<{ sequence: number; line: string }> = [];

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function captureLog(scope: string, level: LogLevel, args: unknown[]): void {
  const line = `[${level}] ${scope} ${args.map(formatLogValue).join(' ')}`;
  logBuffer.push({ sequence: nextLogSequence++, line });
  while (logBuffer.length > logBufferLimit) {
    logBuffer.shift();
  }
}

function captureIfEnabled(
  logger: LogLevelLogger,
  scope: string,
  level: LogLevel,
  args: unknown[],
): void {
  if (logger.getLevel() <= log.levels[level.toUpperCase() as keyof typeof log.levels]) {
    captureLog(scope, level, args);
  }
}

export interface LogCursor {
  readonly sequence: number;
}

export function createLogCursor(): LogCursor {
  return { sequence: nextLogSequence };
}

export function readLogsSince(cursor: LogCursor): string[] {
  return logBuffer.filter((entry) => entry.sequence >= cursor.sequence).map((entry) => entry.line);
}

export function setLogBufferLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Log buffer limit must be a positive integer, got ${limit}`);
  }
  logBufferLimit = limit;
  while (logBuffer.length > logBufferLimit) {
    logBuffer.shift();
  }
}

function toLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return levelNames.find((name) => name === normalized);
}

function safeReadStorageLevel(): LogLevel | undefined {
  if (typeof window === 'undefined' || !window.localStorage) {
    return undefined;
  }

  try {
    return toLogLevel(window.localStorage.getItem(STORAGE_KEY) ?? undefined);
  } catch {
    return undefined;
  }
}

function safeWriteStorageLevel(level: LogLevel): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // Ignore storage failures (e.g. private mode quota errors).
  }
}

function envValue(key: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    const processValue = process.env[key];
    if (processValue) {
      return processValue;
    }
  }

  type EnvMeta = ImportMeta & { env?: Record<string, string | undefined> };
  const importMeta = import.meta as EnvMeta;
  const value = importMeta.env?.[key];
  return value || undefined;
}

function queryParamLevel(): LogLevel | undefined {
  if (typeof window === 'undefined' || !window.location) {
    return undefined;
  }
  return toLogLevel(new URLSearchParams(window.location.search ?? '').get('logLevel') ?? undefined);
}

/**
 * CI defaults to warn-level logs to keep automated output concise.
 */
function isQuietLoggingEnvironment(): boolean {
  return (
    envValue('VITEST') === 'true' || envValue('NODE_ENV') === 'test' || envValue('CI') === 'true'
  );
}

function initialLevel(): LogLevel {
  return (
    queryParamLevel() ??
    safeReadStorageLevel() ??
    toLogLevel(envValue('VITE_LOG_LEVEL')) ??
    toLogLevel(envValue('LOG_LEVEL')) ??
    (isQuietLoggingEnvironment() ? 'warn' : 'info')
  );
}

const rootLogger = log.getLogger(ROOT_LOGGER);
rootLogger.setLevel(initialLevel(), false);
const scopedLoggers = new Set<LogLevelLogger>();

export function createLogger(scope: string): Logger {
  const loggerName = `${ROOT_LOGGER}:${scope}`;
  const logger = log.getLogger(loggerName);
  logger.setLevel(rootLogger.getLevel(), false);
  scopedLoggers.add(logger);
  return {
    trace: (...args) => {
      captureIfEnabled(logger, scope, 'trace', args);
      logger.trace(...args);
    },
    debug: (...args) => {
      captureIfEnabled(logger, scope, 'debug', args);
      logger.debug(...args);
    },
    info: (...args) => {
      captureIfEnabled(logger, scope, 'info', args);
      logger.info(...args);
    },
    warn: (...args) => {
      captureIfEnabled(logger, scope, 'warn', args);
      logger.warn(...args);
    },
    error: (...args) => {
      captureIfEnabled(logger, scope, 'error', args);
      logger.error(...args);
    },
    setLevel: logger.setLevel.bind(logger),
    getLevel: logger.getLevel.bind(logger),
  };
}

export function setGlobalLogLevel(level: LogLevel): void {
  rootLogger.setLevel(level as LogLevelDesc, false);
  for (const logger of scopedLoggers) {
    logger.setLevel(level as LogLevelDesc, false);
  }
  safeWriteStorageLevel(level);
}

export function getGlobalLogLevel(): LogLevel {
  const level = rootLogger.getLevel();
  if (Number.isInteger(level) && level >= 0 && level < levelNames.length) {
    return levelNames[level];
  }
  return 'info';
}
