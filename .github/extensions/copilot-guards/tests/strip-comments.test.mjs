import test from "node:test";
import assert from "node:assert/strict";
import { stripCommentsAndStrings } from "../lib/strip-comments.mjs";

test("strips line comments", () => {
    const out = stripCommentsAndStrings("const x = 1; // Math.random()\nconst y = 2;");
    assert.ok(!out.includes("Math.random"));
    assert.ok(out.includes("const x = 1"));
    assert.ok(out.includes("const y = 2"));
});

test("strips block comments", () => {
    const out = stripCommentsAndStrings("/* Math.random() */ const x = Math.random();");
    // First Math.random was inside comment (stripped), second is real code
    const count = (out.match(/Math\.random/g) || []).length;
    assert.equal(count, 1);
});

test("strips single-quoted strings", () => {
    const out = stripCommentsAndStrings("const a = 'Math.random()';");
    assert.ok(!out.includes("Math.random"));
});

test("strips double-quoted strings", () => {
    const out = stripCommentsAndStrings('const a = "Math.random()";');
    assert.ok(!out.includes("Math.random"));
});

test("strips template literal text but keeps expressions", () => {
    const out = stripCommentsAndStrings("const a = `text Math.random() ${Math.random()}`;");
    // Outside ${...} stripped; inside kept
    const count = (out.match(/Math\.random/g) || []).length;
    assert.equal(count, 1);
});

test("preserves code outside strings/comments", () => {
    const src = "function f() { return Math.random(); }";
    const out = stripCommentsAndStrings(src);
    assert.match(out, /Math\.random/);
});

test("handles escape sequences in strings", () => {
    const out = stripCommentsAndStrings("const a = 'it\\'s ok Math.random()';");
    assert.ok(!out.includes("Math.random"));
});
