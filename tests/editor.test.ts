import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { EditorController, type EditorPort, type StatusDetails } from "../src/editor/controller";
import { neovimExtension } from "../src/editor/extension";
import { EditorKeyRouter } from "../src/editor/key-router";

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function editorDOM(): JSDOM {
  const dom = new JSDOM("<!DOCTYPE html><body></body>", { pretendToBeVisual: true });
  const { window } = dom;
  for (const key of ["window", "document", "MutationObserver", "HTMLElement", "Node", "Window"] as const) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true, writable: true });
  }
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverStub, configurable: true });
  window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  return dom;
}

test("resizing between navigation keys does not block the next key", async (t) => {
  const errors: Error[] = [];
  let direction = "";
  let mode = "";
  const controller = new EditorController({
    status: (value) => { mode = value; }, commandLine: () => {}, message: () => {},
    error: (error) => errors.push(error), navigate: (value) => { direction = value; },
  });
  const port: EditorPort = {
    id: 9999,
    document: () => ({ id: 9999, revision: 0, name: "navigation.md", text: "note", cursor: [1, 0] }),
    apply: () => {}, setConnected: () => {}, save: async () => {},
  };
  t.after(() => controller.stop());
  controller.register(port);
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "", navigation: true });
  controller.focus(port);
  await waitFor(() => mode === "NORMAL", "note is active");
  controller.input(port, "<C-w>");
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.resize(port, 100, 30);
  controller.input(port, "h");
  await waitFor(() => direction === "left", "navigation finishes across a pending resize");
  assert.equal(controller.ready, true);
  assert.deepEqual(errors, []);
});

test("CodeMirror and real Neovim stay in sync through typing, external edits, note reuse, and disconnect", async (t) => {
  const dom = editorDOM();
  const { window } = dom;
  let status = "";
  let statusDetails: StatusDetails | undefined;
  let name = "first.md";
  let saves = 0;
  const errors: Error[] = [];
  const controller = new EditorController({
    status: (value, details) => { status = value; statusDetails = details; }, commandLine: () => {}, message: () => {}, error: (error) => errors.push(error),
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
  assert.equal(statusDetails?.file, "first.md");
  assert.equal(statusDetails?.line, 1);
  assert.equal(statusDetails?.column, 1);
  assert.equal(statusDetails?.totalLines, 1);
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
  assert.equal(statusDetails?.file, "second.md", "status line follows the active note");

  // Obsidian opens another file by replacing the entire state, retaining the CM DOM.
  name = "third.md";
  view.setState(EditorState.create({ doc: "third note", extensions: [
    neovimExtension(controller, { name: () => name, save: async () => { saves++; } }),
  ] }));
  await waitFor(() => statusDetails?.file === "third.md", "new state connects without a key press");
  assert.equal(view.dom.dataset.neovimCursor, "block", "state replacement preserves cursor attributes");
  assert.ok(view.dom.classList.contains("neovim-connected"));
  assert.equal(view.contentDOM.querySelector(".neovim-block-cursor")?.textContent, "t");

  name = "second.md";
  view.setState(EditorState.create({ doc: "second note!", extensions: [
    neovimExtension(controller, { name: () => name, save: async () => { saves++; } }),
  ] }));
  await waitFor(() => statusDetails?.file === "second.md", "return to previous file");
  assert.equal(view.dom.dataset.neovimCursor, "block");

  controller.stop();
  assert.equal(statusDetails, undefined, "disconnection clears note context from the status line");
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

test("block cursor follows real Neovim across empty lines, Unicode, modes, composition, and disconnect", async (t) => {
  const dom = editorDOM();
  const { window } = dom;
  let status = "";
  const errors: Error[] = [];
  const controller = new EditorController({
    status: (value) => { status = value; }, commandLine: () => {}, message: () => {}, error: (error) => errors.push(error),
  });
  const view = new EditorView({
    parent: window.document.body,
    state: EditorState.create({
      doc: "",
      extensions: [neovimExtension(controller, { name: () => "cursor.md", save: async () => {} })],
    }),
  });
  t.after(() => { controller.stop(); view.destroy(); window.close(); });
  const cursor = () => view.contentDOM.querySelector<HTMLElement>(".neovim-block-cursor");
  const key = (value: string) => view.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: value, bubbles: true, cancelable: true,
  }));
  const normal = async () => waitFor(() => status === "NORMAL" && view.dom.dataset.neovimCursor === "block" && !!cursor(), "normal block");
  view.focus();
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await normal();
  assert.ok(cursor()!.classList.contains("neovim-block-cursor-empty"), "empty document has a cursor cell");
  assert.equal(cursor()!.getAttribute("aria-hidden"), "true");
  assert.equal(view.state.doc.toString(), "", "the empty cell is not document text");
  const otherInput = window.document.createElement("input");
  window.document.body.append(otherInput);
  otherInput.focus();
  await new Promise((resolve) => setTimeout(resolve, 30));
  view.focus();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(view.dom.classList.contains("neovim-connected"), "CodeMirror focus updates preserve cursor styling");

  key("i");
  await waitFor(() => status === "INSERT" && !cursor(), "insert restores native caret");
  assert.equal(view.dom.dataset.neovimCursor, "native");
  for (const value of ["日", "😀", "e", "\u0301", "Enter", "Enter", "x"]) key(value);
  key("Escape");
  await normal();
  const text = "日😀e\u0301\n\nx";
  assert.equal(view.state.doc.toString(), text);
  key("k");
  await waitFor(() => !!cursor()?.classList.contains("neovim-block-cursor-empty"), "blank middle line has a cell");
  assert.equal(view.contentDOM.querySelector(".neovim-cursor-line"), cursor()!.closest(".cm-line"));
  key("k"); key("0");
  await waitFor(() => cursor()?.textContent === "日", "wide Japanese character");
  key("l");
  await waitFor(() => cursor()?.textContent === "😀", "emoji is not split at a surrogate");
  key("l");
  await waitFor(() => cursor()?.textContent === "e\u0301", "combining character stays in one cursor");

  for (const value of ":set virtualedit=onemore") key(value);
  key("Enter");
  await normal();
  key("$"); key("l");
  await waitFor(() => !!cursor()?.classList.contains("neovim-block-cursor-empty"), "cursor after the last character");
  assert.equal(view.state.selection.main.head, view.state.doc.line(1).to);
  assert.equal(view.state.doc.toString(), text, "line-end widget does not add spaces");
  key("h");
  await waitFor(() => cursor()?.textContent === "e\u0301", "moving back removes empty cell");

  key("v"); key("h");
  await waitFor(() => status === "VISUAL" && cursor()?.textContent === "😀", "visual cursor remains at the active end");
  assert.equal(view.contentDOM.querySelector(".neovim-cursor-line"), null);
  key("Escape");
  await normal();
  key("R");
  await waitFor(() => status === "REPLACE" && !cursor(), "replace restores native caret");
  assert.equal(view.dom.dataset.neovimCursor, "native");
  key("Escape");
  await normal();
  key(":");
  await waitFor(() => status === "COMMAND" && !cursor(), "command mode clears block");
  key("Escape");
  await normal();

  view.contentDOM.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
  assert.equal(view.dom.dataset.neovimCursor, "native", "IME composition keeps its native caret");
  view.contentDOM.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }));
  await normal();
  assert.equal(view.state.doc.toString(), text);

  controller.stop();
  await waitFor(() => !cursor(), "disconnect removes all cursor decorations");
  assert.equal(view.dom.dataset.neovimCursor, undefined);
  assert.equal(view.contentDOM.querySelector(".neovim-cursor-line"), null);
  assert.deepEqual(errors, []);
});

