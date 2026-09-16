import type { App, MarkdownView } from "obsidian";

interface ViewOverride {
  wrapped: MarkdownView["setState"];
  descriptor?: PropertyDescriptor;
  generation: number;
}

/** Carry the visible reading position into the editor's selection on a mode switch. */
export class ReadingPositionSync {
  private overrides = new Map<MarkdownView, ViewOverride>();
  private disposed = false;

  constructor(private app: App, private enabled: () => boolean) {}

  refresh(): void {
    if (this.disposed) return;
    const views = new Set(this.app.workspace.getLeavesOfType("markdown").map((leaf) => leaf.view as MarkdownView));
    for (const view of views) {
      // Deferred Markdown leaves have not constructed their editor/preview yet.
      if (typeof view.getMode !== "function" || !view.previewMode) continue;
      if (!this.overrides.has(view)) this.attach(view);
    }
    for (const [view, override] of this.overrides) {
      if (!views.has(view)) this.restore(view, override);
    }
  }

  destroy(): void {
    this.disposed = true;
    for (const [view, override] of this.overrides) this.restore(view, override);
  }

  private attach(view: MarkdownView): void {
    const original = view.setState;
    const owner = this;
    const override: ViewOverride = {
      descriptor: Object.getOwnPropertyDescriptor(view, "setState"), generation: 0,
      wrapped: async function (state, result) {
        const generation = ++override.generation;
        const file = view.file;
        const switching = !owner.disposed && owner.overrides.get(view) === override && owner.enabled() &&
          view.getMode() === "preview" && state?.mode === "source" &&
          file && (!state.file || state.file === file.path);
        // getScroll uses source-line coordinates, accounting for rendered block heights.
        // Read before the preview is hidden; its DOM geometry is unavailable afterward.
        const scroll = switching ? view.previewMode.getScroll() : undefined;
        await original.call(this, state, result);
        if (owner.disposed || owner.overrides.get(view) !== override || generation !== override.generation ||
          !owner.enabled() || !switching || view.file !== file || view.getMode() !== "source" ||
          typeof scroll !== "number" || !Number.isFinite(scroll)) return;
        const line = Math.max(0, Math.min(Math.floor(scroll), view.editor.lineCount() - 1));
        // A normal host selection update also synchronizes Neovim through the editor bridge.
        view.editor.setCursor({ line, ch: 0 });
        view.currentMode.applyScroll(Math.max(0, scroll));
      },
    };
    this.overrides.set(view, override);
    view.setState = override.wrapped;
  }

  private restore(view: MarkdownView, override: ViewOverride): void {
    if (view.setState === override.wrapped) {
      if (override.descriptor) Object.defineProperty(view, "setState", override.descriptor);
      else Reflect.deleteProperty(view, "setState");
    }
    this.overrides.delete(view);
  }
}
