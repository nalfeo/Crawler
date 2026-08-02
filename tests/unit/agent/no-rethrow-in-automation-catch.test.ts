import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../../../tools/eslint-rules/no-rethrow-in-automation-catch.js';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

describe('no-rethrow-in-automation-catch', () => {
  it('reports loop-scoped rethrows of the caught binding and nothing else', () => {
    ruleTester.run('no-rethrow-in-automation-catch', rule, {
      valid: [
        // --- Negative controls: shapes that must NEVER be reported. ---
        // Helper-level rethrow with no enclosing loop. This is ordinary error
        // plumbing: it propagates to the caller, abandoning nothing. 23 of the
        // 24 sites the un-narrowed rule flagged were this shape.
        `try { work(); } catch (error) { throw error; }`,
        `function ensureLabel() { try { work(); } catch (error) { throw error; } }`,
        // A function boundary between the loop and the catch: the throw leaves
        // the helper, not the loop, so the loop decides whether to continue.
        `for (const pr of prs) { const run = () => { try { work(); } catch (error) { throw error; } }; run(); }`,
        // Log-and-continue inside a loop: the sanctioned shape.
        `for (const pr of prs) { try { await updateBranch(pr); } catch (error) { console.warn(error); continue; } }`,
        `try { await updateBranch(pr); } catch (error) { console.warn('update-branch failed', error); }`,
        // Throwing a *new* error is out of scope (narrow rule).
        `for (const x of xs) { try { work(); } catch (error) { throw new Error('wrapped', { cause: error }); } }`,
        // Throwing an unrelated binding is not a rethrow of the caught error.
        `const fatal = new Error('boom'); for (const x of xs) { try { work(); } catch (error) { console.warn(error); throw fatal; } }`,
        // Nested function inside the catch: different execution context.
        `for (const x of xs) { try { work(); } catch (error) { queue.push(() => { throw error; }); } }`,
        `for (const x of xs) { try { work(); } catch (error) { function replay() { throw error; } register(replay); } }`,
        `for (const x of xs) { try { work(); } catch (error) { register({ retry: async () => { throw error; } }); } }`,
        // Throw outside any catch is untouched.
        `for (const x of xs) { if (!x) { throw new Error('not ok'); } }`,
        // Catch with no binding.
        `for (const x of xs) { try { work(); } catch { console.warn('failed'); } }`,
        // Destructured catch param (not a plain identifier) — out of scope.
        `for (const x of xs) { try { work(); } catch ({ status }) { console.warn(status); } }`,
      ],
      invalid: [
        {
          // The exact merge-train regression shape: catch inside the
          // `for (const pr of queued)` admission loop.
          code: `for (const pr of queued) { try { await updateBranch(pr); } catch (error) { if (error.status !== 422) throw error; } }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          code: `for (const x of xs) { try { work(); } catch (error) { throw error; } }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          // Every loop form has the same blast radius.
          code: `for (let i = 0; i < n; i += 1) { try { work(); } catch (err) { throw err; } }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          code: `for (const k in obj) { try { work(); } catch (err) { throw err; } }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          code: `while (queue.length) { try { work(); } catch (err) { throw err; } }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          code: `do { try { work(); } catch (err) { throw err; } } while (more);`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          // Loop nested inside a function: the loop is still the boundary that
          // matters, and no function boundary sits between it and the catch.
          code: `async function run() { for (const pr of prs) { try { await work(); } catch (error) { await log(error); throw error; } } }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          // Nested blocks / ifs inside the catch body.
          code: `for (const x of xs) { try { work(); } catch (error) { if (a) { if (b) { throw error; } } } }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          // Inside a nested try's finally (not a function boundary).
          code: `for (const x of xs) { try { work(); } catch (error) { try { cleanup(); } finally { throw error; } } }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          // Two rethrows, two reports.
          code: `for (const x of xs) { try { work(); } catch (error) { if (a) throw error; if (b) throw error; } }`,
          errors: [{ messageId: 'rethrow' }, { messageId: 'rethrow' }],
        },
        {
          // Shadowing nested catch: each clause reports its own binding once.
          code: `for (const x of xs) { try { work(); } catch (error) { try { cleanup(); } catch (error) { throw error; } } }`,
          errors: [{ messageId: 'rethrow' }],
        },
      ],
    });
  });

  it('names the deadlock failure mode and the log-and-skip remedy in its message', () => {
    ruleTester.run('no-rethrow-in-automation-catch message text', rule, {
      valid: [],
      invalid: [
        {
          code: `for (const x of xs) { try { work(); } catch (error) { throw error; } }`,
          errors: [
            {
              message: /abandons every remaining item in the batch/,
            },
            // vitest's RuleTester accepts a regex in `message`; the assertions
            // below pin the remaining required phrases.
          ],
        },
        {
          code: `for (const x of xs) { try { work(); } catch (error) { throw error; } }`,
          errors: [{ message: /Log the error and `continue` to the next item/ }],
        },
        {
          code: `for (const x of xs) { try { work(); } catch (error) { throw error; } }`,
          errors: [{ message: /eslint-disable-next-line/ }],
        },
      ],
    });
  });
});
