import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCommand, tokenize, isProgram, isGit, isGh } from "../lib/shell.mjs";

test("normalizeCommand splits on && and ;", () => {
    const segs = normalizeCommand("git status && git push --force main");
    assert.deepEqual(segs, ["git status", "git push --force main"]);
    const segs2 = normalizeCommand("a; b; c");
    assert.deepEqual(segs2, ["a", "b", "c"]);
});

test("normalizeCommand handles bash line continuations", () => {
    const segs = normalizeCommand("git push \\\n  --force main");
    assert.equal(segs.length, 1);
    assert.match(segs[0], /git push --force main/);
});

test("normalizeCommand strips bash -c wrapper", () => {
    const segs = normalizeCommand('bash -c "git push --force main"');
    assert.deepEqual(segs, ["git push --force main"]);
});

test("normalizeCommand strips bash -c wrapper and preserves chained segments", () => {
    const segs = normalizeCommand('bash -c "git status && git push --force main"');
    assert.deepEqual(segs, ["git status", "git push --force main"]);
});

test("normalizeCommand strips pwsh -Command wrapper with single quotes", () => {
    const segs = normalizeCommand("pwsh -Command 'git push --force main'");
    assert.deepEqual(segs, ["git push --force main"]);
});

test("isGit sees through bash -c bypass attempt", () => {
    // Regression: previously, `bash -c "git ..."` left the quoted
    // command as a single token, defeating every shell guard.
    const segs = normalizeCommand('bash -c "git push --force origin main"');
    assert.equal(segs.length, 1);
    assert.equal(isGit(segs[0]), true);
});

test("normalizeCommand strips pwsh -NoProfile -Command wrapper", () => {
    // Regression: previously, only a single flag was allowed between
    // the program and -Command, so `pwsh -NoProfile -Command '...'`
    // bypassed every shell guard.
    const segs = normalizeCommand("pwsh -NoProfile -Command 'git push --force origin main'");
    assert.equal(segs.length, 1);
    assert.equal(isGit(segs[0]), true);
});

test("normalizeCommand strips bash -lc wrapper", () => {
    // Regression: previously, the wrapper regex only recognized -c
    // verbatim, so login-shell `bash -lc "..."` bypassed shell guards.
    const segs = normalizeCommand('bash -lc "git push --force origin main"');
    assert.equal(segs.length, 1);
    assert.equal(isGit(segs[0]), true);
});

test("normalizeCommand strips bash -ic wrapper", () => {
    const segs = normalizeCommand("bash -ic 'gh pr create'");
    assert.equal(segs.length, 1);
    assert.equal(isGh(segs[0]), true);
});

test("normalizeCommand strips multi-flag pwsh wrapper", () => {
    const segs = normalizeCommand(
        "pwsh -NoProfile -NonInteractive -Command 'git push --force'",
    );
    assert.equal(segs.length, 1);
    assert.equal(isGit(segs[0]), true);
});

test("tokenize respects double quotes", () => {
    const toks = tokenize('git commit -m "hello world"');
    assert.deepEqual(toks, ["git", "commit", "-m", "hello world"]);
});

test("tokenize respects single quotes", () => {
    const toks = tokenize("echo 'a b c' done");
    assert.deepEqual(toks, ["echo", "a b c", "done"]);
});

test("isProgram matches with .exe and path prefix", () => {
    assert.equal(isProgram("git push", "git"), true);
    assert.equal(isProgram("git.exe push", "git"), true);
    assert.equal(isProgram("/usr/bin/git push", "git"), true);
    // Note: paths with spaces must be quoted to tokenize correctly,
    // so we don't try to handle unquoted `C:/Program Files/...`.
    assert.equal(isProgram("hub push", "git"), false);
});

test("isGit and isGh", () => {
    assert.equal(isGit("git push"), true);
    assert.equal(isGh("gh pr create"), true);
    assert.equal(isGh("ghidra"), false);
});
