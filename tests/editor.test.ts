import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { EditorController } from "../src/editor/controller";
import { neovimExtension } from "../src/editor/extension";

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("CodeMirror and real Neovim stay in sync through typing, external edits, note reuse, and disconnect", async (t) => {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", { pretendToBeVisual: true });
  const { window } = dom;
  for (const key of ["window", "document", "MutationObserver", "HTMLElement", "Node", "Window"] as const) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
  }
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverStub, configurable: true });
  window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  let status = "";
  let name = "first.md";
  let saves = 0;
  const errors: Error[] = [];
  const controller = new EditorController({
    status: (value) => { status = value; }, commandLine: () => {}, message: () => {}, error: (error) => errors.push(error),
  });
  const view = new EditorView({
    parent: window.document.body,
    state: EditorState.create({
      doc: "hello world",
      extensions: [neovimExtension(controller, { name: () => name, save: async () => { saves++; } })],
    }),
  });
  t.after(() => { controller.stop(); view.destroy(); window.close(); });
  view.focus();
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => controller.ready, "connected");
  const key = (value: string, options: KeyboardEventInit = {}) => {
    const event = new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
    view.contentDOM.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, `captured ${value}`);
  };
  for (const value of ["d", "w"]) key(value);
  await waitFor(() => view.state.doc.toString() === "world", "delete word reaches CodeMirror");
  key("u");
  await waitFor(() => view.state.doc.toString() === "hello world", "Neovim undo");
  key("v"); key("l"); key("l");
  await waitFor(() => view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) === "hel", "inclusive visual selection");
  key("Escape"); key("0");
  await waitFor(() => status === "NORMAL" && view.state.selection.main.head === 0, "normal cursor after visual");
  key("i");
  for (const value of "日本😀<fast typing>") key(value);
  key("Escape");
  await waitFor(() => view.state.doc.toString() === "日本😀<fast typing>hello world" && status === "NORMAL", "rapid ordered Unicode input");

  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "plugin update" }, selection: { anchor: 0 } });
  key("d"); key("w");
  await waitFor(() => view.state.doc.toString() === "update", "host edit reaches Neovim before next command");
  for (const value of [":", "w", "Enter"]) key(value);
  await waitFor(() => saves === 1, "save callback");

  // A queued command belonging to the old note must never run against a reused editor.
  key("d"); key("w");
  name = "second.md";
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "second note" }, selection: { anchor: 0 } });
  key("u");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(view.state.doc.toString(), "second note", "undo does not restore another note");
  key("A"); key("!"); key("Escape");
  await waitFor(() => view.state.doc.toString() === "second note!", "reused view edits its new note");

  controller.stop();
  const event = new window.KeyboardEvent("keydown", { key: "i", bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, "disconnect releases keyboard to Obsidian");
  assert.equal(view.state.doc.toString(), "second note!");

  await controller.start({ executable: "/does-not-exist/nvim", useConfig: false, initPath: "" });
  assert.equal(controller.ready, false);
  assert.equal(view.state.doc.toString(), "second note!");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /ENOENT/);
  errors.length = 0;
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => controller.ready, "reconnect after failure");
  key("A"); key("?"); key("Escape");
  await waitFor(() => view.state.doc.toString() === "second note!?", "typing after reconnect");
  assert.deepEqual(errors, []);
});
