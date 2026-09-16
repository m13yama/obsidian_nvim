import type { App, MarkdownView, Scope, View, WorkspaceLeaf } from "obsidian";
import type { EditorKeyRouter } from "../editor/key-router";
import type { NavigationDirection } from "../neovim/session";
import { FileExplorerActions } from "./file-explorer";

interface ScopeOverride {
  scope: Scope;
  original: Scope | null;
  handler: ReturnType<Scope["register"]>;
  observer?: MutationObserver;
}

const DIRECTIONS: Record<string, NavigationDirection> = { j: "down", k: "up", l: "right", p: "editor" };
const TREE_KEYS: Record<string, string> = { j: "ArrowDown", k: "ArrowUp", h: "ArrowLeft", l: "ArrowRight" };
const READING_SCROLL_STEP = 40;

/** View scopes run before Obsidian's application shortcuts, and below modal scopes. */
export class WorkspaceNavigation {
  private overrides = new Map<View, ScopeOverride>();
  private tabIndexes = new Map<HTMLElement, string | null>();
  private lastEditor?: WorkspaceLeaf;
  private prefix?: { view: View; until: number };
  private disposed = false;
  private fileActions: FileExplorerActions;

  constructor(
    private app: App,
    private createScope: (parent: Scope) => Scope,
    private router: EditorKeyRouter,
    private ready: () => boolean,
    private navigationEnabled: () => boolean,
    private onError: (error: unknown) => void,
  ) { this.fileActions = new FileExplorerActions(app, onError); }

