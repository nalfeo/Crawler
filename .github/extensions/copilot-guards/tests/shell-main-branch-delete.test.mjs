import test from "node:test";
import assert from "node:assert/strict";
import guard from "../guards/shell-main-branch-delete.mjs";

const run = (cmd) => guard.check({ command: cmd });

test("denies git push origin --delete main", () => {
    assert.equal(run("git push origin --delete main").decision, "deny");
});

test("denies git push origin -d main", () => {
    assert.equal(run("git push origin -d main").decision, "deny");
});

test("denies refspec :main delete", () => {
    assert.equal(run("git push origin :main").decision, "deny");
});

test("denies git branch -D main", () => {
    assert.equal(run("git branch -D main").decision, "deny");
});

test("denies git branch -d master", () => {
    assert.equal(run("git branch -d master").decision, "deny");
});

test("allows deletion of feature branch", () => {
    assert.equal(run("git branch -D my-feature").decision, "allow");
    assert.equal(run("git push origin --delete my-feature").decision, "allow");
});
