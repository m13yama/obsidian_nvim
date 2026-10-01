import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { App, TAbstractFile, TFolder, View } from "obsidian";
import { FileExplorerActions, type ExplorerMotion } from "../src/obsidian/file-explorer";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("explorer jumps follow sorted, expanded items including rows outside the DOM", (t) => {
  const dom = new JSDOM('<div class="nav-files-container"></div>');
  t.after(() => dom.window.close());
  const containerEl = dom.window.document.body;
  const makeItem = (path: string, hidden = false) => ({ file: { path }, info: { hidden } });
  const child = makeItem("Expanded/Note.md");
  const expanded = { ...makeItem("Expanded"), vChildren: { children: [child] }, collapsed: false };
  const collapsed = { ...makeItem("Collapsed"), vChildren: { children: [makeItem("Collapsed/Hidden.md")] }, collapsed: true };
  const last = makeItem("A first alphabetically, last in the tree.md");
  const focused: unknown[] = [];
  const tree = {
    root: { vChildren: { children: [makeItem("Hidden", true), expanded, collapsed, last, makeItem("Hidden.md", true)] } },
    setFocusedItem: (item: unknown, scroll: boolean) => { assert.equal(scroll, true); focused.push(item); },
  };
  const view = { getViewType: () => "file-explorer", tree, containerEl, fileBeingRenamed: false };
  const errors: unknown[] = [];
  const actions = new FileExplorerActions({} as App, (error) => errors.push(error));
  const move = (motion: ExplorerMotion) => actions.moveFocus(view as unknown as View, motion);
  move("first"); move("last");
  assert.deepEqual(focused, [expanded, last]);
  tree.root.vChildren.children = [expanded];
  move("last");
  assert.equal(focused.at(-1), child, "last item can be a child of an expanded folder");
  expanded.collapsed = true;
  move("last");
  assert.equal(focused.at(-1), expanded, "collapsed children are skipped");
  tree.root.vChildren.children = [];
  move("first"); move("last");
  tree.root.vChildren.children = [last];
  view.fileBeingRenamed = true;
  move("first");
  assert.equal(focused.length, 4, "empty trees and active renames do not move focus");
  assert.deepEqual(errors, []);
});

test("explorer page motions use the viewport, clamp to boundaries, and keep native focus", (t) => {
  const dom = new JSDOM('<div class="nav-files-container"></div>');
  t.after(() => dom.window.close());
  const containerEl = dom.window.document.body;
  const container = containerEl.querySelector<HTMLElement>(".nav-files-container")!;
  Object.defineProperty(container, "clientHeight", { value: 240 });
  const items = Array.from({ length: 30 }, (_, index) => {
    const selfEl = dom.window.document.createElement("div");
    selfEl.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 200, 24);
    return { file: { path: `${index}.md` }, selfEl };
  });
  const tree = {
    root: { vChildren: { children: items } }, focusedItem: items[0],
    setFocusedItem: (item: typeof items[number], scroll: boolean) => { assert.equal(scroll, true); tree.focusedItem = item; },
  };
  const view = { getViewType: () => "file-explorer", tree, containerEl } as unknown as View;
  const errors: unknown[] = [];
  const actions = new FileExplorerActions({} as App, (error) => errors.push(error));
  for (const [motion, index] of [
    ["half-down", 5], ["page-down", 15], ["half-up", 10], ["page-up", 0], ["half-up", 0],
    ["last", 29], ["page-down", 29], ["half-up", 24],
  ] as const) {
    actions.moveFocus(view, motion);
    assert.equal(tree.focusedItem, items[index], motion);
  }
  tree.focusedItem = undefined;
  actions.moveFocus(view, "page-down");
  assert.equal(tree.focusedItem, items[0]);
  tree.focusedItem = undefined;
  actions.moveFocus(view, "page-up");
  assert.equal(tree.focusedItem, items.at(-1));
  assert.deepEqual(errors, []);
  actions.moveFocus({ getViewType: () => "file-explorer" } as View, "last");
  assert.match(String(errors[0]), /unavailable/, "missing internals are reported without throwing from a hotkey");
});

