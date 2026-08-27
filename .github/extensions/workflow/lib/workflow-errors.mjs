/**
 * HTTP status mapping for workflow mutation failures.
 *
 * Locally-raised validation failures are `CanvasError`s, which carry a `code`
 * but no HTTP `status`. Defaulting every such failure to 502 would report a
 * caller mistake (missing field, unknown item, wrong stage) as an upstream
 * gateway failure, so known local codes map to 4xx and only genuine sidecar /
 * Azure failures fall through to 502.
 */

/** Known local `CanvasError` codes raised by the workflow routes. */
const LOCAL_ERROR_STATUS = new Map([
  ['bad-request', 400],
  ['item-not-found', 404],
  ['item_not_found', 404],
  ['not_found', 404],
  ['not_open', 404],
  ['missing-brief', 409],
  ['missing-run', 409],
  ['invalid-stage', 409],
]);

/**
 * Resolve the response status for a thrown workflow error.
 * A sidecar error's own HTTP `status` always wins; then the local code map;
 * then 502 for an unrecognised (genuinely upstream) failure.
 */
export function workflowErrorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  return LOCAL_ERROR_STATUS.get(error?.code) ?? 502;
}
