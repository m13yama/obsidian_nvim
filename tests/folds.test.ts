import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldService, foldedRanges, foldEffect, unfoldEffect } from "@codemirror/language";
import { EditorController } from "../src/editor/controller";
import { neovimExtension } from "../src/editor/extension";

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const text = "intro\n# Parent\nparent body\n## Child\nhidden target\nchild body\n## Sibling\nsibling body\n# After\nafter body\n# End\nend body";
// Model the host's heading fold service, so these tests exercise real CM folds
// and real Neovim, rather than implementing a second navigation algorithm.
const headings = foldService.of((state, from) => {
  const line = state.doc.lineAt(from), level = /^(#+) /.exec(line.text)?.[1]?.length;
  if (!level) return null;
  let end = state.doc.lines;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const next = /^(#+) /.exec(state.doc.line(n).text)?.[1]?.length;
    if (next && next <= level) { end = n - 1; break; }
  }
  return end > line.number ? { from: line.to, to: state.doc.line(end).to } : null;
});

function domFixture(): JSDOM {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const { window } = dom;
  for (const key of ["window", "document", "MutationObserver", "HTMLElement", "Node", "Window"] as const) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "ResizeObserver", { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
  window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  return dom;
}

function closed(view: EditorView): number[] {
  const result: number[] = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from) => { result.push(view.state.doc.lineAt(from).number); });
  return result.sort((a, b) => a - b);
}
function fold(view: EditorView, from: number, to: number, open = false): void {
  view.dispatch({ effects: (open ? unfoldEffect : foldEffect).of({ from: view.state.doc.line(from).to, to: view.state.doc.line(to).to }) });
}

function fixture() {
  const dom = domFixture();
  const errors: Error[] = [], messages: string[] = [];
  let status = "";
  const controller = new EditorController({ status: (value) => { status = value; }, commandLine: () => {}, message: (s) => messages.push(s), error: (e) => errors.push(e) });
  const create = (name = "folds.md") => new EditorView({ parent: dom.window.document.body, state: EditorState.create({ doc: text, extensions: [
    headings, codeFolding(), neovimExtension(controller, { name: () => name, save: async () => {} }),
  ] }) });
  const key = (view: EditorView, key: string) => view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const keys = (view: EditorView, keys: string) => { for (const value of keys) key(view, value); };
  const row = (view: EditorView) => view.state.doc.lineAt(view.state.selection.main.head).number;
  const at = async (view: EditorView, number: number, label: string) => waitFor(() => row(view) === number, `${label}; row=${row(view)}, errors=${errors}, messages=${messages}`);
  return { dom, errors, messages, controller, create, key, keys, row, at, status: () => status };
}

test("folded headings are one motion unit; Enter toggles and preserves nested folds", async (t) => {
  const f = fixture(), view = f.create();
  t.after(() => { f.controller.stop(); view.destroy(); f.dom.window.close(); });
  fold(view, 4, 6); fold(view, 2, 8);
  view.focus();
  await f.controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => f.status() === "NORMAL", "connected");
  f.key(view, "j"); await f.at(view, 2, "enter closed parent");
  assert.deepEqual(closed(view), [2, 4]);
  f.key(view, "j"); await f.at(view, 9, "skip parent");
  f.key(view, "k"); await f.at(view, 2, "back to parent");
  f.key(view, "k"); await f.at(view, 1, "back before parent");
  f.keys(view, "2j"); await f.at(view, 9, "count skips one closed block");
  f.key(view, "k"); await f.at(view, 2, "parent");
  f.key(view, "Enter"); await waitFor(() => closed(view).join() === "4", `Enter opens parent: ${f.messages}`);
  f.key(view, "Enter"); await waitFor(() => closed(view).join() === "2,4", "Enter closes parent");
  f.keys(view, "zo"); await waitFor(() => closed(view).join() === "4", "zo opens parent without moving");
  f.keys(view, "zc"); await waitFor(() => closed(view).join() === "2,4", "zc closes parent without moving");
  f.keys(view, "zR"); await waitFor(() => closed(view).length === 0, "zR opens hidden children");
  f.keys(view, "zM"); await waitFor(() => closed(view).join() === "2,4,7,9,11", "zM closes all folds").catch((error) => { throw new Error(`${error}; folds=${closed(view)}, messages=${f.messages}, errors=${f.errors}`); });
  assert.equal(view.state.doc.toString(), text);
  assert.deepEqual(f.errors, []);
});

test("search opens only destination ancestors, editing Enter inserts a newline, and macros skip folds", async (t) => {
  const f = fixture(), view = f.create();
  t.after(() => { f.controller.stop(); view.destroy(); f.dom.window.close(); });
  fold(view, 4, 6); fold(view, 7, 8); fold(view, 2, 8);
  view.focus();
  await f.controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => f.status() === "NORMAL", "connected");
  f.keys(view, "/target"); f.key(view, "Enter"); await f.at(view, 5, "search destination");
  assert.deepEqual(closed(view), [7]);
  f.key(view, "i"); await waitFor(() => f.status() === "INSERT", "insert");
  f.key(view, "Enter"); await waitFor(() => view.state.doc.lines === 13, "insert Enter is newline");
  f.key(view, "Escape"); await waitFor(() => f.status() === "NORMAL", "normal");
  f.key(view, "u"); await waitFor(() => view.state.doc.toString() === text, "undo edit");
  f.keys(view, "gg"); await f.at(view, 1, "top");
  fold(view, 2, 8);
  f.keys(view, "qajjq"); await f.at(view, 9, "record motion macro");
  f.keys(view, "gg@a"); await f.at(view, 9, "replay motion macro");
  assert.ok(closed(view).includes(2));
  assert.deepEqual(f.errors, []);
});

