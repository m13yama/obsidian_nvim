import assert from "node:assert/strict";
import { test } from "node:test";
import { ChangeSet, Text } from "@codemirror/state";
import { FileBuffer, bufferEdits } from "../src/editor/document";

test("native line patches preserve exact text at line boundaries and with Unicode", () => {
  const originals = [[""], ["日本😀"], ["a", "b"], ["a", ""], ["", "", "last"]];
  const replacements = [[], [""], ["😀new"], ["a", "", "語"], ["", ""]];
  for (const lines of originals) for (let first = 0; first <= lines.length; first++) {
    for (let last = first; last <= lines.length; last++) for (const inserted of replacements) {
      const expected = [...lines];
      expected.splice(first, last - first, ...inserted);
      if (!expected.length) continue; // Neovim keeps at least one empty line.
      const file = new FileBuffer(1, "note.md", Text.of(lines));
      file.receive({ id: 1, tick: 2, changes: [{ first, last, lines: inserted }] });
      assert.equal(file.text.toString(), expected.join("\n"), JSON.stringify({ lines, first, last, inserted }));
      assert.ok(file.text.eq(file.shadow));
    }
  }
});

test("concurrent native edits and pending host edits both survive on the same line", () => {
  const doc = Text.of(["abcde"]), file = new FileBuffer(1, "note.md", doc);
  file.hostChange(doc, ChangeSet.of({ from: 5, insert: "日本😀" }, doc.length));
  const visible = file.receive({ id: 1, tick: 3, changes: [{ first: 0, last: 1, lines: ["bcde"] }] });
  assert.equal(visible.apply(Text.of(["abcde日本😀"])).toString(), "bcde日本😀");
  assert.equal(file.text.toString(), "bcde日本😀");
  assert.equal(file.pending.apply(file.shadow).toString(), "bcde日本😀");
  assert.deepEqual(bufferEdits(file.shadow, file.pending), [{ start: [0, 4], end: [0, 4], lines: ["日本😀"] }]);
});

test("acknowledging an in-flight host edit retains newer local edits without echoing them twice", () => {
  const doc = Text.of(["one", "日本😀"]), file = new FileBuffer(1, "note.md", doc);
  file.hostChange(doc, ChangeSet.of({ from: 0, insert: "first " }, doc.length));
  file.inflight = { token: 7, after: ChangeSet.empty(file.text.length) };
  file.hostChange(file.text, ChangeSet.of({ from: file.text.length, insert: "!" }, file.text.length));
  file.receive({ id: 1, tick: 3, origin: 7, changes: [{ first: 0, last: 1, lines: ["first one"] }] });
  assert.equal(file.shadow.toString(), "first one\n日本😀");
  assert.equal(file.text.toString(), "first one\n日本😀!");
  assert.deepEqual(bufferEdits(file.shadow, file.pending), [{ start: [1, 10], end: [1, 10], lines: ["!"] }]);
});
