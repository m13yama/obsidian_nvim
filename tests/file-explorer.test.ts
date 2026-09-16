import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { App, TAbstractFile, TFolder, View } from "obsidian";
import { FileExplorerActions } from "../src/obsidian/file-explorer";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
