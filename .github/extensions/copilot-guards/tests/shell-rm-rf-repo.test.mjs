import test from "node:test";
import assert from "node:assert/strict";
import guard, { isDangerousTarget } from "../guards/shell-rm-rf-repo.mjs";

const run = (cmd) => guard.check({ command: cmd });

test("isDangerousTarget catches '.', '/', '~', '..'", () => {
    assert.equal(isDangerousTarget("."), true);
    assert.equal(isDangerousTarget("./"), true);
    assert.equal(isDangerousTarget("/"), true);
    assert.equal(isDangerousTarget("~"), true);
    assert.equal(isDangerousTarget("~/foo"), true);
    assert.equal(isDangerousTarget(".."), true);
    assert.equal(isDangerousTarget("../foo"), true);
    assert.equal(isDangerousTarget("C:\\"), true);
    assert.equal(isDangerousTarget("/etc"), true);
});

test("isDangerousTarget allows specific subdirs", () => {
    assert.equal(isDangerousTarget("node_modules"), false);
    assert.equal(isDangerousTarget("dist"), false);
    assert.equal(isDangerousTarget("src/foo"), false);
});

test("denies rm -rf .", () => {
    assert.equal(run("rm -rf .").decision, "deny");
});

test("denies rm -rf /", () => {
    assert.equal(run("rm -rf /").decision, "deny");
});

test("denies rm -rf ~", () => {
    assert.equal(run("rm -rf ~").decision, "deny");
});

test("allows rm -rf node_modules", () => {
    assert.equal(run("rm -rf node_modules").decision, "allow");
});

test("allows rm -rf dist", () => {
    assert.equal(run("rm -rf dist").decision, "allow");
});

test("denies PowerShell Remove-Item . -Recurse -Force", () => {
    assert.equal(run("Remove-Item . -Recurse -Force").decision, "deny");
});

test("allows PowerShell Remove-Item dist -Recurse -Force", () => {
    assert.equal(run("Remove-Item dist -Recurse -Force").decision, "allow");
});

test("denies rm --recursive .", () => {
    // Regression: hasRecursive used to only match short flags like -r/-R,
    // so `rm --recursive .` slipped past the segment check even though
    // matches() triggered on the -r substring.
    assert.equal(run("rm --recursive .").decision, "deny");
});

test("denies rm --recursive --force /", () => {
    assert.equal(run("rm --recursive --force /").decision, "deny");
});

test("allows rm --recursive node_modules", () => {
    assert.equal(run("rm --recursive node_modules").decision, "allow");
});
