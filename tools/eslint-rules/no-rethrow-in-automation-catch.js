/**
 * no-rethrow-in-automation-catch
 *
 * Bans re-throwing the caught error from inside a `catch` block in CI
 * automation scripts.
 *
 * Receipt: `.github/scripts/merge-train/reconcile.mjs` re-threw any non-422
 * error from the update-branch API. The throw was uncaught at the top level,
 * the Node process exited non-zero mid-run, and the merge queue deadlocked for
 * ~90 minutes with no reconciler to unstick it.
 *
 * Deliberately narrow on two axes, because a noisy guard costs as much agent
 * time as the bug it prevents:
 *
 * 1. Only throws that actually ESCAPE the catch are reported. A throw inside a
 *    nested function declared in the catch body (a different execution
 *    context), or inside a nested `try` that has its own handler, is not
 *    reported. The thrown VALUE is irrelevant: `throw error`,
 *    `throw new Error(..., { cause: error })` and `throw someOtherError` all
 *    unwind the loop and abandon the remaining items identically.
 *
 * 2. Only catches lexically inside a LOOP body — with no intervening function
 *    boundary — are reported. That is the shape with the blast radius: the
 *    reconcile deadlock happened because the throw escaped the
 *    `for (const pr of queued)` loop, so it did not merely fail one PR, it
 *    abandoned every remaining queued PR. A rethrow in a standalone helper
 *    (e.g. `ensureLabel`) propagates to that helper's caller, which is normal
 *    error plumbing and is explicitly NOT a finding here.
 *
 * This is why the rule reports 1 real site rather than 24 mostly-legitimate
 * ones (Class C of the regression retrospective: guards must prove they do not
 * false-positive).
 */

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

const LOOP_TYPES = new Set([
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

/**
 * True when `catchClause` sits inside a loop body without crossing a function
 * boundary first — i.e. an escaping throw abandons the loop's remaining
 * iterations (the remaining work items), not just this one.
 *
 * Walks ancestors outward and stops at the first function boundary: a catch
 * inside a helper *called from* a loop is not in scope, only one lexically
 * nested in the loop.
 */
function isInsideLoopBody(catchClause, sourceCode) {
  const ancestors = sourceCode.getAncestors(catchClause);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = ancestors[i];
    if (FUNCTION_TYPES.has(ancestor.type)) return false;
    if (LOOP_TYPES.has(ancestor.type)) return true;
  }
  return false;
}

const noRethrowInAutomationCatchRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow re-throwing the caught error inside a catch block in CI automation, which crashes the process and stalls the queue.',
    },
    schema: [],
    messages: {
      rethrow:
        'Do not throw from a catch inside a loop. The throw escapes the loop, so it does not just fail this item — it abandons every remaining item in the batch (a re-thrown non-422 update-branch error deadlocked the merge queue for ~90 minutes this way). Wrapping the error (`throw new Error(msg, { cause: err })`) does not help — it unwinds the loop just the same. Log the error and `continue` to the next item instead. If this throw genuinely must propagate, silence it with an `// eslint-disable-next-line crawler/no-rethrow-in-automation-catch` comment explaining who catches it and why abandoning the remaining items is correct.',
    },
  },
  create(context) {
    return {
      CatchClause(catchClause) {
        const sourceCode = context.sourceCode ?? context.getSourceCode();

        // Only loop-scoped catches have the "abandons the rest of the batch"
        // blast radius. Helper-level rethrows are ordinary error plumbing.
        if (!isInsideLoopBody(catchClause, sourceCode)) return;

        // Own traversal (rather than parent-pointer walking) because ESLint
        // only assigns `parent` to nodes it has already entered, and the catch
        // body's descendants have not been entered yet at this point.
        const visit = (node) => {
          if (!node || typeof node.type !== 'string') return;

          // A throw inside a nested function/arrow runs in a different
          // execution context — not an escape from this catch.
          if (FUNCTION_TYPES.has(node.type)) return;

          if (node.type === 'TryStatement') {
            // A throw inside a nested `try` that HAS a handler is caught there,
            // so it does not escape the loop. The nested CatchClause reports its
            // own escaping throws when ESLint visits it.
            if (!node.handler) visit(node.block);
            visit(node.finalizer);
            return;
          }

          if (node.type === 'ThrowStatement') {
            context.report({ node, messageId: 'rethrow' });
            // An expression inside the thrown value cannot itself throw
            // synchronously at this level in any shape worth a second report.
            return;
          }

          for (const key of sourceCode.visitorKeys[node.type] ?? []) {
            const value = node[key];
            if (Array.isArray(value)) {
              for (const item of value) visit(item);
            } else if (value && typeof value.type === 'string') {
              visit(value);
            }
          }
        };

        visit(catchClause.body);
      },
    };
  },
};

export default noRethrowInAutomationCatchRule;
