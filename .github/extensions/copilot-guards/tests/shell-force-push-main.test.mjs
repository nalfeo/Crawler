import test from "node:test";
import assert from "node:assert/strict";
import guard from "../guards/shell-force-push-main.mjs";

function run(cmd) {
    return guard.check({ command: cmd });
}

test("denies git push --force main", () => {
    const r = run("git push --force origin main");
    assert.equal(r.decision, "deny");
});

test("denies git push -f main", () => {
    const r = run("git push -f origin main");
    assert.equal(r.decision, "deny");
});

test("denies git push --force-with-lease main", () => {
    const r = run("git push --force-with-lease origin main");
    assert.equal(r.decision, "deny");
});

test("denies refspec force push: +main:main", () => {
    const r = run("git push origin +main:main");
    assert.equal(r.decision, "deny");
});

test("denies git push --force master", () => {
    const r = run("git push --force origin master");
    assert.equal(r.decision, "deny");
});

test("allows force push to feature branch", () => {
    const r = run("git push --force origin my-feature-branch");
    assert.equal(r.decision, "allow");
});

test("allows normal push to main (no --force)", () => {
    const r = run("git push origin main");
    assert.equal(r.decision, "allow");
});

test("detects across && chain", () => {
    const r = run("echo ok && git push --force origin main");
    assert.equal(r.decision, "deny");
});

test("detects with .exe", () => {
    const r = run("git.exe push --force origin main");
    assert.equal(r.decision, "deny");
});

test("detects across line continuation", () => {
    const r = run("git push \\\n  --force \\\n  origin \\\n  main");
    assert.equal(r.decision, "deny");
});

test("matches() returns false for unrelated commands", () => {
    assert.equal(guard.matches("powershell", { command: "ls -la" }), false);
    assert.equal(guard.matches("edit", { path: "src/foo.ts" }), false);
});
