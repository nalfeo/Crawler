export interface FreshProcessResult {
  error?: Error;
  status: number | null;
  stdout: string | null;
  stderr: string | null;
}

export function parseFreshProcessResult<T>(
  result: FreshProcessResult,
  marker: string,
  context: string,
): T {
  if (result.error) {
    throw new Error(`${context} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || 'no child output';
    throw new Error(`${context} exited with status ${result.status}: ${detail}`);
  }
  const markerLine = result.stdout?.split(/\r?\n/).find((line) => line.startsWith(marker));
  if (!markerLine) {
    throw new Error(`${context} did not emit result marker ${JSON.stringify(marker)}`);
  }
  try {
    return JSON.parse(markerLine.slice(marker.length)) as T;
  } catch (error) {
    throw new Error(
      `${context} emitted malformed result JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
