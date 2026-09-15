import { Annotation, EditorSelection, Prec, Transaction, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, layer, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { BlockSelectionRow, EditorDocument, NeovimState } from "../neovim/session";
import { EditorController, type EditorPort } from "./controller";
import { toNeovimKey } from "./keys";
import { byteToUtf16, nextChar, textChange, utf16ToByte } from "./text";
import { cursorDecorations, usesBlockCursor } from "./cursor";
import { blockSelectionMarkers } from "./block-selection";

export const fromNeovim = Annotation.define<boolean>();
let nextEditorId = 1;

export interface EditorHost {
  name: (view: EditorView) => string;
  save: (view: EditorView) => Promise<void>;
  registerKeys?: (view: EditorView, handler: (event: KeyboardEvent) => void) => () => void;
}

export function neovimExtension(controller: EditorController, host: EditorHost): Extension {
  class NeovimEditor implements EditorPort {
    id = nextEditorId++;
    private name: string;
    private revision = 0;
    private connected = false;
    private destroyed = false;
    private composing = false;
    private mode = "n";
    private cursorHead = 0;
    private resizeObserver: ResizeObserver;
    private unregisterKeys?: () => void;
    private blockRows: BlockSelectionRow[] = [];
    decorations: DecorationSet = Decoration.none;

    get blockSelection(): readonly BlockSelectionRow[] {
      return this.connected && !this.composing && (this.mode === "\x16" || this.mode === "\x13") ? this.blockRows : [];
    }

    get attributes(): Record<string, string> {
      if (!this.connected) return {};
      return {
        class: this.composing ? "neovim-connected neovim-composing" : "neovim-connected",
        "data-neovim-mode": this.mode.startsWith("i") ? "insert" : "normal",
        "data-neovim-cursor": !this.composing && usesBlockCursor(this.mode) ? "block" : "native",
        "data-neovim-selection": this.blockSelection.length ? "block" : "none",
      };
    }

    constructor(readonly view: EditorView) {
      this.name = host.name(view);
      this.cursorHead = view.state.selection.main.head;
      controller.register(this);
      this.drawCursor();
      // Capture before Obsidian's Vim/keymap handlers, but only inside this editor.
      view.contentDOM.addEventListener("keydown", this.keydown, true);
      view.contentDOM.addEventListener("beforeinput", this.beforeinput, true);
      view.contentDOM.addEventListener("paste", this.paste, true);
      view.contentDOM.addEventListener("compositionstart", this.compositionStart, true);
      view.contentDOM.addEventListener("compositionend", this.compositionEnd, true);
      this.unregisterKeys = host.registerKeys?.(view, this.keydown);
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(view.dom);
      if (view.hasFocus) queueMicrotask(() => { if (!this.destroyed) controller.focus(this); });
    }

    document(): EditorDocument {
      const { doc, selection } = this.view.state;
      const line = doc.lineAt(selection.main.head);
      return {
        id: this.id, revision: this.revision, text: doc.toString(),
        cursor: [line.number, utf16ToByte(line.text, selection.main.head - line.from)],
        name: this.name,
      };
    }

    update(update: ViewUpdate): void {
      const name = host.name(this.view);
      if (name !== this.name) {
        // Obsidian can reuse a CM view for a different note. Give it a fresh undo buffer.
        controller.unregister(this.id);
        this.id = nextEditorId++;
        this.name = name;
        this.revision = 0;
        this.blockRows = [];
        controller.register(this);
        if (this.view.hasFocus) controller.focus(this);
      }
      if (update.focusChanged && this.view.hasFocus) { controller.focus(this); this.resize(); }
      const hostChange = update.transactions.some((transaction) =>
        !transaction.annotation(fromNeovim) && (transaction.docChanged || transaction.selection));
      if (hostChange) {
        this.revision++;
        this.blockRows = [];
        this.cursorHead = this.view.state.selection.main.head;
        if (!this.composing) controller.hostChanged(this);
      }
      this.drawCursor();
    }

    apply(state: NeovimState): void {
      // RPC notifications may arrive during a host update. Dispatch after that update finishes.
      queueMicrotask(() => {
        if (this.destroyed || !this.connected || this.composing || state.id !== this.id || state.revision !== this.revision) return;
        const oldText = this.view.state.doc.toString();
        const newText = state.lines?.join("\n") ?? oldText;
        const change = textChange(oldText, newText);
        const doc = change ? this.view.state.doc.replace(change.from, change.to, this.view.state.toText(change.insert)) : this.view.state.doc;
        const position = ([row, byte]: [number, number]) => {
          const line = doc.line(Math.max(1, Math.min(row, doc.lines)));
          return line.from + byteToUtf16(line.text, byte);
        };
        const head = position(state.cursor);
        const anchor = position(state.anchor);
        let selection = EditorSelection.cursor(head);
        if (state.mode === "v") {
          selection = head >= anchor
            ? EditorSelection.range(anchor, nextChar(newText, head))
            : EditorSelection.range(nextChar(newText, anchor), head);
        } else if (state.mode === "V") {
          const first = doc.lineAt(Math.min(anchor, head));
          const last = doc.lineAt(Math.max(anchor, head));
          const end = Math.min(doc.length, last.to + 1);
          selection = head >= anchor ? EditorSelection.range(first.from, end) : EditorSelection.range(end, first.from);
        }
        this.mode = state.mode;
        this.cursorHead = head;
        this.blockRows = state.blockSelection ?? [];
        this.view.dispatch({
          changes: change,
          selection: EditorSelection.create([selection]),
          annotations: [fromNeovim.of(true), Transaction.addToHistory.of(false)],
          scrollIntoView: this.view.hasFocus,
        });
      });
    }

    setConnected(connected: boolean): void {
      this.connected = connected;
      if (!connected) {
        this.blockRows = [];
        this.decorations = Decoration.none;
      }
      if (connected && this.view.hasFocus) queueMicrotask(() => { if (!this.destroyed) controller.focus(this); });
      // Request a view update outside constructors/current CodeMirror transactions.
      queueMicrotask(() => { if (!this.destroyed) this.view.dispatch({ annotations: fromNeovim.of(true) }); });
    }

    async save(): Promise<void> {
      // Apply the state notification preceding the write notification first.
      await Promise.resolve();
      if (!this.destroyed) await host.save(this.view);
    }

    destroy(): void {
      this.destroyed = true;
      this.resizeObserver.disconnect();
      this.unregisterKeys?.();
      this.view.contentDOM.removeEventListener("keydown", this.keydown, true);
      this.view.contentDOM.removeEventListener("beforeinput", this.beforeinput, true);
      this.view.contentDOM.removeEventListener("paste", this.paste, true);
      this.view.contentDOM.removeEventListener("compositionstart", this.compositionStart, true);
      this.view.contentDOM.removeEventListener("compositionend", this.compositionEnd, true);
      // CodeMirror owns the attributes through the facet. During setState the new
      // plugin may produce identical attributes, so manual removal here would
      // leave its cached values out of sync with the reused editor DOM.
      controller.unregister(this.id);
    }

    private keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !this.connected || this.composing || event.keyCode === 229) return;
      const key = toNeovimKey(event, this.mode);
      if (key === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      controller.input(this, key);
    };

    private beforeinput = (event: InputEvent): void => {
      if (!this.connected || this.composing || event.isComposing) return;
      // Dead keys and input methods can produce text without a printable keydown.
      if (event.inputType === "insertText" && event.data) {
        event.preventDefault();
        event.stopImmediatePropagation();
        controller.input(this, event.data.replace(/</g, "<lt>"));
      } else if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        controller.input(this, event.inputType === "historyUndo" ? "<Esc>u" : "<Esc><C-r>");
      }
    };

    private paste = (event: ClipboardEvent): void => {
      if (!this.connected || this.composing || !event.clipboardData) return;
      // Let Obsidian handle file/image pastes.
      if (event.clipboardData.files.length || !event.clipboardData.types.includes("text/plain")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      controller.paste(this, event.clipboardData.getData("text/plain"));
    };

    private compositionStart = (): void => {
      this.composing = true;
      // Restore the native caret without editing the DOM inside the composition.
      if (this.connected) this.view.dom.dataset.neovimCursor = "native";
      if (this.connected) this.view.dom.classList.add("neovim-composing");
    };
    private compositionEnd = (): void => {
      this.composing = false;
      this.view.dom.classList.remove("neovim-composing");
      if (this.connected) this.view.dom.dataset.neovimCursor = usesBlockCursor(this.mode) ? "block" : "native";
      // CodeMirror commits the composed text; its update sends that text to Neovim.
      setTimeout(() => { if (!this.destroyed) controller.hostChanged(this); }, 0);
    };

    private resize(): void {
      controller.resize(this, Math.floor(this.view.contentDOM.clientWidth / (this.view.defaultCharacterWidth || 8)),
        Math.floor(this.view.scrollDOM.clientHeight / (this.view.defaultLineHeight || 20)));
    }

    private drawCursor(): void {
      this.decorations = Decoration.none;
      if (!this.connected) return;
      const block = !this.composing && usesBlockCursor(this.mode);
      if (block) this.decorations = cursorDecorations(this.view.state.doc, this.cursorHead, this.mode);
    }
  }

  const plugin = ViewPlugin.fromClass(NeovimEditor, { decorations: (value) => value.decorations });
  return [
    Prec.highest(plugin),
    EditorView.editorAttributes.of((view) => view.plugin(plugin)?.attributes ?? {}),
    layer({
      above: true,
      class: "neovim-block-selection-layer",
      update: () => true,
      markers: (view) => blockSelectionMarkers(view, view.plugin(plugin)?.blockSelection ?? []),
    }),
  ];
}
