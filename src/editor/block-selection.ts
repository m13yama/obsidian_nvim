import { EditorSelection, findClusterBreak } from "@codemirror/state";
import { Direction, RectangleMarker, type EditorView } from "@codemirror/view";
import type { BlockSelectionPoint, BlockSelectionRow } from "../neovim/session";
import { byteToUtf16 } from "./text";

const CLASS = "neovim-block-selection";

/** Measure a separate selection layer without changing text or native selections. */
export function blockSelectionMarkers(view: EditorView, rows: readonly BlockSelectionRow[]): RectangleMarker[] {
  const markers: RectangleMarker[] = [];
  for (const row of rows) {
    if (row.line < 1 || row.line > view.state.doc.lines) continue;
    const line = view.state.doc.line(row.line);
    if (line.to < view.viewport.from || line.from > view.viewport.to) continue;
    const from = line.from + byteToUtf16(line.text, row.from.byte);
    const to = line.from + byteToUtf16(line.text, row.to.byte);
    const next = (pos: number) => line.from + findClusterBreak(line.text, pos - line.from);
    const fullRange = (start: number, end: number) => {
      if (end > start) markers.push(...RectangleMarker.forRange(view, CLASS, EditorSelection.range(start, end)));
    };
    const partial = (pos: number, point: BlockSelectionPoint, start: number, end: number) => {
      if (end <= start) return;
      if (point.width > 0 && start === 0 && end === point.width) { fullRange(pos, next(pos)); return; }
      const base = RectangleMarker.forRange(view, CLASS, EditorSelection.cursor(pos))[0];
      const caret = view.coordsAtPos(pos);
      if (!base || !caret) return;
      const char = point.width > 0 ? view.coordsForChar(pos) : null;
      if (point.width > 0 && !char) return; // Hidden by Live Preview or outside the viewport.
      const width = char ? (char.right - char.left) / point.width : view.defaultCharacterWidth * view.scaleX;
      const rtl = view.textDirectionAt(pos) === Direction.RTL;
      const edge = char ? (rtl ? char.right : char.left) : caret.left;
      const left = edge + (rtl ? -end : start) * width;
      const top = char?.top ?? caret.top;
      const bottom = char?.bottom ?? caret.bottom;
      markers.push(new RectangleMarker(CLASS, base.left + left - caret.left, base.top + top - caret.top,
        (end - start) * width, bottom - top));
    };

    if (from === to) {
      partial(from, row.from, row.from.offset, row.to.offset);
      continue;
    }
    let start = from;
    if (row.from.offset > 0) {
      partial(from, row.from, row.from.offset, row.from.width);
      start = next(from);
    }
    let end = to;
    if (row.to.width > 0 && row.to.offset === row.to.width) end = next(to);
    else partial(to, row.to, 0, row.to.offset);
    fullRange(start, end);
  }
  return markers;
}
