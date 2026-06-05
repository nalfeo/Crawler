import log, { type LogLevelDesc, type Logger as LogLevelLogger } from 'loglevel';

const ROOT_LOGGER = 'crawler';
const STORAGE_KEY = 'crawler.logLevel';
const levelNames = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;

export type LogLevel = (typeof levelNames)[number];
export type Logger = Pick<
  LogLevelLogger,
  'trace' | 'debug' | 'info' | 'warn' | 'error' | 'setLevel' | 'getLevel'
>;

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

function initialLevel(): LogLevel {
  const isTestEnv =
    envValue('VITEST') === 'true' || envValue('NODE_ENV') === 'test' || envValue('CI') === 'true';
  return (
    queryParamLevel() ??
    safeReadStorageLevel() ??
    toLogLevel(envValue('VITE_LOG_LEVEL')) ??
    toLogLevel(envValue('LOG_LEVEL')) ??
    (isTestEnv ? 'warn' : 'info')
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
  return logger;
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
