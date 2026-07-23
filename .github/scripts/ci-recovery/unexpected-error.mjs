export function createUnexpectedErrorHandler({ cleanup, writeError = console.error }) {
  let handled = false;
  return (reason) => {
    if (handled) return;
    handled = true;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    Promise.resolve()
      .then(() => cleanup?.())
      .catch((cleanupError) => {
        writeError(`CI recovery unexpected-error cleanup failed: ${cleanupError?.stack || cleanupError}`);
      })
      .finally(() => {
        writeError(`CI recovery failed unexpectedly: ${error.stack || error}`);
        process.exitCode = 1;
      });
  };
}
