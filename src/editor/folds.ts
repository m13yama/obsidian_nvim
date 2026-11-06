import { foldable, foldedRanges, foldEffect, unfoldEffect } from "@codemirror/language";
import type { EditorState, StateEffect } from "@codemirror/state";
import type { FoldRange } from "../neovim/session";

/** Obsidian defines the fold boundaries; Neovim operates on their source lines. */
export function editorFolds(state: EditorState): FoldRange[] {
  const closed = new Map<number, number>();
  foldedRanges(state).between(0, state.doc.length, (from, to) => { closed.set(from, to); });
  const ranges = new Map<number, FoldRange>();
  for (let number = 1; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const range = foldable(state, line.from, line.to);
    if (!range) continue;
    const end = state.doc.lineAt(range.to).number;
    if (end > number) ranges.set(number, { from: number, to: end, closed: closed.has(range.from) });
  }
  // Retain folds outside the parser's current viewport, including nested folds.
  for (const [from, to] of closed) {
    const first = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number;
    if (last > first) ranges.set(first, { from: first, to: last, closed: true });
  }
  return [...ranges.values()].sort((a, b) => a.from - b.from || b.to - a.to);
}

export function foldEffects(state: EditorState, closed: [number, number][]): StateEffect<unknown>[] {
  const effects: StateEffect<unknown>[] = [];
  const wanted = new Map(closed);
  const present = new Set<number>();
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    const first = state.doc.lineAt(from).number;
    if (wanted.get(first) === state.doc.lineAt(to).number) present.add(first);
    else effects.push(unfoldEffect.of({ from, to }));
  });
  for (const [first, last] of closed) {
    if (present.has(first) || first < 1 || last > state.doc.lines || last <= first) continue;
    const line = state.doc.line(first);
    const range = foldable(state, line.from, line.to);
    // Only fold a region recognized by the host, never arbitrary stale text.
    if (range && state.doc.lineAt(range.to).number === last) effects.push(foldEffect.of(range));
  }
  return effects;
}

/** A folded heading remains the visible cursor location, including Visual mode. */
export function visibleFoldPosition(state: EditorState, head: number, closed: [number, number][]): number {
  const row = state.doc.lineAt(head).number;
  for (const [first, last] of closed) {
    if (first <= row && row <= last && first >= 1 && first <= state.doc.lines) {
      const line = state.doc.line(first);
      const boundary = foldable(state, line.from, line.to)?.from ?? line.to;
      return row === first ? Math.min(head, boundary) : line.from;
    }
  }
  return head;
}