test("file actions use the explorer selection and native creation, rename, deletion, and split handlers", async (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const root = { path: "/", children: [], parent: null } as unknown as TFolder;
  const folder = { path: "Folder", children: [], parent: root } as unknown as TFolder;
  const file = { path: "Folder/Selected.md", extension: "md", parent: folder } as unknown as TAbstractFile;
  const calls: unknown[][] = [];
  const errors: unknown[] = [];
  const view = {
    getViewType: () => "file-explorer", tree: { focusedItem: { file } as { file: TAbstractFile } | null },
    createAbstractFile: async (...args: unknown[]) => { calls.push(["create", ...args]); },
    onKeyRename: (event: KeyboardEvent) => { event.preventDefault(); calls.push(["rename", view.tree.focusedItem?.file]); },
    onDeleteSelectedFiles: (event: KeyboardEvent) => { event.preventDefault(); calls.push(["delete with native prompt"]); },
    requestSort: () => { calls.push(["refresh"]); },
  };
  const app = {
    vault: { getRoot: () => root },
    workspace: { getLeaf: (...args: unknown[]) => {
      calls.push(["leaf", ...args]);
      return { openFile: async (file: TAbstractFile) => { calls.push(["open", file]); } };
    } },
  } as unknown as App;
  const actions = new FileExplorerActions(app, (error) => errors.push(error));
  const key = (value: string, options: KeyboardEventInit = {}) => actions.handle(view as unknown as View,
    new dom.window.KeyboardEvent("keydown", { key: value, cancelable: true, ...options }));
  for (const value of ["a", "A", "r", "d", "v", "R"]) assert.equal(key(value, { shiftKey: value === "A" || value === "R" }), true);
  await settle();
  assert.deepEqual(calls, [
    ["create", "file", folder, false], ["create", "folder", folder, false], ["rename", file],
    ["delete with native prompt"], ["leaf", "split", "vertical"], ["open", file], ["refresh"],
  ]);
  calls.length = 0;
  view.tree.focusedItem = { file: folder };
  key("a"); key("v");
  view.tree.focusedItem = null;
  key("A", { shiftKey: true });
  await settle();
  assert.deepEqual(calls, [["create", "file", folder, false], ["create", "folder", root, false]]);
  calls.length = 0;
  for (const value of ["a", "A", "r", "d", "y", "x", "p", "v", "R"]) {
    assert.equal(key(value, { repeat: true }), true);
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) assert.equal(key(value, options), false);
  }
  assert.equal(key("D", { shiftKey: true }), false);
  assert.deepEqual(calls, [], "repeats and modified keys do not perform file operations");
  assert.deepEqual(errors, []);
  actions.destroy();
});

test("file clipboard preserves native multi-selection, consumes cuts, and cleans up cut markers", async (t) => {
  const dom = new JSDOM('<div class="is-cut"></div>');
  t.after(() => dom.window.close());
  const marker = dom.window.document.querySelector("div")!;
  const pasted: unknown[] = [];
  const errors: unknown[] = [];
  type Clipboard = { clipboardData: { getData: (type: string) => string; setData: (type: string, data: string) => void } };
  const view = {
    getViewType: () => "file-explorer", itemsBeingCut: [] as { selfEl: HTMLElement }[],
    handleCopy: (event: Clipboard) => event.clipboardData.setData("obsidian/files", JSON.stringify({ operation: "copy", paths: ["One.md", "Folder"] })),
    handleCut: (event: Clipboard) => {
      view.itemsBeingCut = [{ selfEl: marker }];
      marker.classList.add("is-cut");
      event.clipboardData.setData("obsidian/files", JSON.stringify({ operation: "cut", paths: ["One.md", "Folder"] }));
    },
    handlePaste: async (event: Clipboard) => { pasted.push(JSON.parse(event.clipboardData.getData("obsidian/files"))); },
  };
  const actions = new FileExplorerActions({} as App, (error) => errors.push(error));
  const key = async (key: string) => {
    assert.equal(actions.handle(view as unknown as View, new dom.window.KeyboardEvent("keydown", { key })), true);
    await settle();
  };
  await key("p");
  assert.deepEqual(pasted, [], "empty clipboard is harmless");
  await key("y"); await key("p"); await key("p");
  assert.deepEqual(pasted, [
    { operation: "copy", paths: ["One.md", "Folder"] }, { operation: "copy", paths: ["One.md", "Folder"] },
  ]);
  await key("x");
  assert.equal(marker.classList.contains("is-cut"), true);
  await key("p"); await key("p");
  assert.equal(pasted.length, 3, "a cut is pasted only once");
  assert.deepEqual(pasted[2], { operation: "cut", paths: ["One.md", "Folder"] });
  assert.equal(marker.classList.contains("is-cut"), false);
  await key("x"); await key("y");
  assert.equal(marker.classList.contains("is-cut"), false, "copy cancels the previous cut marker");
  await key("x"); actions.destroy();
  assert.equal(marker.classList.contains("is-cut"), false, "unloading clears cut markers");
  assert.deepEqual(view.itemsBeingCut, []);
  assert.deepEqual(errors, []);
});

