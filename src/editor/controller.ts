import { ChangeSet, Text } from "@codemirror/state";
import { NeovimSession, type EditorDocument, type NavigationDirection, type NeovimChanges, type NeovimState, type SessionOptions } from "../neovim/session";
import { asError } from "../neovim/rpc";
import { FileBuffer, bufferEdits, documentDiff } from "./document";
import { byteToUtf16, utf16ToByte } from "./text";

export type FileKey = string | object;

export interface EditorPort {
  id: number;
  document(): EditorDocument & { key?: FileKey };
  apply(state: NeovimState): void;
  applyText(before: Text, changes: ChangeSet, after: Text): void;
  setConnected(connected: boolean): void;
  save(): Promise<void>;
}

export interface StatusDetails {
  file?: string;
  line: number;
  column: number;
  totalLines: number;
  recording: string;
}

export interface ControllerEvents {
  status: (status: string, details?: StatusDetails) => void;
  commandLine: (text: string) => void;
  message: (text: string) => void;
  error: (error: Error) => void;
  navigate?: (direction: NavigationDirection) => void;
}

interface Binding {
  port: EditorPort;
  file: FileBuffer;
  cursor: number;
  revision: number;
}

interface CursorIntent { text: Text; head: number; revision: number }

/** Files own buffers/undo; editor bindings own selection and focus. */
export class EditorController {
  private ports = new Map<number, EditorPort>();
  private bindings = new Map<number, Binding>();
  private files = new Map<FileKey, FileBuffer>();
  private buffers = new Map<number, FileBuffer>();
  private nextBufferId = 1;
  private nextEditToken = 1;
  private session?: NeovimSession;
  private activePort?: number;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  ready = false;

  constructor(private events: ControllerEvents) {}

  register(port: EditorPort): void {
    this.ports.set(port.id, port);
    if (this.ready) this.bind(port);
    port.setConnected(this.ready);
  }

  unregister(id: number, lastText?: Text): void {
    const file = this.bindings.get(id)?.file;
    this.ports.delete(id);
    this.bindings.delete(id);
    if (file && !this.fileBindings(file).length) file.detachedText = lastText ?? file.text;
    if (this.activePort === id) {
      this.activePort = undefined;
      if (this.ready) this.events.status("Ready");
    }
    // Keep the file's buffer until deletion or process shutdown, including
    // while Obsidian replaces a CM view or temporarily displays another note.
  }

  rename(key: FileKey, name: string): void {
    const file = this.files.get(key);
    if (!file || file.name === name) return;
    file.name = name;
    this.enqueue((session) => session.rename(file.id, name));
  }

  forget(key: FileKey): void {
    const file = this.files.get(key);
    if (!file) return;
    this.files.delete(key);
    this.buffers.delete(file.id);
    for (const binding of this.fileBindings(file)) this.bindings.delete(binding.port.id);
    // Initialization may still be queued or in flight; release after it finishes.
    this.enqueue((session) => session.release(file.id));
  }

