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
 * Deliberately narrow: only a direct `throw <caughtParam>` is reported. Wrapped
 * errors (`throw new Error(..., { cause: err })`) and throws inside a nested
 * function declared in the catch body (different execution context) are not
 * reported — narrow and true beats broad and noisy.
 */

function getCatchParamName(catchClause) {
  const param = catchClause.param;
  if (!param || param.type !== 'Identifier') return null;
  return param.name;
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

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
        "Do not re-throw the caught error '{{name}}' here. In queue/recovery automation an uncaught throw kills the Node process mid-run and stalls the pipeline (a re-thrown non-422 update-branch error deadlocked the merge queue for ~90 minutes). Log the error and continue/skip this item instead — e.g. `console.warn(...)` then `continue`/`return`. If this throw genuinely must propagate, silence it with an `// eslint-disable-next-line crawler/no-rethrow-in-automation-catch` comment explaining who catches it.",
    },
  },
  create(context) {
    return {
      CatchClause(catchClause) {
        const name = getCatchParamName(catchClause);
        if (!name) return;

        const sourceCode = context.sourceCode ?? context.getSourceCode();

        // Own traversal (rather than parent-pointer walking) because ESLint
        // only assigns `parent` to nodes it has already entered, and the catch
        // body's descendants have not been entered yet at this point.
        const visit = (node) => {
          if (!node || typeof node.type !== 'string') return;

          // A throw inside a nested function/arrow runs in a different
          // execution context — not a rethrow of this catch.
          if (FUNCTION_TYPES.has(node.type)) return;

          // A nested catch that shadows the same binding name owns its own
          // rethrows; its CatchClause visit reports them.
          if (node.type === 'CatchClause' && getCatchParamName(node) === name) return;

          if (node.type === 'ThrowStatement') {
            const arg = node.argument;
            if (arg && arg.type === 'Identifier' && arg.name === name) {
              context.report({ node, messageId: 'rethrow', data: { name } });
            }
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
