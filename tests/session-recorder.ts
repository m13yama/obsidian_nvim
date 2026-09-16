import type { NeovimState, SessionEvents } from "../src/neovim/session";

/** Reconstruct text from the wire's line patches, independently of the editor implementation. */
export function recordSession(update: (state: NeovimState, text: string) => void): Pick<SessionEvents, "state" | "changes"> {
  const documents = new Map<number, string[]>();
  let active: NeovimState | undefined;
  return {
    changes: (event) => {
      const lines = documents.get(event.id) ?? [""];
      for (const change of event.changes) lines.splice(change.first, change.last - change.first, ...change.lines);
      documents.set(event.id, lines);
      if (active?.id === event.id) update(active, lines.join("\n"));
    },
    state: (state) => {
      active = state;
      update(state, (documents.get(state.id) ?? [""]).join("\n"));
    },
  };
}