test("scope routing owns Vim Ctrl keys before host hotkeys and keeps native paste while typing", async (t) => {
  const dom = editorDOM();
  const { window } = dom;
  const router = new EditorKeyRouter();
  let status = "";
  let hostHotkeys = 0;
  let readingToggles = 0;
  const errors: Error[] = [];
  const controller = new EditorController({
    status: (value) => { status = value; }, commandLine: () => {}, message: () => {}, error: (error) => errors.push(error),
  });
  // Obsidian dispatches scopes and host hotkeys in the window's capture phase.
  window.addEventListener("keydown", (event) => {
    if (router.handle(event)) { event.stopPropagation(); return; }
    if (event.ctrlKey && event.key === "e") { readingToggles++; event.preventDefault(); event.stopPropagation(); }
    if (event.ctrlKey && event.key === "r") { hostHotkeys++; event.preventDefault(); event.stopPropagation(); }
  }, true);
  const view = new EditorView({
    parent: window.document.body,
    state: EditorState.create({
      doc: "ab1\ncd2",
      extensions: [neovimExtension(controller, {
        name: () => "keys.md", save: async () => {}, registerKeys: (view, handler) => router.register(view.contentDOM, handler),
      })],
    }),
  });
  t.after(() => { controller.stop(); view.destroy(); window.close(); });
  const key = (value: string, ctrlKey = false) => {
    const event = new window.KeyboardEvent("keydown", { key: value, ctrlKey, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    return event;
  };
  view.focus();
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => status === "NORMAL", "normal mode");
  key("e", true);
  assert.equal(readingToggles, 1, "Normal Ctrl-E reaches Obsidian's reading toggle");
  assert.equal(key("v", true).defaultPrevented, true);
  await waitFor(() => status === "VISUAL BLOCK", "Ctrl-V reaches real Neovim");
  key("j"); key("l");
  await waitFor(() => view.dom.dataset.neovimSelection === "block" && view.state.selection.main.head === 5, "block selection reaches the editor");
  assert.equal(view.state.selection.main.empty, true, "drawing the block does not create a contiguous text selection");
  key("d");
  await waitFor(() => view.state.doc.toString() === "1\n2", "rectangular deletion affects both lines");
  assert.equal(view.dom.dataset.neovimSelection, "none", "editing clears the selection layer");
  key("u");
  await waitFor(() => view.state.doc.toString() === "ab1\ncd2", "undo block deletion");
  key("r", true);
  await waitFor(() => view.state.doc.toString() === "1\n2", "Vim redo beats conflicting host shortcut");
  assert.equal(hostHotkeys, 0);
  key("i");
  await waitFor(() => status === "INSERT", "insert mode");
  key("e", true);
  assert.equal(readingToggles, 2, "Insert Ctrl-E reaches Obsidian's reading toggle");
  assert.equal(key("v", true).defaultPrevented, false, "Insert Ctrl-V remains native paste");
  for (const value of ["a", "x", "s", "p", "f"]) assert.equal(key(value, true).defaultPrevented, false, `native Ctrl-${value}`);
  key("Escape");
  await waitFor(() => status === "NORMAL", "return to normal");
  const input = window.document.createElement("input");
  window.document.body.append(input);
  input.focus();
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(hostHotkeys, 1, "inputs outside the editor retain host shortcuts");
  controller.stop();
  key("r", true);
  assert.equal(hostHotkeys, 2, "stopped plugin releases the scope shortcut");
  assert.deepEqual(errors, []);
});
