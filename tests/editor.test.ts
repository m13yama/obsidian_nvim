import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { EditorController, type EditorPort, type StatusDetails } from "../src/editor/controller";
import { neovimExtension } from "../src/editor/extension";
import { EditorKeyRouter } from "../src/editor/key-router";
import type { App, EditorPosition } from "obsidian";
import { ReadingPositionSync } from "../src/obsidian/reading-position";
import { NeovimSession } from "../src/neovim/session";

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

test("zz centers the real Neovim cursor in CodeMirror, including counts, repeats, and Visual mode", async (t) => {
  const dom = editorDOM();
  const { window } = dom;
  const errors: Error[] = [];
  let status = "";
  const centered: number[] = [];
  const controller = new EditorController({
    status: (value) => { status = value; }, commandLine: () => {}, message: () => {}, error: (error) => errors.push(error),
  });
  const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const view = new EditorView({
    parent: window.document.body,
    state: EditorState.create({ doc: text, extensions: [
      neovimExtension(controller, { name: () => "scroll.md", save: async () => {} }),
      EditorView.scrollHandler.of((_view, range, options) => {
        if (options.y === "center") centered.push(range.head);
        return true;
      }),
    ] }),
  });
  t.after(() => { controller.stop(); view.destroy(); window.close(); });
  // jsdom has no layout; give CodeMirror a viewport so it flushes scroll requests.
  Object.defineProperty(view.scrollDOM, "clientHeight", { value: 400 });
  const key = (value: string) => view.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: value, bubbles: true, cancelable: true,
  }));
  const keys = (values: string) => { for (const value of values) key(value); };
  view.focus();
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => status === "NORMAL", "normal mode");
  keys("50G");
  await waitFor(() => view.state.selection.main.head === view.state.doc.line(50).from, "cursor on line 50");
  key("z");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(centered, [], "a single z remains a pending Vim command");
  key("z");
  await waitFor(() => centered.length === 1, "zz reaches CodeMirror's center scroll handler");
  assert.equal(centered[0], view.state.doc.line(50).from);
  keys("zz");
  await waitFor(() => centered.length === 2, "zz works again without moving the cursor");
  assert.equal(centered[1], centered[0]);
  keys("70zz");
  await waitFor(() => centered.length === 3, "counted zz centers the destination line");
  assert.equal(centered[2], view.state.doc.line(70).from);
  assert.equal(view.state.selection.main.head, centered[2]);
  keys("vj");
  await waitFor(() => status === "VISUAL" && !view.state.selection.main.empty, "visual selection");
  const selection = view.state.selection.main;
  keys("zz");
  await waitFor(() => centered.length === 4, "Visual zz centers the cursor");
  assert.equal(centered[3], view.state.doc.line(71).from);
  assert.ok(view.state.selection.main.eq(selection), "centering preserves the visual selection");
  assert.equal(status, "VISUAL");
  assert.equal(view.state.doc.toString(), text, "scrolling never changes note text");
  key("Escape");
  await waitFor(() => status === "NORMAL", "leave visual mode");
  keys("qazzq");
  await waitFor(() => centered.length === 5, "record a zz macro");
  keys("@a");
  await waitFor(() => centered.length === 6, "macro playback centers the cursor");
  key("i");
  await waitFor(() => status === "INSERT", "insert mode");
  keys("zz");
  key("Escape");
  await waitFor(() => status === "NORMAL" && view.state.doc.line(71).text === "zzline 71", "insert zz stays literal text");
  assert.equal(centered.length, 6);
  assert.deepEqual(errors, []);
});

