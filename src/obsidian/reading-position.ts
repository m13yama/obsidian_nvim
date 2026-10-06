import type { App, MarkdownView } from "obsidian";

interface ViewOverride {
  wrapped: MarkdownView["setState"];
  descriptor?: PropertyDescriptor;
  generation: number;
  reading?: { file: MarkdownView["file"]; top?: number };
}

/** Carry the visible reading position into editing only after a full page of movement. */
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
      const override = this.overrides.get(view);
      if (!override) this.attach(view);
      else if (view.getMode() === "preview" &&
        (override.reading?.file !== view.file || override.reading?.top === undefined)) {
        // A background tab may only become measurable when it is revealed.
        this.rememberReadingStart(view, override);
      }
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
        const scroller = switching ? owner.scroller(view) : undefined;
        const start = override.reading;
        const movedPage = scroller && start?.file === file && start?.top !== undefined &&
          scroller.clientHeight > 0 && Number.isFinite(scroller.scrollTop) &&
          Math.abs(scroller.scrollTop - start.top) >= scroller.clientHeight;
        // getScroll uses source-line coordinates, accounting for rendered block heights.
        // Read before the preview is hidden; its DOM geometry is unavailable afterward.
        const scroll = movedPage ? view.previewMode.getScroll() : undefined;
        if ((state?.mode && state.mode !== "preview") || (state?.file && state.file !== file?.path)) {
          override.reading = undefined;
        }
        await original.call(this, state, result);
        if (owner.disposed || owner.overrides.get(view) !== override || generation !== override.generation) return;
        if (view.getMode() === "preview") {
          if (!override.reading || override.reading.file !== view.file) owner.rememberReadingStart(view, override);
          return;
        }
        override.reading = undefined;
        if (!owner.enabled() || !switching || view.file !== file || view.getMode() !== "source" ||
          typeof scroll !== "number" || !Number.isFinite(scroll)) return;
        const line = Math.max(0, Math.min(Math.floor(scroll), view.editor.lineCount() - 1));
        // A normal host selection update also synchronizes Neovim through the editor bridge.
        view.editor.setCursor({ line, ch: 0 });
        view.currentMode.applyScroll(Math.max(0, scroll));
      },
    };
    this.overrides.set(view, override);
    view.setState = override.wrapped;
    if (view.getMode() === "preview") this.rememberReadingStart(view, override);
  }

  private scroller(view: MarkdownView): HTMLElement {
    const container = view.previewMode.containerEl;
    return container.querySelector<HTMLElement>(":scope > .markdown-preview-view") ?? container;
  }

  private rememberReadingStart(view: MarkdownView, override: ViewOverride): void {
    const reading: NonNullable<ViewOverride["reading"]> = { file: view.file };
    override.reading = reading;
    const capture = () => {
      if (this.disposed || this.overrides.get(view) !== override || override.reading !== reading ||
        view.file !== reading.file || view.getMode() !== "preview") return;
      const scroller = this.scroller(view);
      if (scroller.clientHeight > 0 && Number.isFinite(scroller.scrollTop)) reading.top = scroller.scrollTop;
    };
    // Obsidian may restore the preview's scroll only after its renderer finishes.
    // Its optional completion hook lets us measure the restored position, not stale DOM.
    const preview = view.previewMode as MarkdownView["previewMode"] & {
      renderer?: { onRendered?: (callback: () => void) => void };
    };
    if (preview.renderer?.onRendered) preview.renderer.onRendered(capture);
    else capture();
  }

  private restore(view: MarkdownView, override: ViewOverride): void {
    if (view.setState === override.wrapped) {
      if (override.descriptor) Object.defineProperty(view, "setState", override.descriptor);
      else Reflect.deleteProperty(view, "setState");
    }
    this.overrides.delete(view);
  }
}
