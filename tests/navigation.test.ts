import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { App, MarkdownView, Scope, View, WorkspaceLeaf } from "obsidian";
import { EditorKeyRouter } from "../src/editor/key-router";
import { WorkspaceNavigation } from "../src/obsidian/navigation";

type Handler = { key: string | null; callback: (event: KeyboardEvent) => unknown };
// Model Obsidian's public Scope contract: a handled child stops parent hotkeys.
class TestScope {
  handlers: Handler[] = [];
  constructor(readonly parent?: TestScope) {}
  register(_modifiers: unknown, key: string | null, callback: Handler["callback"]): Handler {
    const handler = { key, callback };
    this.handlers.push(handler);
    return handler;
  }
  unregister(handler: Handler): void { this.handlers = this.handlers.filter((item) => item !== handler); }
  handle(event: KeyboardEvent): unknown {
    for (const handler of this.handlers) {
      if (handler.key !== null && handler.key !== event.key) continue;
      const result = handler.callback(event);
      if (result !== undefined || handler.key !== null) return result;
    }
    return this.parent?.handle(event);
  }
}

test("reading view scrolls with j/k and leaves editing, controls, modifiers, and modal scopes alone", async (t) => {
  const dom = new JSDOM("<body></body>", { pretendToBeVisual: true });
  const { window } = dom;
  const rootScope = new TestScope();
  let hostKeys = 0;
  rootScope.register(null, "j", () => { hostKeys++; });
  let mode = "preview";
  let ready = true;
  const scrolls: ScrollToOptions[] = [];
  const containerEl = window.document.createElement("div");
  containerEl.innerHTML = '<input aria-label="Search"><div contenteditable="true">Title</div>' +
    '<div class="markdown-reading-view"><div class="markdown-preview-view"><p>Long note</p><input><textarea></textarea><select></select>' +
    '<div contenteditable="true"><span>Editable</span></div></div></div>';
  window.document.body.append(containerEl);
  const preview = containerEl.querySelector<HTMLElement>(".markdown-preview-view")!;
  const reading = containerEl.querySelector<HTMLElement>(".markdown-reading-view")!;
  reading.scrollBy = () => { assert.fail("the reading wrapper does not scroll"); };
  preview.scrollBy = ((options: ScrollToOptions) => { scrolls.push(options); }) as typeof preview.scrollBy;
  const original = new TestScope(rootScope);
  const leaf = { view: undefined as unknown as MarkdownView };
  leaf.view = { leaf, containerEl, scope: original, getViewType: () => "markdown", getMode: () => mode,
    previewMode: { containerEl: reading } } as unknown as MarkdownView;
  const otherLeaf = { view: {} };
  const workspace = {
    activeLeaf: leaf as typeof leaf | typeof otherLeaf,
    iterateAllLeaves: (callback: (leaf: unknown) => void) => callback(leaf),
  };
  const navigation = new WorkspaceNavigation({ workspace, scope: rootScope } as unknown as App,
    (parent) => new TestScope(parent as unknown as TestScope) as unknown as Scope,
    new EditorKeyRouter(), () => ready, () => false, (error) => { throw error; });
  t.after(() => { navigation.destroy(); window.close(); });
  navigation.refresh();
  let modal: TestScope | undefined;
  window.addEventListener("keydown", (event) => {
    const scope = modal ?? leaf.view.scope as unknown as TestScope;
    if (scope.handle(event) === false) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  const key = (target: HTMLElement, value: string, options: KeyboardEventInit = {}) => {
    const event = new window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
  };
  const paragraph = preview.querySelector("p")!;
  assert.equal(key(paragraph, "j").defaultPrevented, true);
  assert.equal(key(paragraph, "j", { repeat: true }).defaultPrevented, true);
  assert.equal(key(paragraph, "k").defaultPrevented, true);
  assert.deepEqual(scrolls, [
    { top: 40, behavior: "instant" }, { top: 40, behavior: "instant" }, { top: -40, behavior: "instant" },
  ]);
  assert.equal(hostKeys, 0, "reading shortcuts take priority over application hotkeys");
  assert.equal(paragraph.textContent, "Long note");
  assert.equal(key(window.document.body, "j").defaultPrevented, true, "reading works with body focus after a mode switch");
  assert.equal(key(containerEl, "k").defaultPrevented, true);
  // Obsidian replaces the view scope for note search, then resets it to the
  // original scope on close without emitting a workspace layout event.
  const search = window.document.createElement("input");
  leaf.view.scope = new TestScope(leaf.view.scope as unknown as TestScope) as unknown as Scope;
  reading.prepend(search);
  await Promise.resolve();
  assert.equal(key(search, "j").defaultPrevented, false);
  leaf.view.scope = original as unknown as Scope;
  search.remove();
  await Promise.resolve();
  assert.equal(key(window.document.body, "j").defaultPrevented, true, "j works after closing search with body focus");
  assert.equal(key(paragraph, "k").defaultPrevented, true, "k works after returning focus to the reading content");
  const handled = scrolls.length;
  for (const target of containerEl.querySelectorAll<HTMLElement>("input, textarea, select, [contenteditable] span, [contenteditable]")) {
    for (const value of ["j", "k"]) assert.equal(key(target, value).defaultPrevented, false);
  }
  for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    assert.equal(key(paragraph, "j", options).defaultPrevented, false);
  }
  assert.equal(key(paragraph, "x").defaultPrevented, false);
  const outside = window.document.createElement("button");
  window.document.body.append(outside);
  assert.equal(key(outside, "j").defaultPrevented, false);
  workspace.activeLeaf = otherLeaf;
  assert.equal(key(window.document.body, "j").defaultPrevented, false, "body focus belongs to the active pane");
  workspace.activeLeaf = leaf;
  modal = new TestScope(rootScope);
  assert.equal(key(paragraph, "j").defaultPrevented, false);
  modal = undefined;
  mode = "source";
  assert.equal(key(paragraph, "j").defaultPrevented, false, "switching back to editing releases reading shortcuts");
  mode = "preview";
  ready = false;
  assert.equal(key(paragraph, "j").defaultPrevented, false);
  ready = true;
  navigation.destroy();
  assert.equal(leaf.view.scope, original);
  assert.equal(key(paragraph, "j").defaultPrevented, false, "unloading releases reading shortcuts");
  reading.append(window.document.createElement("p"));
  await Promise.resolve();
  assert.equal(leaf.view.scope, original, "DOM changes after unloading do not reattach a scope");
  assert.equal(scrolls.length, handled, "ignored keys never scroll the preview");
});

test("view scopes prioritize editor keys, navigate native sidebar trees, and restore scopes on unload", async () => {
  const dom = new JSDOM("<body></body>", { pretendToBeVisual: true });
  const { window } = dom;
  const rootScope = new TestScope();
  let hostHotkeys = 0;
  rootScope.register(null, "r", () => { hostHotkeys++; return false; });
  const leftSplit = {};
  const rightSplit = {};
  const center = {};
  let ready = true;
  let navigationEnabled = true;
  let vimKeys = 0;
  const arrows: string[] = [];
  const errors: unknown[] = [];
  const leaf = (type: string, root: object, x: number): WorkspaceLeaf => {
    const containerEl = window.document.createElement("div");
    containerEl.innerHTML = type === "markdown" ? '<div class="cm-content" contenteditable="true" tabindex="0"></div>' :
      '<div class="nav-files-container"><div class="tree-item-self has-focus">folder</div><input aria-label="Rename"></div>';
    window.document.body.append(containerEl);
    containerEl.getBoundingClientRect = () => new window.DOMRect(x, 0, 200, 500);
    containerEl.getClientRects = () => [containerEl.getBoundingClientRect()] as unknown as DOMRectList;
    const scope = new TestScope(rootScope);
    if (type === "file-explorer") {
      for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"]) {
        scope.register([], key, (event) => {
          arrows.push(event.key);
          event.preventDefault();
          // Obsidian deliberately blurs the DOM focus on ArrowDown; the leaf
          // and the tree's internally focused item remain selected.
          if (event.key === "ArrowDown") (window.document.activeElement as HTMLElement | null)?.blur();
        });
      }
    }
    const result = { getRoot: () => root, view: undefined as unknown as View } as WorkspaceLeaf;
    result.view = { scope, leaf: result, containerEl, getViewType: () => type,
      getMode: () => "source",
      editor: { focus: () => containerEl.querySelector<HTMLElement>(".cm-content")!.focus() } } as unknown as View;
    return result;
  };
  const files = leaf("file-explorer", leftSplit, 0);
  const editor = leaf("markdown", center, 200);
  const secondEditor = leaf("markdown", center, 400);
  const outline = leaf("outline", rightSplit, 600);
  const leaves = [files, editor, secondEditor, outline];
  const originals = leaves.map((leaf) => leaf.view.scope);
  const workspace = {
    activeLeaf: editor, leftSplit, rightSplit,
    iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void) => leaves.forEach(callback),
    getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.view.getViewType() === type),
    getMostRecentLeaf: (root: object) => leaves.find((leaf) => leaf.getRoot() === root),
    revealLeaf: async (_leaf: WorkspaceLeaf) => {},
    setActiveLeaf: (leaf: WorkspaceLeaf) => { workspace.activeLeaf = leaf; },
  };
  const router = new EditorKeyRouter();
  const unregister = router.register(editor.view.containerEl.querySelector<HTMLElement>(".cm-content")!, (event) => {
    if (ready && event.ctrlKey && event.key === "r") { vimKeys++; event.preventDefault(); }
  });
  const navigation = new WorkspaceNavigation({ workspace, scope: rootScope } as unknown as App,
    (parent) => new TestScope(parent as unknown as TestScope) as unknown as Scope,
    router, () => ready, () => navigationEnabled, (error) => errors.push(error));
  let modal: TestScope | undefined;
  window.addEventListener("keydown", (event) => {
    const scope = modal ?? workspace.activeLeaf.view.scope as unknown as TestScope;
    if (scope.handle(event) === false) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  const key = (element: HTMLElement, key: string, modifiers: KeyboardEventInit = {}) => {
    const event = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
    element.dispatchEvent(event);
    return event;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    navigation.refresh();
    const content = editor.view.containerEl.querySelector<HTMLElement>(".cm-content")!;
    assert.equal(key(content, "r", { ctrlKey: true }).defaultPrevented, true);
    assert.equal(vimKeys, 1);
    assert.equal(hostHotkeys, 0);
    modal = new TestScope(rootScope);
    key(content, "r", { ctrlKey: true });
    assert.equal(vimKeys, 1, "modal scope takes priority over the editor");
    assert.equal(hostHotkeys, 1);
    modal = undefined;

    await navigation.navigate("left");
    assert.equal(workspace.activeLeaf, files);
    const tree = files.view.containerEl.querySelector<HTMLElement>(".nav-files-container")!;
    assert.equal(window.document.activeElement, tree);
    key(tree, "j");
    assert.equal(window.document.activeElement, window.document.body, "native ArrowDown releases DOM focus");
    for (const value of ["k", "h", "l", "Enter"]) key(window.document.activeElement as HTMLElement, value);
    assert.deepEqual(arrows, ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter"]);
    const outside = window.document.createElement("button");
    window.document.body.append(outside);
    outside.focus();
    assert.equal(key(outside, "j").defaultPrevented, false, "a focused control outside the sidebar keeps its keys");
    outside.blur();
    modal = new TestScope(rootScope);
    assert.equal(key(window.document.body, "j").defaultPrevented, false, "a modal keeps priority over sidebar aliases");
    modal = undefined;
    const rename = tree.querySelector("input")!;
    for (const value of ["j", "h", "Escape"]) assert.equal(key(rename, value).defaultPrevented, false);
    assert.equal(arrows.length, 5, "renaming does not navigate the tree");
    assert.equal(workspace.activeLeaf, files);
    assert.equal(key(window.document.body, "j", { isComposing: true }).defaultPrevented, false);
    navigationEnabled = false;
    assert.equal(key(window.document.body, "j").defaultPrevented, false);
    navigationEnabled = true;
    key(window.document.body, "w", { ctrlKey: true }); key(window.document.body, "l");
    await settle();
    assert.equal(workspace.activeLeaf, editor, "Ctrl-W l returns from the left sidebar");
    assert.equal(window.document.activeElement, content);

    await navigation.navigate("right");
    assert.equal(workspace.activeLeaf, secondEditor, "adjacent editor wins before the right sidebar");
    await navigation.navigate("right");
    assert.equal(workspace.activeLeaf, outline);
    key(outline.view.containerEl, "Escape");
    await settle();
    assert.equal(workspace.activeLeaf, secondEditor, "Escape restores the most recent editor");

    await navigation.focusSidebar("left");
    key(tree, "w", { ctrlKey: true });
    await navigation.focusSidebar("right");
    assert.equal(key(outline.view.containerEl, "l").defaultPrevented, false, "pane changes cancel sidebar prefixes");
    await navigation.focusSidebar("left");
    key(tree, "j");
    key(window.document.body, "Escape");
    await settle();
    assert.equal(workspace.activeLeaf, secondEditor, "Escape works after native tree navigation blurs the DOM");
    await navigation.focusEditor();
    const reading = secondEditor.view as MarkdownView;
    reading.getMode = () => "preview";
    const wrapper = window.document.createElement("div");
    wrapper.className = "markdown-reading-view";
    const preview = window.document.createElement("div");
    preview.className = "markdown-preview-view";
    wrapper.append(preview);
    reading.containerEl.append(wrapper);
    reading.previewMode = { containerEl: wrapper } as unknown as MarkdownView["previewMode"];
    let readingScrolls = 0;
    preview.scrollBy = () => { readingScrolls++; };
    await navigation.focusSidebar("left");
    key(tree, "Escape");
    await settle();
    assert.equal(window.document.activeElement, preview, "returning to a reading pane focuses its preview");
    assert.equal(key(preview, "j").defaultPrevented, true);
    assert.equal(readingScrolls, 1);
    workspace.activeLeaf = editor;
    ready = false;
    key(content, "r", { ctrlKey: true });
    assert.equal(hostHotkeys, 2, "stopped Neovim releases host hotkeys");
    navigation.destroy();
    leaves.forEach((leaf, index) => assert.equal(leaf.view.scope, originals[index]));
    assert.equal(tree.hasAttribute("tabindex"), false);
    assert.equal(preview.hasAttribute("tabindex"), false);
    assert.deepEqual(errors, []);
  } finally { unregister(); navigation.destroy(); dom.window.close(); }
});
