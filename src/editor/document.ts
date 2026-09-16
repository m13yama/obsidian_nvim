import { ChangeSet, Text } from "@codemirror/state";
import type { BufferChange, BufferEdit, NeovimChanges } from "../neovim/session";
import { textChange, utf16ToByte } from "./text";

/** Used for initial reconciliation and when a host editor replaces its whole state. */
export function documentDiff(before: Text, after: Text): ChangeSet {
  if (before.eq(after)) return ChangeSet.empty(before.length);
  return ChangeSet.of(textChange(before.toString(), after.toString())!, before.length);
}

function lineChanges(doc: Text, edits: BufferChange[]): ChangeSet {
  let all = ChangeSet.empty(doc.length);
  for (const edit of edits) {
    let from = edit.first < doc.lines ? doc.line(edit.first + 1).from : doc.length;
    const to = edit.last < doc.lines ? doc.line(edit.last + 1).from : doc.length;
    let insert = edit.lines.join("\n");
    if (edit.last === doc.lines && edit.first > 0) {
      from = doc.line(edit.first).to;
      if (edit.lines.length) insert = "\n" + insert;
    } else if (edit.last < doc.lines && edit.lines.length) insert += "\n";
    // on_lines reports entire lines. Narrow to the changed characters so a
    // concurrent insertion elsewhere on the same line survives rebasing.
    const change = textChange(doc.sliceString(from, to), insert);
    if (!change) continue;
    const next = ChangeSet.of({ from: from + change.from, to: from + change.to, insert: change.insert }, doc.length);
    all = all.compose(next);
    doc = next.apply(doc);
  }
  return all;
}

export function bufferEdits(doc: Text, changes: ChangeSet): BufferEdit[] {
  const edits: BufferEdit[] = [];
  changes.iterChanges((from, to, _fromB, _toB, insert) => {
    const start = doc.lineAt(from), end = doc.lineAt(to);
    edits.push({
      start: [start.number - 1, utf16ToByte(start.text, from - start.from)],
      end: [end.number - 1, utf16ToByte(end.text, to - end.from)],
      lines: insert.toString().split("\n"),
    });
  });
  // All coordinates refer to the same original document.
  return edits.reverse();
}

/** A file's shared text and pending host edits, independent of any editor view. */
export class FileBuffer {
  text: Text;
  shadow: Text;
  pending: ChangeSet;
  tick = 0;
  initialized = false;
  detachedText?: Text;
  inflight?: { token: number; after: ChangeSet };

  constructor(readonly id: number, public name: string, text: Text) {
    this.text = this.shadow = text;
    this.pending = ChangeSet.empty(text.length);
  }

  hostChange(before: Text, changes: ChangeSet): ChangeSet {
    const after = changes.apply(before);
    // Obsidian may propagate a shared note's changes into another CM editor.
    if (after.eq(this.text)) return ChangeSet.empty(this.text.length);
    const rebased = before.eq(this.text) ? changes : changes.map(documentDiff(before, this.text));
    this.pending = this.pending.compose(rebased);
    if (this.inflight) this.inflight.after = this.inflight.after.compose(rebased);
    this.text = rebased.apply(this.text);
    return rebased;
  }

  receive(event: NeovimChanges): ChangeSet {
    this.tick = event.tick;
    if (event.initial) return ChangeSet.empty(this.text.length);
    const incoming = lineChanges(this.shadow, event.changes);
    this.shadow = incoming.apply(this.shadow);
    if (event.origin && this.inflight?.token === event.origin) {
      this.pending = this.inflight.after;
      this.inflight = undefined;
      return ChangeSet.empty(this.text.length);
    }
    const visible = incoming.map(this.pending);
    this.pending = this.pending.map(incoming, true);
    // A concurrent native change invalidates the expected changedtick of an
    // in-flight host request. It will be retried against this rebased state.
    this.inflight = undefined;
    this.text = visible.apply(this.text);
    return visible;
  }
}
