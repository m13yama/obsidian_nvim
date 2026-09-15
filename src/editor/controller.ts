import { NeovimSession, type EditorDocument, type NavigationDirection, type NeovimState, type SessionOptions } from "../neovim/session";
import { asError } from "../neovim/rpc";

export interface EditorPort {
  id: number;
  document(): EditorDocument;
  apply(state: NeovimState): void;
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

/** Serializes host operations and invalidates callbacks when a process is restarted. */
export class EditorController {
  private ports = new Map<number, EditorPort>();
  private session?: NeovimSession;
  private activeId?: number;
  private initialized = new Map<number, string>();
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  ready = false;

  constructor(private events: ControllerEvents) {}

  register(port: EditorPort): void {
    this.ports.set(port.id, port);
    port.setConnected(this.ready);
  }

  unregister(id: number): void {
    this.ports.delete(id);
    this.initialized.delete(id);
    if (this.activeId === id) {
      this.activeId = undefined;
      if (this.ready) this.events.status("Ready");
    }
    if (this.ready) this.enqueue((session) => session.release(id));
  }

  async start(options: SessionOptions): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.events.status("Starting…");
    const current = () => generation === this.generation;
    const session = new NeovimSession(options, {
      state: (state) => {
        if (!current()) return;
        this.ports.get(state.id)?.apply(state);
        if (state.id === this.activeId) this.events.status(modeLabel(state.mode), {
          file: this.initialized.get(state.id),
          line: state.cursor[0],
          column: state.screenColumn,
          totalLines: state.lineCount,
          recording: state.recording,
        });
      },
      commandLine: (text) => { if (current()) this.events.commandLine(text); },
      message: (text) => { if (current()) this.events.message(text); },
      write: (id) => {
        if (current()) void this.ports.get(id)?.save().catch((error: unknown) => this.events.error(asError(error)));
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
    this.activeId = undefined;
    this.initialized.clear();
    this.queue = Promise.resolve();
    for (const port of this.ports.values()) port.setConnected(false);
    this.events.commandLine("");
    this.events.message("");
    this.events.status("Off");
  }

  focus(port: EditorPort): void {
    const id = port.id;
    if (this.ready) this.enqueue(async (session) => {
      if (port.id === id) await this.ensureActive(session, port);
    });
  }

  hostChanged(port: EditorPort): void {
    if (!this.ready) return;
    const document = port.document();
    this.enqueue(async (session) => {
      if (!this.ports.has(document.id) || !this.initialized.has(document.id)) return;
      await session.sync(document);
    });
  }

  input(port: EditorPort, keys: string): void {
    const id = port.id;
    this.enqueue(async (session) => {
      if (port.id !== id || !this.ports.has(id)) return;
      await this.ensureActive(session, port);
      await session.input(keys);
    });
  }

  paste(port: EditorPort, text: string): void {
    const id = port.id;
    this.enqueue(async (session) => {
      if (port.id !== id || !this.ports.has(id)) return;
      await this.ensureActive(session, port);
      await session.paste(text);
    });
  }

  resize(port: EditorPort, width: number, height: number): void {
    if (this.ready && port.id === this.activeId) this.enqueue((session) => session.resize(width, height));
  }

  private async ensureActive(session: NeovimSession, port: EditorPort): Promise<void> {
    if (this.activeId === port.id || !this.ports.has(port.id)) return;
    const document = port.document();
    this.activeId = document.id;
    this.initialized.set(document.id, document.name);
    await session.activate(document);
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
