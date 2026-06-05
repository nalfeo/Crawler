import test from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../lib/dispatcher.mjs";

const noopCtx = { cwd: process.cwd(), log: async () => {} };

test("dispatch returns undefined when no guards match", async () => {
    const result = await dispatch(
        [
            {
                id: "x",
                matches: () => false,
                check: () => ({ decision: "deny", reason: "should not fire" }),
            },
        ],
        "view",
        {},
        noopCtx,
    );
    assert.equal(result, undefined);
});

test("dispatch returns first deny from shell category", async () => {
    const result = await dispatch(
        [
            {
                id: "shell-a",
                category: "shell",
                matches: () => true,
                check: () => ({ decision: "deny", reason: "bad" }),
            },
            {
                id: "shell-b",
                category: "shell",
                matches: () => true,
                check: () => ({ decision: "deny", reason: "also bad" }),
            },
        ],
        "powershell",
        {},
        noopCtx,
    );
    assert.equal(result.permissionDecision, "deny");
    assert.match(result.permissionDecisionReason, /shell-a/);
    assert.doesNotMatch(result.permissionDecisionReason, /shell-b/);
});

test("dispatch aggregates pr-category denies", async () => {
    const result = await dispatch(
        [
            {
                id: "pr-a",
                category: "pr",
                matches: () => true,
                check: () => ({ decision: "deny", reason: "issue A" }),
            },
            {
                id: "pr-b",
                category: "pr",
                matches: () => true,
                check: () => ({ decision: "deny", reason: "issue B" }),
            },
        ],
        "create_pull_request",
        {},
        noopCtx,
    );
    assert.equal(result.permissionDecision, "deny");
    assert.match(result.permissionDecisionReason, /pr-a/);
    assert.match(result.permissionDecisionReason, /pr-b/);
});

test("dispatch fail-closed deny on crash", async () => {
    const result = await dispatch(
        [
            {
                id: "boom",
                category: "shell",
                failClosed: true,
                matches: () => true,
                check: () => {
                    throw new Error("kaboom");
                },
            },
        ],
        "powershell",
        {},
        noopCtx,
    );
    assert.equal(result.permissionDecision, "deny");
    assert.match(result.permissionDecisionReason, /kaboom/);
});

test("dispatch fail-open allow on crash by default", async () => {
    const result = await dispatch(
        [
            {
                id: "boom",
                matches: () => true,
                check: () => {
                    throw new Error("oops");
                },
            },
        ],
        "edit",
        {},
        noopCtx,
    );
    assert.equal(result, undefined);
});

test("dispatch collects additionalContext from allowed guards", async () => {
    const result = await dispatch(
        [
            {
                id: "ctx-a",
                matches: () => true,
                check: () => ({ decision: "allow", additionalContext: "note A" }),
            },
            {
                id: "ctx-b",
                matches: () => true,
                check: () => ({ decision: "allow", additionalContext: "note B" }),
            },
        ],
        "edit",
        {},
        noopCtx,
    );
    assert.equal(result.permissionDecision, "allow");
    assert.match(result.additionalContext, /note A/);
    assert.match(result.additionalContext, /note B/);
});

test("env var COPILOT_GUARDS_DISABLE bypasses guard", async () => {
    process.env.COPILOT_GUARDS_DISABLE = "edit-bad";
    const result = await dispatch(
        [
            {
                id: "edit-bad",
                matches: () => true,
                check: () => ({ decision: "deny", reason: "should be bypassed" }),
            },
        ],
        "edit",
        {},
        noopCtx,
    );
    assert.equal(result, undefined);
    delete process.env.COPILOT_GUARDS_DISABLE;
});