  refresh(): void {
    if (this.disposed) return;
    const workspace = this.app.workspace;
    if (workspace.activeLeaf?.view.getViewType() === "markdown") this.lastEditor = workspace.activeLeaf;
    const views = new Set<View>();
    workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view.getViewType() !== "markdown" && !this.isSidebar(leaf)) return;
      views.add(view);
      const previous = this.overrides.get(view);
      if (previous?.scope === view.scope) return;
      if (previous) this.restore(view, previous);
      const original = view.scope;
      const scope = this.createScope(original ?? this.app.scope);
      const handler = scope.register(null, null, (event) => this.handle(view, event));
      view.scope = scope;
      // Closing note search restores Obsidian's original scope without a
      // layout event. Reattach after its search UI is added or removed.
      const Observer = view.containerEl.ownerDocument.defaultView?.MutationObserver;
      const observer = view.getViewType() === "markdown" && Observer ? new Observer(() => {
        if (view.scope !== scope) this.refresh();
      }) : undefined;
      observer?.observe(view.containerEl, { childList: true, subtree: true });
      this.overrides.set(view, { original, scope, handler, observer });
    });
    for (const [view, override] of this.overrides) {
      if (!views.has(view)) this.restore(view, override);
    }
  }

  async focusSidebar(side: "left" | "right"): Promise<void> {
    const workspace = this.app.workspace;
    const split = side === "left" ? workspace.leftSplit : workspace.rightSplit;
    const leaf = workspace.getMostRecentLeaf(split);
    if (leaf) await this.focusLeaf(leaf);
  }

  async focusEditor(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    const leaf = this.lastEditor && leaves.includes(this.lastEditor) ? this.lastEditor : leaves[0];
    if (leaf) await this.focusLeaf(leaf);
  }

  async navigate(direction: NavigationDirection): Promise<void> {
    if (this.disposed) return;
    if (direction === "editor") return this.focusEditor();
    const current = this.app.workspace.activeLeaf;
    if (!current) return;
    const from = current.view.containerEl.getBoundingClientRect();
    const horizontal = direction === "left" || direction === "right";
    const sign = direction === "left" || direction === "up" ? -1 : 1;
    let nearest: WorkspaceLeaf | undefined;
    let distance = Infinity;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const element = leaf.view.containerEl;
      if (leaf === current || element.ownerDocument !== current.view.containerEl.ownerDocument || !element.getClientRects().length) return;
      const root = leaf.getRoot();
      // The left sidebar has its own Ctrl+0 shortcut, separate from pane motions.
      if (root === this.app.workspace.leftSplit) return;
      if (this.isSidebar(leaf) && "collapsed" in root && root.collapsed) return;
      const to = element.getBoundingClientRect();
      if (!to.width || !to.height) return;
      const dx = (to.left + to.right - from.left - from.right) / 2;
      const dy = (to.top + to.bottom - from.top - from.bottom) / 2;
      const forward = sign * (horizontal ? dx : dy);
      const across = Math.abs(horizontal ? dy : dx);
      if (forward <= 1) return;
      const score = forward + across * 3;
      if (score < distance) { nearest = leaf; distance = score; }
    });
    if (nearest) await this.focusLeaf(nearest);
    else if (direction === "right" && !this.isSidebar(current)) await this.focusSidebar("right");
  }

  destroy(): void {
    this.disposed = true;
    this.fileActions.destroy();
    this.prefix = undefined;
    for (const [view, override] of this.overrides) this.restore(view, override);
    for (const [element, value] of this.tabIndexes) {
      if (element.getAttribute("tabindex") !== "-1") continue;
      if (value === null) element.removeAttribute("tabindex");
      else element.setAttribute("tabindex", value);
    }
    this.tabIndexes.clear();
  }

  private restore(view: View, override: ScopeOverride): void {
    override.observer?.disconnect();
    override.scope.unregister(override.handler);
    if (view.scope === override.scope) view.scope = override.original;
    this.overrides.delete(view);
  }

  private isSidebar(leaf: WorkspaceLeaf): boolean {
    return leaf.getRoot() === this.app.workspace.leftSplit || leaf.getRoot() === this.app.workspace.rightSplit;
  }

  private handle(view: View, event: KeyboardEvent): false | undefined {
    if (!this.ready() || event.defaultPrevented) return;
    if (this.router.handle(event)) return false;
    if (event.isComposing || event.keyCode === 229) return;
    if (view.getViewType() === "markdown" && (view as MarkdownView).getMode() === "preview") {
      return this.scrollReadingView(view as MarkdownView, event);
    }
    if (!this.navigationEnabled() || !this.isSidebar(view.leaf)) return;
    const target = event.target as HTMLElement | null;
    // Obsidian's ArrowDown handler blurs the tree container. Subsequent keys
    // target body, while the sidebar leaf and its keyboard scope remain active.
    const bodyInActiveView = target === view.containerEl.ownerDocument.body && this.app.workspace.activeLeaf?.view === view;
    if (!target || (!view.containerEl.contains(target) && !bodyInActiveView) || target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
    if (event.altKey || event.metaKey) return;
    if (event.shiftKey) {
      if (this.fileActions.handle(view, event)) { this.prefix = undefined; return false; }
      return;
    }
    const key = event.key.toLowerCase();
    if (this.prefix?.view === view && Date.now() < this.prefix.until) {
      this.prefix = undefined;
      // Retired pane shortcut: do not reinterpret its h as a tree-collapse key.
      if (key === "h") return false;
      const direction = DIRECTIONS[key];
      if (direction) { void this.navigate(direction).catch(this.onError); return false; }
    }
    if (event.ctrlKey) {
      if (key === "w") { this.prefix = { view, until: Date.now() + 1500 }; return false; }
      return;
    }
    this.prefix = undefined;
    if (key === "escape") { void this.focusEditor().catch(this.onError); return false; }
    if (view.getViewType() !== "file-explorer") return;
    if (this.fileActions.handle(view, event)) return false;
    const arrow = TREE_KEYS[key];
    if (arrow) {
      this.sendTreeKey(view, arrow);
      return false;
    }
  }

  private scrollReadingView(view: MarkdownView, event: KeyboardEvent): false | undefined {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || (event.key !== "j" && event.key !== "k")) return;
    const target = event.target as HTMLElement | null;
    const preview = this.readingScroller(view);
    const bodyInActiveView = target === preview.ownerDocument.body && this.app.workspace.activeLeaf?.view === view;
    if (!target || (!preview.contains(target) && target !== view.containerEl && !bodyInActiveView) ||
      target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
    preview.scrollBy({ top: event.key === "j" ? READING_SCROLL_STEP : -READING_SCROLL_STEP, behavior: "instant" });
    return false;
  }

  private readingScroller(view: MarkdownView): HTMLElement {
    const container = view.previewMode.containerEl;
    // Reading mode wraps the actual scrolling renderer in .markdown-reading-view.
    return container.querySelector<HTMLElement>(":scope > .markdown-preview-view") ?? container;
  }

  private async focusLeaf(leaf: WorkspaceLeaf): Promise<void> {
    if (this.disposed) return;
    if (this.app.workspace.activeLeaf?.view.getViewType() === "markdown") this.lastEditor = this.app.workspace.activeLeaf;
    await this.app.workspace.revealLeaf(leaf);
    if (this.disposed) return;
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.prefix = undefined;
    this.refresh();
    const view = leaf.view;
    const markdown = view.getViewType() === "markdown" ? view as MarkdownView : undefined;
    if (markdown && markdown.getMode() !== "preview") {
      markdown.editor.focus();
      return;
    }
    const target = (markdown ? this.readingScroller(markdown) : undefined) ??
      view.containerEl.querySelector<HTMLElement>(".nav-files-container, [role=tree]") ?? view.containerEl;
    if (!target.hasAttribute("tabindex")) {
      if (!this.tabIndexes.has(target)) this.tabIndexes.set(target, null);
      target.tabIndex = -1;
    }
    target.focus({ preventScroll: true });
    if (view.getViewType() === "file-explorer" && !target.querySelector(".has-focus")) this.sendTreeKey(view, "ArrowDown");
  }

  private sendTreeKey(view: View, key: string): void {
    const target = view.containerEl.querySelector<HTMLElement>(".nav-files-container") ?? view.containerEl;
    const win = target.ownerDocument.defaultView;
    if (!win) return;
    // Let Obsidian's own tree handle folders, selection, scrolling and opening notes.
    const code = ({ ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 } as Record<string, number>)[key];
    target.dispatchEvent(new win.KeyboardEvent("keydown", { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true }));
  }
}