test("mouse fold changes synchronize before the next key and panes retain independent folds", async (t) => {
  const f = fixture(), first = f.create(), second = f.create();
  t.after(() => { f.controller.stop(); first.destroy(); second.destroy(); f.dom.window.close(); });
  first.focus();
  await f.controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => f.status() === "NORMAL", "connected");
  fold(first, 2, 8);
  f.keys(first, "2j"); await f.at(first, 9, "mouse fold before immediate input");
  second.focus(); f.keys(second, "2j"); await f.at(second, 3, "other pane remains open");
  assert.deepEqual(closed(first), [2]); assert.deepEqual(closed(second), []);
  first.focus(); f.key(first, "k"); await f.at(first, 2, "return restores pane fold");
  fold(first, 2, 8, true);
  f.key(first, "j"); await f.at(first, 3, "mouse opens before immediate input");
  assert.deepEqual(f.errors, []);
});

test("Visual line selection and operators include closed folds without opening them", async (t) => {
  const f = fixture(), view = f.create();
  t.after(() => { f.controller.stop(); view.destroy(); f.dom.window.close(); });
  fold(view, 4, 6); fold(view, 2, 8);
  view.focus();
  await f.controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => f.status() === "NORMAL", "connected");
  f.keys(view, "jV"); await waitFor(() => f.status() === "VISUAL LINE", "visual");
  assert.deepEqual(closed(view), [2, 4]);
  assert.equal(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to), text.split('\n').slice(1, 8).join('\n') + '\n');
  f.key(view, "Escape"); await waitFor(() => f.status() === "NORMAL", "normal");
  f.keys(view, "dd"); await waitFor(() => view.state.doc.lines === 5, "delete whole closed block");
  assert.equal(view.state.doc.toString(), 'intro\n# After\nafter body\n# End\nend body');
  f.key(view, "u"); await waitFor(() => view.state.doc.toString() === text, "undo whole block");
  assert.deepEqual(f.errors, []);
});

test("fold ranges follow line edits and new headings become foldable before the next command", async (t) => {
  const f = fixture(), view = f.create();
  t.after(() => { f.controller.stop(); view.destroy(); f.dom.window.close(); });
  fold(view, 2, 8);
  view.focus();
  await f.controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => f.status() === "NORMAL", "connected");
  f.key(view, 'O'); f.keys(view, 'new intro'); f.key(view, 'Escape');
  await waitFor(() => view.state.doc.lines === 13 && f.status() === 'NORMAL', 'insert before fold');
  assert.deepEqual(closed(view), [3]);
  f.keys(view, '3j'); await f.at(view, 10, 'skip shifted fold');
  f.keys(view, 'gg'); await f.at(view, 1, 'top');
  // Replace the two introductory lines with a new heading and its body.
  view.dispatch({ changes: { from: 0, to: view.state.doc.line(2).to, insert: '# New\nnew body' } });
  f.key(view, 'Enter'); await waitFor(() => closed(view).join() === '1,3', 'new heading folds on Enter');
  f.key(view, 'j'); await f.at(view, 3, 'new fold acts as one line');
  assert.deepEqual(f.errors, []);
});

test("explicit line jumps reveal the destination without opening unrelated folds", async (t) => {
  const f = fixture(), view = f.create();
  t.after(() => { f.controller.stop(); view.destroy(); f.dom.window.close(); });
  fold(view, 4, 6); fold(view, 7, 8); fold(view, 2, 8);
  view.focus();
  await f.controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => f.status() === "NORMAL", "connected");
  f.keys(view, '5G'); await f.at(view, 5, 'line jump');
  assert.deepEqual(closed(view), [7]);
  assert.deepEqual(f.errors, []);
});

test("custom Enter mappings take priority and page motions preserve folds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-fold-mapping-'));
  const init = join(root, 'init.lua');
  await writeFile(init, "vim.keymap.set('n', '<CR>', 'j')");
  const f = fixture(), view = f.create();
  t.after(async () => { f.controller.stop(); view.destroy(); f.dom.window.close(); await rm(root, { recursive: true, force: true }); });
  fold(view, 4, 6); fold(view, 2, 8);
  view.focus();
  await f.controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: true, initPath: init });
  await waitFor(() => f.status() === "NORMAL", "connected");
  f.key(view, 'Enter'); await f.at(view, 2, 'custom Enter goes down');
  f.key(view, 'Enter'); await f.at(view, 9, 'custom Enter skips fold instead of toggling');
  for (const key of ['u', 'd', 'b', 'f']) {
    view.contentDOM.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(closed(view), [2, 4], `Ctrl-${key} preserves folds`);
  }
  assert.equal(view.state.doc.toString(), text);
  assert.deepEqual(f.errors, []);
});
