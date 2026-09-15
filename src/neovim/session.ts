import { BRIDGE_LUA } from "./bridge";
import { NeovimRpc } from "./rpc";

export interface NeovimState {
  id: number;
  revision: number;
  lines?: string[];
  cursor: [number, number];
  anchor: [number, number];
  mode: string;
}

export interface EditorDocument {
  id: number;
  revision: number;
  text: string;
  cursor: [number, number];
  name: string;
}

export interface SessionOptions {
  executable: string;
  useConfig: boolean;
  initPath: string;
  cwd?: string;
}

export interface SessionEvents {
  state: (state: NeovimState) => void;
  commandLine: (text: string) => void;
  message: (text: string) => void;
  write: (id: number) => void;
  exit: (error: Error) => void;
}

export class NeovimSession {
  private rpc?: NeovimRpc;
  private activeId?: number;
  private commandLines = new Map<number, string>();
  private disposed = false;

  constructor(private options: SessionOptions, private events: SessionEvents) {}

  async start(): Promise<void> {
    const args = ["--embed", "--headless", "-n", "-i", "NONE", "--cmd", "let g:obsidian = v:true"];
    if (!this.options.useConfig) args.push("--clean");
    else if (this.options.initPath.trim()) args.push("-u", this.options.initPath.trim());
    const rpc = new NeovimRpc(this.options.executable, args, this.options.cwd);
    this.rpc = rpc;
    rpc.onNotification = (method, args) => this.notification(method, args);
    rpc.onExit = (error) => { if (!this.disposed) this.events.exit(error); };
    try {
      const [channel, metadata] = await rpc.request<[number, { version: { major: number; minor: number } }]>("nvim_get_api_info");
      if (metadata.version.major === 0 && metadata.version.minor < 9) throw new Error("Neovim 0.9 or newer is required.");
      if (this.disposed) throw new Error("Neovim startup cancelled.");
      await rpc.request("nvim_ui_attach", [120, 40, {
        rgb: true, ext_linegrid: true, ext_cmdline: true, ext_messages: true, ext_popupmenu: true,
      }]);
      await rpc.request("nvim_exec_lua", [BRIDGE_LUA, [channel]]);
    } catch (error) {
      rpc.dispose();
      throw error;
    }
  }

  async activate(document: EditorDocument): Promise<void> {
    if (this.activeId !== undefined && this.activeId !== document.id) await this.input("<Esc>");
    await this.lua("activate", [document.id, document.text.split("\n"), document.cursor, document.revision, document.name]);
    this.activeId = document.id;
  }

  async sync(document: EditorDocument): Promise<void> {
    await this.lua("sync", [document.id, document.text.split("\n"), document.cursor, document.revision]);
  }

  async moveCursor(id: number, cursor: [number, number]): Promise<void> {
    await this.lua("cursor", [id, cursor]);
  }

  async input(keys: string): Promise<void> {
    // nvim_input can accept only part of the input when its queue is full.
    let remaining = Buffer.from(keys, "utf8");
    let attempts = 0;
    while (remaining.length) {
      const count = await this.request<number>("nvim_input", [remaining.toString("utf8")]);
      if (count === 0) {
        if (++attempts > 100) throw new Error("Neovim input queue is full.");
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else {
        attempts = 0;
        remaining = remaining.subarray(count);
      }
    }
  }

  async paste(text: string): Promise<void> {
    await this.request("nvim_paste", [text.replace(/\r\n?/g, "\n"), false, -1]);
  }

  async resize(width: number, height: number): Promise<void> {
    await this.request("nvim_ui_try_resize", [Math.max(20, width), Math.max(5, height)]);
  }

  async release(id: number): Promise<void> {
    if (this.activeId === id) {
      await this.input("<Esc>");
      this.activeId = undefined;
    }
    await this.lua("release", [id]);
  }

  async snapshot(): Promise<void> { await this.lua("snapshot", []); }

  dispose(): void {
    this.disposed = true;
    this.rpc?.dispose();
    this.rpc = undefined;
  }

  private request<T = unknown>(method: string, args: unknown[]): Promise<T> {
    if (!this.rpc || this.disposed) return Promise.reject(new Error("Neovim is disconnected."));
    return this.rpc.request<T>(method, args);
  }

  private lua(method: string, args: unknown[]): Promise<unknown> {
    return this.request("nvim_exec_lua", [`return obsidian_bridge.${method}(...)`, args]);
  }

  private notification(method: string, args: unknown[]): void {
    if (this.disposed) return;
    if (method === "obsidian:state") this.events.state(args[0] as NeovimState);
    else if (method === "obsidian:write") this.events.write(args[0] as number);
    else if (method === "redraw") this.redraw(args as unknown[][]);
  }

  private redraw(events: unknown[][]): void {
    for (const [name, ...batches] of events) {
      for (const item of batches) {
        const args = item as unknown[];
        if (name === "cmdline_show") {
          const [content, , first, prompt, indent, level] = args;
          this.commandLines.set(Number(level), String(first) + String(prompt) + " ".repeat(Number(indent)) + chunksText(content));
          this.showCommandLine();
        } else if (name === "cmdline_hide") {
          this.commandLines.delete(Number(args[0]));
          this.showCommandLine();
        } else if (name === "msg_show") {
          const message = chunksText(args[1]);
          if (message.trim()) this.events.message(message);
        } else if (name === "msg_clear") {
          this.events.message("");
        }
      }
    }
  }

  private showCommandLine(): void {
    const level = Math.max(0, ...this.commandLines.keys());
    this.events.commandLine(this.commandLines.get(level) ?? "");
  }
}

function chunksText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((chunk: unknown) => Array.isArray(chunk) ? String(chunk[1] ?? "") : "").join("");
}
