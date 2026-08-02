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
  it('reports direct rethrows of the caught binding and nothing else', () => {
    ruleTester.run('no-rethrow-in-automation-catch', rule, {
      valid: [
        // Log-and-continue: the sanctioned shape.
        `try { await updateBranch(pr); } catch (error) { console.warn('update-branch failed', error); }`,
        // Guarded skip.
        `for (const pr of prs) { try { await updateBranch(pr); } catch (error) { console.warn(error); continue; } }`,
        // Throwing a *new* error is out of scope (narrow rule).
        `try { work(); } catch (error) { throw new Error('wrapped', { cause: error }); }`,
        // Throwing an unrelated binding is not a rethrow of the caught error.
        `const fatal = new Error('boom'); try { work(); } catch (error) { console.warn(error); throw fatal; }`,
        // Nested function: different execution context.
        `try { work(); } catch (error) { queue.push(() => { throw error; }); }`,
        // Nested function declaration: also a different execution context.
        `try { work(); } catch (error) { function replay() { throw error; } register(replay); }`,
        // Nested arrow inside a nested object literal.
        `try { work(); } catch (error) { register({ retry: async () => { throw error; } }); }`,
        // Throw outside any catch is untouched.
        `function assertOk(ok) { if (!ok) { throw new Error('not ok'); } }`,
        // Catch with no binding.
        `try { work(); } catch { console.warn('failed'); }`,
        // Destructured catch param (not a plain identifier) — out of scope.
        `try { work(); } catch ({ status }) { console.warn(status); }`,
        // Rethrow in a *nested* catch of its own binding is reported once, by
        // the nested clause — this case only checks the outer binding is clean.
        `try { work(); } catch (outer) { console.warn(outer); }`,
      ],
      invalid: [
        {
          // The exact merge-train regression shape.
          code: `try { await updateBranch(pr); } catch (error) { if (error.status !== 422) throw error; }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          code: `try { work(); } catch (error) { throw error; }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          code: `try { work(); } catch (err) { throw err; }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          // Nested blocks / ifs inside the catch body.
          code: `try { work(); } catch (error) { if (a) { if (b) { throw error; } } }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          // Inside a loop and a switch — still the same execution context.
          code: `try { work(); } catch (error) { for (const x of xs) { switch (x) { case 1: throw error; } } }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          // Inside a nested try's try-block (not a function boundary).
          code: `try { work(); } catch (error) { try { cleanup(); } finally { throw error; } }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          // Two rethrows, two reports.
          code: `try { work(); } catch (error) { if (a) throw error; if (b) throw error; }`,
          errors: [{ messageId: 'rethrow' }, { messageId: 'rethrow' }],
        },
        {
          // Shadowing nested catch: each clause reports its own binding once.
          code: `try { work(); } catch (error) { try { cleanup(); } catch (error) { throw error; } }`,
          errors: [{ messageId: 'rethrow' }],
        },
        {
          // Async catch body.
          code: `async function run() { try { await work(); } catch (error) { await log(error); throw error; } }`,
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
          code: `try { work(); } catch (error) { throw error; }`,
          errors: [
            {
              message: /stalls the pipeline/,
            },
            // vitest's RuleTester accepts a regex in `message`; the assertions
            // below pin the remaining required phrases.
          ],
        },
        {
          code: `try { work(); } catch (error) { throw error; }`,
          errors: [{ message: /Log the error and continue\/skip/ }],
        },
        {
          code: `try { work(); } catch (error) { throw error; }`,
          errors: [{ message: /eslint-disable-next-line/ }],
        },
      ],
    });
  });
});