  async start(options: SessionOptions): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.events.status("Starting…");
    const current = () => generation === this.generation;
    const session = new NeovimSession(options, {
      changes: (changes) => { if (current()) this.receiveChanges(changes); },
      state: (state) => {
        if (!current()) return;
        const binding = this.bindings.get(state.view);
        if (!binding || binding.file.id !== state.id || this.activePort !== state.view) return;
        if (this.currentState(binding.port, state)) {
          const doc = binding.file.text;
          const line = doc.line(Math.max(1, Math.min(state.cursor[0], doc.lines)));
          binding.cursor = line.from + byteToUtf16(line.text, state.cursor[1]);
        }
        binding.port.apply(state);
        this.events.status(modeLabel(state.mode), {
          file: binding.file.name, line: state.cursor[0], column: state.screenColumn,
          totalLines: state.lineCount, recording: state.recording,
        });
      },
      commandLine: (text) => { if (current()) this.events.commandLine(text); },
      message: (text) => { if (current()) this.events.message(text); },
      write: (id) => {
        if (!current()) return;
        const file = this.buffers.get(id);
        const binding = file && this.fileBindings(file)[0];
        if (binding) void binding.port.save().catch((error: unknown) => this.events.error(asError(error)));
      },
      exit: (error) => { if (current()) this.fail(error); },
      navigate: (direction) => { if (current()) this.events.navigate?.(direction); },
    });
    this.session = session;
    try {
      await session.start();
      if (!current()) { session.dispose(); return; }
      this.ready = true;
      this.events.status("Ready");
      for (const port of this.ports.values()) this.bind(port);
      for (const port of this.ports.values()) port.setConnected(true);
    } catch (error) {
      if (current()) this.fail(asError(error));
    }
  }

  stop(): void {
    this.generation++;
    this.ready = false;
    this.session?.dispose();
    this.session = undefined;
    this.activePort = undefined;
    this.bindings.clear();
    this.files.clear();
    this.buffers.clear();
    this.queue = Promise.resolve();
    for (const port of this.ports.values()) port.setConnected(false);
    this.events.commandLine("");
    this.events.message("");
    this.events.status("Off");
  }

  focus(port: EditorPort): void {
    const binding = this.bindings.get(port.id);
    if (!binding) return;
    const cursor = this.cursorIntent(binding);
    this.enqueue(async (session) => { if (this.live(binding)) await this.ensureActive(session, binding, cursor); });
  }

  hostChanged(port: EditorPort, before: Text, changes: ChangeSet): void {
    const binding = this.bindings.get(port.id);
    if (!binding) return;
    const file = binding.file, previous = file.text;
    const visible = file.hostChange(before, changes);
    this.broadcast(file, previous, visible);
    if (!file.pending.empty) this.enqueue((session) => this.flush(session, file));
  }

  selectionChanged(port: EditorPort, doc: Text, head: number, revision: number, send = true): void {
    const binding = this.bindings.get(port.id);
    if (!binding) return;
    binding.cursor = documentDiff(doc, binding.file.text).mapPos(head, 1);
    binding.revision = revision;
    if (!send) return;
    this.enqueue(async (session) => {
      if (!this.live(binding) || this.activePort !== port.id || binding.revision !== revision) return;
      for (let retries = 0; retries < 100; retries++) {
        await this.flush(session, binding.file);
        if (!this.live(binding) || binding.revision !== revision) return;
        if (await session.moveCursor(binding.file.id, this.cursor(binding), revision, port.id, binding.file.tick)) return;
      }
      throw new Error("The cursor could not be synchronized with the changing note.");
    });
  }

  currentText(port: EditorPort): Text | undefined { return this.bindings.get(port.id)?.file.text; }

  currentState(port: EditorPort, state: NeovimState): boolean {
    const binding = this.bindings.get(port.id);
    return !!binding && this.activePort === port.id && state.view === port.id &&
      state.id === binding.file.id && state.revision === binding.revision &&
      state.tick === binding.file.tick && binding.file.pending.empty;
  }

  refreshText(port: EditorPort): void {
    const text = this.currentText(port);
    if (text) port.applyText(text, ChangeSet.empty(text.length), text);
  }

  input(port: EditorPort, keys: string): void {
    const binding = this.bindings.get(port.id);
    if (!binding) return;
    const cursor = this.cursorIntent(binding);
    this.enqueue(async (session) => {
      if (!this.live(binding)) return;
      await this.ensureActive(session, binding, cursor);
      if (this.live(binding)) await session.input(keys);
    });
  }

  paste(port: EditorPort, text: string): void {
    const binding = this.bindings.get(port.id);
    if (!binding) return;
    const cursor = this.cursorIntent(binding);
    this.enqueue(async (session) => {
      if (!this.live(binding)) return;
      await this.ensureActive(session, binding, cursor);
      if (this.live(binding)) await session.paste(text);
    });
  }

  resize(port: EditorPort, width: number, height: number): void {
    if (this.ready && port.id === this.activePort) this.enqueue((session) => session.resize(width, height));
  }

  private bind(port: EditorPort): void {
    const document = port.document(), key = document.key ?? document.name;
    const text = Text.of(document.text.split("\n"));
    let file = this.files.get(key);
    if (!file) {
      file = new FileBuffer(this.nextBufferId++, document.name, text);
      this.files.set(key, file);
      this.buffers.set(file.id, file);
    } else if (!this.fileBindings(file).length) {
      const before = file.detachedText ?? file.text;
      if (!before.eq(text)) file.hostChange(before, documentDiff(before, text));
      file.detachedText = undefined;
    }
    const line = text.line(Math.max(1, Math.min(document.cursor[0], text.lines)));
    const cursor = line.from + byteToUtf16(line.text, document.cursor[1]);
    this.bindings.set(port.id, { port, file, cursor: documentDiff(text, file.text).mapPos(cursor, 1), revision: document.revision });
    this.rename(key, document.name);
    this.refreshText(port);
  }

  private live(binding: Binding): boolean { return this.bindings.get(binding.port.id) === binding; }

  private fileBindings(file: FileBuffer): Binding[] { return [...this.bindings.values()].filter((binding) => binding.file === file); }

  private receiveChanges(event: NeovimChanges): void {
    const file = this.buffers.get(event.id);
    if (!file) return;
    const before = file.text;
    const changes = file.receive(event);
    this.broadcast(file, before, changes);
  }

  private broadcast(file: FileBuffer, before: Text, changes: ChangeSet): void {
    if (changes.empty) return;
    for (const binding of this.fileBindings(file)) {
      binding.cursor = changes.mapPos(binding.cursor, 1);
      binding.port.applyText(before, changes, file.text);
    }
  }

  private cursorIntent(binding: Binding): CursorIntent {
    return { text: binding.file.text, head: binding.cursor, revision: binding.revision };
  }

  private cursor(binding: Binding, intent?: CursorIntent): [number, number] {
    const text = binding.file.text;
    const offset = intent ? documentDiff(intent.text, text).mapPos(intent.head, 1) : binding.cursor;
    const head = Math.max(0, Math.min(offset, text.length));
    const line = text.lineAt(head);
    return [line.number, utf16ToByte(line.text, head - line.from)];
  }

  private async initialize(session: NeovimSession, file: FileBuffer): Promise<void> {
    if (file.initialized) return;
    await session.open({ id: file.id, name: file.name, text: file.shadow.toString(), cursor: [1, 0], revision: 0 });
    file.initialized = true;
  }

  private async flush(session: NeovimSession, file: FileBuffer): Promise<void> {
    await this.initialize(session, file);
    for (let retries = 0; !file.pending.empty; retries++) {
      if (retries >= 100) throw new Error("The note is changing too quickly to synchronize with Neovim.");
      const token = this.nextEditToken++;
      const edits = bufferEdits(file.shadow, file.pending);
      file.inflight = { token, after: ChangeSet.empty(file.text.length) };
      const accepted = await session.change(file.id, file.tick, token, edits);
      if (!accepted) file.inflight = undefined;
    }
  }

  private async ensureActive(session: NeovimSession, binding: Binding, cursor: CursorIntent): Promise<void> {
    await this.flush(session, binding.file);
    if (!this.live(binding) || this.activePort === binding.port.id) return;
    this.activePort = binding.port.id;
    for (let retries = 0; retries < 100; retries++) {
      if (!this.live(binding)) return;
      if (await session.activate({ id: binding.file.id, name: binding.file.name, text: "", cursor: this.cursor(binding, cursor), revision: cursor.revision }, binding.port.id, binding.file.tick)) return;
      await this.flush(session, binding.file);
    }
    throw new Error("The active note could not be synchronized with Neovim.");
  }

  private enqueue(action: (session: NeovimSession) => Promise<unknown>): void {
    const session = this.session;
    const generation = this.generation;
    if (!session || !this.ready) return;
    this.queue = this.queue.then(async () => {
      if (this.generation === generation) await action(session);
    }).catch((error: unknown) => {
      if (this.generation === generation) this.fail(asError(error));
    });
  }

  private fail(error: Error): void {
    this.stop();
    this.events.status("Disconnected");
    this.events.error(error);
  }
}

export function modeLabel(mode: string): string {
  if (mode.startsWith("no")) return "OPERATOR";
  if (mode.startsWith("i")) return "INSERT";
  if (mode.startsWith("R")) return "REPLACE";
  if (mode === "V") return "VISUAL LINE";
  if (mode === "\x16") return "VISUAL BLOCK";
  if (mode.startsWith("v")) return "VISUAL";
  if (mode === "S") return "SELECT LINE";
  if (mode === "\x13") return "SELECT BLOCK";
  if (mode.startsWith("s")) return "SELECT";
  if (mode.startsWith("c")) return "COMMAND";
  if (mode.startsWith("r")) return "PROMPT";
  if (mode === "t") return "TERMINAL";
  if (mode === "!") return "SHELL";
  return "NORMAL";
}