test("editing after reading scroll synchronizes the cursor before the next real Neovim command", async (t) => {
  const dom = editorDOM();
  const errors: Error[] = [];
  let details: StatusDetails | undefined;
  const controller = new EditorController({
    status: (_status, value) => { details = value; }, commandLine: () => {}, message: () => {},
    error: (error) => errors.push(error),
  });
  const text = Array.from({ length: 100 }, (_, i) => `第${i + 1}行 😀`).join("\n");
  const view = new EditorView({ parent: dom.window.document.body,
    state: EditorState.create({ doc: text, extensions: [neovimExtension(controller, { name: () => "reading.md", save: async () => {} })] }),
  });
  const scrolls: number[] = [];
  const markdown = {
    file: { path: "reading.md" }, mode: "source", getMode() { return this.mode; },
    previewMode: { getScroll: () => 56.75 },
    currentMode: { applyScroll: (scroll: number) => { scrolls.push(scroll); } },
    editor: {
      lineCount: () => view.state.doc.lines,
      setCursor: (position: EditorPosition) => view.dispatch({ selection: { anchor: view.state.doc.line(position.line + 1).from + position.ch } }),
    },
    async setState(state: { mode: string }) { this.mode = state.mode; },
  };
  const sync = new ReadingPositionSync({ workspace: { getLeavesOfType: () => [{ view: markdown }] } } as unknown as App, () => controller.ready);
  t.after(() => { sync.destroy(); controller.stop(); view.destroy(); dom.window.close(); });
  sync.refresh();
  view.focus();
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => details?.line === 1, "initial cursor");
  await markdown.setState({ mode: "preview" });
  view.contentDOM.blur();
  await markdown.setState({ mode: "source" });
  view.focus();
  assert.equal(view.state.doc.toString(), text, "switching mode changes no note text");
  assert.equal(view.state.selection.main.head, view.state.doc.line(57).from);
  // Type immediately: queued host selection updates must precede the Vim command.
  view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
  await waitFor(() => view.state.doc.line(57).text === "57行 😀", "editing starts at the reading position");
  assert.equal(view.state.doc.line(1).text, "第1行 😀", "the previous cursor location is not edited");
  assert.equal(details?.line, 57);
  assert.deepEqual(scrolls, [56.75]);
  assert.deepEqual(errors, []);
});

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
    apply: () => {}, applyText: () => {}, setConnected: () => {}, save: async () => {},
  };
  t.after(() => controller.stop());
  controller.register(port);
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "", navigation: true });
  controller.focus(port);
  await waitFor(() => mode === "NORMAL", "note is active");
  controller.input(port, "<C-w>");
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.resize(port, 100, 30);
  controller.input(port, "l");
  await waitFor(() => direction === "right", "navigation finishes across a pending resize");
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
  let sidebarFocuses = 0;
  const errors: Error[] = [];
  const controller = new EditorController({
    status: (value) => { status = value; }, commandLine: () => {}, message: () => {}, error: (error) => errors.push(error),
  });
  // Obsidian dispatches scopes and host hotkeys in the window's capture phase.
  window.addEventListener("keydown", (event) => {
    if (router.handle(event)) { event.stopPropagation(); return; }
    if (event.ctrlKey && event.key === "e") { readingToggles++; event.preventDefault(); event.stopPropagation(); }
    if (event.ctrlKey && event.key === "0") { sidebarFocuses++; event.preventDefault(); event.stopPropagation(); }
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
  key("0", true);
  assert.equal(sidebarFocuses, 1, "Normal Ctrl-0 reaches Obsidian's sidebar command");
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
  key("0", true);
  assert.equal(sidebarFocuses, 2, "Insert Ctrl-0 reaches Obsidian's sidebar command");
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

test("file buffers retain undo across note switches, split views, and rename, and reset on deletion", async (t) => {
  const { window } = editorDOM();
  const errors: Error[] = [];
  const controller = new EditorController({
    status: () => {}, commandLine: () => {}, message: () => {}, error: (error) => errors.push(error),
  });
  const fileA = { path: "first.md" }, fileB = { path: "second.md" };
  const state = (file: { path: string }, text: string) => EditorState.create({ doc: text, extensions: [
    neovimExtension(controller, { name: () => file.path, key: () => file, save: async () => {} }),
  ] });
  const first = new EditorView({ parent: window.document.body, state: state(fileA, "hello world") });
  let second: EditorView | undefined;
  t.after(() => { controller.stop(); first.destroy(); second?.destroy(); window.close(); });
  const key = (view: EditorView, value: string) => view.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  first.focus();
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  key(first, "d"); key(first, "w");
  await waitFor(() => first.state.doc.toString() === "world", "first edit");
  first.setState(state(fileB, "other note"));
  key(first, "A"); key(first, "!"); key(first, "Escape");
  await waitFor(() => first.state.doc.toString() === "other note!", "second note edit");
  first.setState(state(fileA, "world"));
  key(first, "u");
  await waitFor(() => first.state.doc.toString() === "hello world", "undo retained after A to B to A");
  key(first, "d"); key(first, "w");
  await waitFor(() => first.state.doc.toString() === "world", "delete before opening split");
  second = new EditorView({ parent: window.document.body, state: state(fileA, "world") });
  second.focus();
  key(second, "u");
  await waitFor(() => first.state.doc.toString() === "hello world" && second!.state.doc.toString() === "hello world", "split uses the same undo history and updates both views");
  // Each pane keeps its own cursor, including when the other pane changes text.
  first.dispatch({ selection: { anchor: 6 } });
  key(second, "0"); key(second, "x");
  await waitFor(() => first.state.doc.toString() === "ello world" && second!.state.doc.toString() === "ello world", "text shared across views");
  assert.equal(first.state.selection.main.head, 5, "background pane's selection maps through the edit without adopting the active cursor");
  first.focus();
  key(first, "l");
  await waitFor(() => first.state.selection.main.head === 6, "focus restores the first pane's cursor");
  fileA.path = "renamed.md";
  controller.rename(fileA, fileA.path);
  first.dispatch({}); second.dispatch({});
  key(first, "u");
  await waitFor(() => first.state.doc.toString() === "hello world", "renaming retains undo");
  controller.forget(fileA);
  first.setState(state({ path: "renamed.md" }, "replacement"));
  key(first, "u");
  key(first, "A"); key(first, "!"); key(first, "Escape");
  await waitFor(() => first.state.doc.toString() === "replacement!", "recreated file gets a fresh undo buffer");
  assert.deepEqual(errors, []);
});

test("cursor-only host changes preserve pending Neovim edits without sending text back", async (t) => {
  const { window } = editorDOM();
  const errors: Error[] = [];
  let writes = 0;
  const originalChange = NeovimSession.prototype.change;
  t.mock.method(NeovimSession.prototype, "change", function (this: NeovimSession, ...args: Parameters<typeof originalChange>) {
    writes++;
    return originalChange.apply(this, args);
  });
  const controller = new EditorController({ status: () => {}, commandLine: () => {}, message: () => {}, error: (error) => errors.push(error) });
  const view = new EditorView({ parent: window.document.body, state: EditorState.create({ doc: "abcde", extensions: [
    neovimExtension(controller, { name: () => "selection.md", save: async () => {} }),
  ] }) });
  t.after(() => { controller.stop(); view.destroy(); window.close(); });
  const key = (key: string) => view.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  view.focus();
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  key("x");
  view.dispatch({ selection: { anchor: 3 } });
  key("l");
  await waitFor(() => view.state.doc.toString() === "bcde" && view.state.selection.main.head === 3, "deletion survives mouse selection and next motion starts at its mapped position");
  assert.equal(writes, 0, "selection changes never transmit document text");
  key("u");
  await waitFor(() => view.state.doc.toString() === "abcde", "cursor sync does not add an undo entry");
  assert.deepEqual(errors, []);
});

test("host edits rebase against a native edit arriving before the diff is applied", async (t) => {
  const { window } = editorDOM();
  const errors: Error[] = [];
  let mode = "", retries = 0, injected = false;
  const originalChange = NeovimSession.prototype.change;
  t.mock.method(NeovimSession.prototype, "change", async function (this: NeovimSession, ...args: Parameters<typeof originalChange>) {
    if (!injected) {
      injected = true;
      await this.input("x");
      await this.snapshot();
    }
    const accepted = await originalChange.apply(this, args);
    if (!accepted) retries++;
    return accepted;
  });
  const controller = new EditorController({ status: (value) => { mode = value; }, commandLine: () => {}, message: () => {}, error: (error) => errors.push(error) });
  const view = new EditorView({ parent: window.document.body, state: EditorState.create({ doc: "abcde", extensions: [
    neovimExtension(controller, { name: () => "concurrent.md", save: async () => {} }),
  ] }) });
  t.after(() => { controller.stop(); view.destroy(); window.close(); });
  view.focus();
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => mode === "NORMAL", "active note");
  view.dispatch({ changes: { from: 5, insert: "日本😀" }, selection: { anchor: 9 } });
  await waitFor(() => view.state.doc.toString() === "bcde日本😀" && retries > 0, "both edits survive changedtick retry");
  view.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
  await waitFor(() => view.state.doc.toString() === "bcde日本", "the next key uses the rebased Unicode cursor");
  assert.deepEqual(errors, []);
});

test("background buffer edits update its views and survive returning to that note", async (t) => {
  const { window } = editorDOM();
  const errors: Error[] = [];
  let mode = "";
  const controller = new EditorController({ status: (value) => { mode = value; }, commandLine: () => {}, message: () => {}, error: (error) => errors.push(error) });
  const create = (name: string, text: string) => new EditorView({ parent: window.document.body, state: EditorState.create({ doc: text, extensions: [
    neovimExtension(controller, { name: () => name, save: async () => {} }),
  ] }) });
  const first = create("background.md", "original"), second = create("active.md", "active");
  t.after(() => { controller.stop(); first.destroy(); second.destroy(); window.close(); });
  first.focus();
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  await waitFor(() => mode === "NORMAL", "first buffer initialized");
  second.focus();
  const keys = ":lua for b,e in pairs(obsidian_bridge.buffers) do if vim.api.nvim_buf_get_name(b):match('/background.md$') then vim.api.nvim_buf_set_lines(b,0,-1,true,{'background edit'}) end end";
  for (const key of [...keys, "Enter"]) second.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await waitFor(() => first.state.doc.toString() === "background edit", "non-current buffer sends text changes");
  assert.equal(second.state.doc.toString(), "active");
  first.focus();
  first.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", { key: "u", bubbles: true, cancelable: true }));
  await waitFor(() => first.state.doc.toString() === "original", "background edit remains undoable after focus returns");
  assert.deepEqual(errors, []);
});

test("transient file metadata during asynchronous note loading cannot contaminate another file's buffer", async (t) => {
  const { window } = editorDOM();
  const errors: Error[] = [];
  const controller = new EditorController({ status: () => {}, commandLine: () => {}, message: () => {}, error: (error) => errors.push(error) });
  const first = { path: "first.md" }, second = { path: "second.md" };
  let file = first;
  let loaded = true;
  const state = (text: string) => EditorState.create({ doc: text, extensions: [
    neovimExtension(controller, { name: () => file.path, key: () => file, isLoaded: () => loaded, save: async () => {} }),
  ] });
  const view = new EditorView({ parent: window.document.body, state: state("hello world") });
  t.after(() => { controller.stop(); view.destroy(); window.close(); });
  const key = (key: string) => view.contentDOM.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  view.focus();
  await controller.start({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" });
  key("d"); key("w");
  await waitFor(() => view.state.doc.toString() === "world", "edit first note");
  loaded = false;
  view.setState(state(""));
  await new Promise((resolve) => setTimeout(resolve, 0));
  file = second;
  view.dispatch({ selection: { anchor: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  loaded = true;
  view.setState(state("other note"));
  key("A"); key("!"); key("Escape");
  await waitFor(() => view.state.doc.toString() === "other note!", "second note is independent");
  file = first;
  view.dispatch({ selection: { anchor: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.setState(state("world"));
  key("u");
  await waitFor(() => view.state.doc.toString() === "hello world", "undo restores only the first note's original text");
  assert.deepEqual(errors, []);
});
