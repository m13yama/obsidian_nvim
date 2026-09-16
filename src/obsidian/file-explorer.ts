import type { App, TAbstractFile, TFile, TFolder, View } from "obsidian";

type FileClipboardEvent = Pick<ClipboardEvent, "preventDefault"> & {
  clipboardData: Pick<DataTransfer, "getData" | "setData">;
};

// Obsidian's core explorer exposes these handlers at runtime, outside its public types.
// Reuse them so selection, rename UI, deletion prompts, and folder moves stay native.
interface FileExplorerView extends View {
  tree?: { focusedItem?: { file: TAbstractFile } | null };
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
