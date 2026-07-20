/**
 * postprocess-handoff.mjs — pure deep-link builder for the "Open in
 * Post-process Debugger" jump from the Workflow canvas.
 *
 * PLATFORM CONSTRAINT: a canvas iframe has no privileged bridge to the host
 * (see `renderer.mjs` header) — it can only talk to ITS OWN loopback HTTP
 * server. There is no documented SDK surface that lets iframe script content
 * (or even the extension's own Node process) trigger `canvas.open` for a
 * DIFFERENT canvas; only the agent can do that, via the `open_canvas` tool.
 * So "open" here follows the SAME deep-link convention this codebase already
 * uses for the identical cross-canvas jump problem (see AGENTS.md's Sweep
 * Results Viewer `project:sweep-results-viewer runId=<run-id>` convention):
 * this builds a `project:postprocess ...` deep-link STRING carrying the exact
 * handoff context (briefId, runId, sheet, variantIndex), which the renderer
 * copies to the clipboard / exposes in a selectable field for the operator to
 * paste into chat, where the host resolves it to an actual `open_canvas` call
 * with that input. It is deliberately NOT an inert bare URL: every field the
 * postprocess canvas's `inputSchema` accepts is carried, verbatim, so pasting
 * it opens/focuses postprocess pre-seeded on the exact variant being reviewed.
 *
 * Self-contained (no imports/closures) so `Function.prototype.toString()`
 * yields a runnable declaration for `renderer.mjs` to splice into the browser
 * client script.
 *
 * @module workflow/postprocess-handoff
 */

/**
 * @param {{briefId:string, runId:string, sheet?:string|null, variantIndex?:number|null}} context
 * @returns {string}
 */
export function buildPostprocessDeepLink(context) {
  var ctx = context || {};
  var parts = ['project:postprocess'];
  if (ctx.briefId) parts.push('briefId=' + encodeURIComponent(ctx.briefId));
  if (ctx.runId) parts.push('runId=' + encodeURIComponent(ctx.runId));
  if (ctx.sheet) parts.push('sheet=' + encodeURIComponent(ctx.sheet));
  if (typeof ctx.variantIndex === 'number' && Number.isFinite(ctx.variantIndex)) {
    parts.push('variantIndex=' + String(ctx.variantIndex));
  }
  return parts.join(' ');
}
