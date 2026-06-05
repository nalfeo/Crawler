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
    assert.deepEqual(segs, ['"git push --force main"']);
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