test("pasted cuts clear native selection while preserving focus and copy selection", async (t) => {
  for (const operation of ["cut", "copy"] as const) {
    await t.test(operation, async (t) => {
      const dom = new JSDOM();
      t.after(() => dom.window.close());
      const items = ["One.md", "Folder", "Next.md"].map((path) => ({
        file: { path }, selfEl: dom.window.document.createElement("div"),
      }));
      const tree = {
        focusedItem: items[0]!,
        selectedDoms: new Set<typeof items[number]>(),
        getSelectedItems: () => tree.selectedDoms.size ? [...tree.selectedDoms] : [tree.focusedItem],
        selectItem: (item: typeof items[number]) => {
          tree.selectedDoms.add(item);
          item.selfEl.classList.add("is-selected");
        },
        clearSelectedDoms: () => {
          for (const item of tree.selectedDoms) item.selfEl.classList.remove("is-selected");
          tree.selectedDoms.clear();
        },
      };
      tree.selectItem(items[0]!);
      tree.selectItem(items[1]!);
      type Clipboard = { clipboardData: { setData: (type: string, data: string) => void } };
      const copied: string[][] = [];
      const capture = (event: Clipboard, operation: "cut" | "copy") => {
        const paths = tree.getSelectedItems().map((item) => item.file.path);
        copied.push(paths);
        event.clipboardData.setData("obsidian/files", JSON.stringify({ operation, paths }));
      };
      let finishPaste!: () => void;
      const view = {
        getViewType: () => "file-explorer", tree,
        handleCut: (event: Clipboard) => capture(event, "cut"),
        handleCopy: (event: Clipboard) => capture(event, "copy"),
        handlePaste: async () => {
          await new Promise<void>((resolve) => { finishPaste = resolve; });
          // Obsidian selects pasted files and folders, then focuses the first item.
          tree.clearSelectedDoms();
          tree.selectItem(items[0]!);
          tree.selectItem(items[1]!);
          tree.focusedItem = items[0]!;
        },
      };
      const errors: unknown[] = [];
      const actions = new FileExplorerActions({} as App, (error) => errors.push(error));
      t.after(() => actions.destroy());
      const key = (key: string) => actions.handle(view as unknown as View,
        new dom.window.KeyboardEvent("keydown", { key }));
      key(operation === "cut" ? "x" : "y");
      key("p");
      assert.equal(tree.selectedDoms.size, 2, "selection is kept while paste is pending");
      finishPaste();
      await settle();
      assert.equal(tree.selectedDoms.size, operation === "cut" ? 0 : 2);
      for (const item of items.slice(0, 2)) {
        assert.equal(item.selfEl.classList.contains("is-selected"), operation === "copy");
      }
      assert.equal(tree.focusedItem, items[0], "the pasted item keeps keyboard focus");
      tree.focusedItem = items[2]!;
      key("y");
      assert.deepEqual(copied.at(-1), operation === "cut" ? ["Next.md"] : ["One.md", "Folder"],
        "after a move, the next operation uses the newly focused item");
      assert.deepEqual(errors, []);
    });
  }
});

test("missing explorer handlers report an error without falling back to destructive operations", async (t) => {
  const dom = new JSDOM();
  t.after(() => dom.window.close());
  const errors: unknown[] = [];
  const actions = new FileExplorerActions({} as App, (error) => errors.push(error));
  const view = { getViewType: () => "file-explorer" } as View;
  assert.equal(actions.handle(view, new dom.window.KeyboardEvent("keydown", { key: "d" })), true);
  await settle();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /unavailable/);
});
