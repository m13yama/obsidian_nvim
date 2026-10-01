import type { App, TAbstractFile, TFile, TFolder, View } from "obsidian";

type FileClipboardEvent = Pick<ClipboardEvent, "preventDefault"> & {
  clipboardData: Pick<DataTransfer, "getData" | "setData">;
};

interface ExplorerItem {
  file: TAbstractFile;
  selfEl?: HTMLElement;
  info?: { hidden: boolean };
  collapsed?: boolean;
  vChildren?: { children: ExplorerItem[] };
}

export type ExplorerMotion = "first" | "last" | "half-up" | "half-down" | "page-up" | "page-down";

// Obsidian's core explorer exposes these handlers at runtime, outside its public types.
// Reuse them so selection, rename UI, deletion prompts, and folder moves stay native.
interface FileExplorerView extends View {
  tree?: {
    focusedItem?: ExplorerItem | null;
    root?: { vChildren: { children: ExplorerItem[] } };
    setFocusedItem?: (item: ExplorerItem, scrollIntoView: boolean) => void;
    clearSelectedDoms?: () => void;
  };
  fileBeingRenamed?: TAbstractFile | null;
  itemsBeingCut?: { selfEl: HTMLElement }[];
  createAbstractFile?: (type: "file" | "folder", parent: TFolder, newLeaf: boolean) => Promise<void>;
  onKeyRename?: (event: KeyboardEvent) => void;
  onDeleteSelectedFiles?: (event: KeyboardEvent) => void;
  handleCopy?: (event: FileClipboardEvent) => void;
  handleCut?: (event: FileClipboardEvent) => void;
  handlePaste?: (event: FileClipboardEvent) => Promise<void>;
  requestSort?: () => void;
}

const ACTION_KEYS = new Set(["a", "A", "r", "d", "y", "x", "p", "v", "R"]);

export function focusedExplorerFile(view: View): TFile | undefined {
  const explorer = view as FileExplorerView;
  if (view.getViewType() !== "file-explorer" || explorer.fileBeingRenamed) return;
  const file = explorer.tree?.focusedItem?.file;
  return file && "extension" in file ? file as TFile : undefined;
}

export class FileExplorerActions {
  private clipboard = "";
  private cutView?: FileExplorerView;

  constructor(private app: App, private onError: (error: unknown) => void) {}

  handle(view: View, event: KeyboardEvent): boolean {
    const explorer = view as FileExplorerView;
    if (view.getViewType() !== "file-explorer" || explorer.fileBeingRenamed ||
      event.ctrlKey || event.altKey || event.metaKey || !ACTION_KEYS.has(event.key)) return false;
    // Holding a key must not create or delete multiple files.
    if (!event.repeat) void this.run(explorer, event).catch(this.onError);
    return true;
  }

  moveFocus(view: View, motion: ExplorerMotion): void {
    const explorer = view as FileExplorerView;
    if (view.getViewType() !== "file-explorer" || explorer.fileBeingRenamed) return;
    try {
      const tree = explorer.tree;
      if (!tree?.root?.vChildren || !tree.setFocusedItem) throw this.unavailable();
      // The tree is virtualized: offscreen rows may not be in the DOM. Walk
      // its sorted model, leaving collapsed folders and hidden items alone.
      const items: ExplorerItem[] = [];
      const visit = (children: ExplorerItem[]) => {
        for (const item of children) {
          if (item.info?.hidden) continue;
          items.push(item);
          if (!item.collapsed && item.vChildren) visit(item.vChildren.children);
        }
      };
      visit(tree.root.vChildren.children);
      let index = motion === "first" ? 0 : items.length - 1;
      if (motion !== "first" && motion !== "last") {
        const down = motion.endsWith("down");
        const current = tree.focusedItem ? items.indexOf(tree.focusedItem) : -1;
        if (current >= 0) {
          const container = view.containerEl.querySelector<HTMLElement>(".nav-files-container") ?? view.containerEl;
          const rowHeight = tree.focusedItem?.selfEl?.getBoundingClientRect().height ||
            items.find((item) => item.selfEl?.getBoundingClientRect().height)?.selfEl?.getBoundingClientRect().height || 24;
          const fraction = motion.startsWith("half") ? 0.5 : 1;
          const rows = Math.max(1, Math.floor(container.clientHeight * fraction / rowHeight));
          index = Math.max(0, Math.min(items.length - 1, current + (down ? rows : -rows)));
        } else index = down ? 0 : items.length - 1;
      }
      const item = items[index];
      if (item) tree.setFocusedItem(item, true);
    } catch (error) { this.onError(error); }
  }

  destroy(): void {
    this.clearCut();
    this.clipboard = "";
  }

  private async run(view: FileExplorerView, event: KeyboardEvent): Promise<void> {
    const file = view.tree?.focusedItem?.file;
    switch (event.key) {
      case "a":
      case "A": {
        if (!view.createAbstractFile) throw this.unavailable();
        const parent = file && "children" in file ? file as TFolder : file?.parent ?? this.app.vault.getRoot();
        await view.createAbstractFile(event.key === "a" ? "file" : "folder", parent, false);
        return;
      }
      case "r":
        if (!view.onKeyRename) throw this.unavailable();
        view.onKeyRename(event);
        return;
      case "d":
        if (!view.onDeleteSelectedFiles) throw this.unavailable();
        view.onDeleteSelectedFiles(event);
        return;
      case "y":
      case "x": {
        const handler = event.key === "y" ? view.handleCopy : view.handleCut;
        if (!handler) throw this.unavailable();
        this.clearCut();
        this.clipboard = "";
        handler.call(view, this.clipboardEvent(event));
        if (event.key === "x") this.cutView = view;
        return;
      }
      case "p": {
        if (!this.clipboard) return;
        if (!view.handlePaste) throw this.unavailable();
        const pasted = this.clipboard;
        await view.handlePaste(this.clipboardEvent(event));
        // A successful cut is consumed; copied files may be pasted repeatedly.
        if (this.clipboard === pasted && JSON.parse(pasted).operation === "cut") {
          this.clearCut();
          this.clipboard = "";
          // Native paste reselects moved items; keep focus but end the selection.
          view.tree?.clearSelectedDoms?.();
        }
        return;
      }
      case "v":
        if (file && "extension" in file) await this.app.workspace.getLeaf("split", "vertical").openFile(file as TFile);
        return;
      case "R":
        if (!view.requestSort) throw this.unavailable();
        view.requestSort();
    }
  }

  private clipboardEvent(event: KeyboardEvent): FileClipboardEvent {
    const data = this.clipboard;
    return {
      preventDefault: () => event.preventDefault(),
      clipboardData: {
        getData: (type) => type === "obsidian/files" ? data : "",
        setData: (type, value) => { if (type === "obsidian/files") this.clipboard = value; },
      },
    };
  }

  private clearCut(): void {
    if (!this.cutView) return;
    for (const item of this.cutView.itemsBeingCut ?? []) item.selfEl.classList.remove("is-cut");
    this.cutView.itemsBeingCut = [];
    this.cutView = undefined;
  }

  private unavailable(): Error {
    return new Error("This file operation is unavailable in this version of Obsidian's file explorer.");
  }
}
