import { findClusterBreak, type Text } from "@codemirror/state";
import { Decoration, WidgetType, type DecorationSet, type EditorView } from "@codemirror/view";

class EmptyCursor extends WidgetType {
  eq(): boolean { return true; }

  toDOM(view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement("span");
    element.className = "neovim-block-cursor neovim-block-cursor-empty";
    element.setAttribute("aria-hidden", "true");
    return element;
  }

  ignoreEvent(): boolean { return false; }
}

const emptyCursor = Decoration.widget({ widget: new EmptyCursor(), side: 1 });
const characterCursor = Decoration.mark({ class: "neovim-block-cursor" });
const cursorLine = Decoration.line({ class: "neovim-cursor-line" });

export function usesBlockCursor(mode: string): boolean {
  return /^(n|v|V|\x16|s|S|\x13)/.test(mode);
}

export function cursorDecorations(doc: Text, position: number, mode: string): DecorationSet {
  const head = Math.max(0, Math.min(position, doc.length));
  const line = doc.lineAt(head);
  const cursor = head < line.to
    ? characterCursor.range(head, line.from + findClusterBreak(line.text, head - line.from))
    : emptyCursor.range(head);
  // Keep visual selections distinct from the normal-mode line highlight.
  return Decoration.set(mode.startsWith("n") ? [cursorLine.range(line.from), cursor] : [cursor], true);
}
