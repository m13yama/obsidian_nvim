import assert from "node:assert/strict";
import { test } from "node:test";
import { byteToUtf16, textChange, utf16ToByte } from "../src/editor/text";
import { toNeovimKey, type KeyEvent } from "../src/editor/keys";

test("UTF-8 Neovim columns round-trip with UTF-16 CodeMirror offsets", () => {
  const line = "a日本😀e\u0301";
  for (const offset of [0, 1, 2, 3, 5, 6, 7]) {
    assert.equal(byteToUtf16(line, utf16ToByte(line, offset)), offset);
  }
  assert.equal(byteToUtf16(line, 8), 3, "partial emoji byte points to its start");
});

test("document replacements preserve Unicode and exact trailing newlines", () => {
  for (const [before, after] of [
    ["abc", "aXc"], ["a😀z", "a😁z"], ["a😀z", "az"], ["", "\n"],
    ["日本\n", "日本\n\n"], ["😀", "😁😀"], ["a😁😀", "a😀"],
  ]) {
    const change = textChange(before!, after!);
    assert.ok(change);
    assert.equal(before!.slice(0, change.from) + change.insert + before!.slice(change.to), after);
    assert.ok(!/^[\uDC00-\uDFFF]/u.test(change.insert));
  }
  assert.equal(textChange("same", "same"), undefined);
});

function key(value: string, modifiers: Partial<KeyEvent> = {}): KeyEvent {
  return { key: value, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, ...modifiers };
}

test("keyboard notation supports commands, modifiers, literals and native shortcuts", () => {
  assert.equal(toNeovimKey(key("i")), "i");
  assert.equal(toNeovimKey(key("A", { shiftKey: true })), "A");
  assert.equal(toNeovimKey(key("<", { shiftKey: true })), "<lt>");
  assert.equal(toNeovimKey(key("Escape")), "<Esc>");
  assert.equal(toNeovimKey(key("r", { ctrlKey: true })), "<C-r>");
  assert.equal(toNeovimKey(key("Tab", { shiftKey: true })), "<S-Tab>");
  assert.equal(toNeovimKey(key("v", { ctrlKey: true })), "<C-v>");
  assert.equal(toNeovimKey(key("v", { ctrlKey: true }), "i"), null);
  assert.equal(toNeovimKey(key("v", { ctrlKey: true }), "R"), null);
  assert.equal(toNeovimKey(key("v", { ctrlKey: true }), "\x16"), "<C-v>");
  assert.equal(toNeovimKey(key("x", { ctrlKey: true })), "<C-x>");
  assert.equal(toNeovimKey(key("x", { ctrlKey: true }), "i"), null);
  assert.equal(toNeovimKey(key("a", { ctrlKey: true })), "<C-a>");
  assert.equal(toNeovimKey(key("a", { ctrlKey: true }), "i"), null);
  assert.equal(toNeovimKey(key("f", { ctrlKey: true })), "<C-f>");
  assert.equal(toNeovimKey(key("f", { ctrlKey: true }), "i"), null);
  for (const mode of ["n", "i", "v", "\x16", "R"]) {
    for (const value of ["s", "c", "p", "e", "0"]) assert.equal(toNeovimKey(key(value, { ctrlKey: true }), mode), null);
  }
  assert.equal(toNeovimKey(key("v", { ctrlKey: true, shiftKey: true })), null);
  assert.equal(toNeovimKey(key("ArrowLeft", { altKey: true })), null);
  assert.equal(toNeovimKey(key("c", { metaKey: true })), null);
  assert.equal(toNeovimKey(key("Process", { isComposing: true })), null);
  assert.equal(toNeovimKey(key("@", { ctrlKey: true, altKey: true, getModifierState: () => true })), null);
});
