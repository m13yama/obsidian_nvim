export interface KeyEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
  getModifierState?: (key: string) => boolean;
}

const SPECIAL_KEYS: Record<string, string> = {
  Escape: "Esc", Enter: "CR", Backspace: "BS", Delete: "Del", Tab: "Tab",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Insert: "Insert", " ": "Space", "\\": "Bslash", "|": "Bar", "<": "lt",
};

/** null means the browser/Obsidian keeps the key. Meta shortcuts remain native. */
export function toNeovimKey(event: KeyEvent): string | null {
  if (event.isComposing || event.metaKey || event.getModifierState?.("AltGraph")) return null;
  if (["Dead", "Process", "Unidentified", "Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return null;
  // Preserve save and clipboard shortcuts. Ctrl-R remains Neovim redo.
  if (event.ctrlKey && !event.altKey && ["s", "v", "c", "x"].includes(event.key.toLowerCase())) return null;
  const special = SPECIAL_KEYS[event.key] ?? (/^F\d{1,2}$/.test(event.key) ? event.key : undefined);
  const modified = event.ctrlKey || event.altKey;
  if (!special && [...event.key].length !== 1) return null;
  if (!special && !modified) return event.key;
  const shifted = event.shiftKey && (event.key.length > 1 || modified);
  const modifiers = [event.ctrlKey ? "C" : "", event.altKey ? "A" : "", shifted ? "S" : ""].filter(Boolean);
  const name = special ?? event.key.toLowerCase();
  return `<${[...modifiers, name].join("-")}>`;
}
