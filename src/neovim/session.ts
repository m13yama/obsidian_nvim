import { BRIDGE_LUA } from "./bridge";
import { NeovimRpc } from "./rpc";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface BlockSelectionPoint {
  /** UTF-8 byte offset of a character, or the end of the line. */
  byte: number;
  /** Offset in Neovim screen cells from the start of the character. */
  offset: number;
  /** Character width in cells; zero means a position after the line end. */
  width: number;
}

export interface BlockSelectionRow {
  line: number;
  from: BlockSelectionPoint;
  to: BlockSelectionPoint;
}

export interface NeovimState {
  id: number;
  view: number;
  tick: number;
  /** Host selection version; unrelated to the buffer's changedtick. */
  revision: number;
  cursor: [number, number];
  anchor: [number, number];
  mode: string;
  lineCount: number;
  screenColumn: number;
  recording: string;
  scroll?: "center";
  blockSelection?: BlockSelectionRow[];
}

export interface BufferEdit {
  start: [number, number];
  end: [number, number];
  lines: string[];
}

export interface BufferChange {
  first: number;
  last: number;
  lines: string[];
}

export interface NeovimChanges {
  id: number;
  tick: number;
  changes: BufferChange[];
  origin?: number;
  initial?: boolean;
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
  env?: NodeJS.ProcessEnv;
  navigation?: boolean;
}

export type NavigationDirection = "left" | "right" | "up" | "down" | "editor";

export interface SessionEvents {
  state: (state: NeovimState) => void;
  changes?: (changes: NeovimChanges) => void;
  commandLine: (text: string) => void;
  message: (text: string) => void;
  write: (id: number) => void;
  exit: (error: Error) => void;
  navigate?: (direction: NavigationDirection) => void;
}

export class NeovimSession {
  private rpc?: NeovimRpc;
  private activeId?: number;
  private activeView?: number;
  private buffers = new Set<number>();
  private commandLines = new Map<number, string>();
  private disposed = false;
  private startup?: { resolve: () => void; reject: (error: Error) => void };

  constructor(private options: SessionOptions, private events: SessionEvents) {}

  async start(): Promise<void> {
    const initPath = this.options.useConfig && this.options.initPath.trim()
      ? resolveInitPath(this.options.initPath.trim(), this.options.cwd)
      : undefined;
    if (initPath) {
      try {
        await access(initPath, constants.R_OK);
        if (!(await stat(initPath)).isFile()) throw new Error("Not a file");
      }
      catch { throw new Error(`Cannot read Neovim init file: ${initPath}`); }
    }
    if (this.disposed) throw new Error("Neovim startup cancelled.");
    // --embed pauses before init until the UI is attached. --headless skips that
    // handshake and causes UI-dependent startup plugins to see a headless process.
    const args = ["--embed", "-n", "-i", "NONE", "--cmd", "let g:obsidian = v:true"];
    if (!this.options.useConfig) args.push("--clean");
    else if (initPath) args.push("-u", initPath);
    const rpc = new NeovimRpc(this.options.executable, args, this.options.cwd, this.options.env);
    this.rpc = rpc;
    rpc.onNotification = (method, args) => this.notification(method, args);
    rpc.onExit = (error) => {
      this.startup?.reject(error);
      if (!this.disposed) this.events.exit(error);
    };
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [channel, metadata] = await rpc.request<[number, { version: { major: number; minor: number } }]>("nvim_get_api_info");
      if (metadata.version.major === 0 && metadata.version.minor < 9) throw new Error("Neovim 0.9 or newer is required.");
      if (this.disposed) throw new Error("Neovim startup cancelled.");
      await rpc.request("nvim_exec_lua", [String.raw`
        local channel, config_dir = ...
        if type(config_dir) == 'string' then
          -- A custom init can require sibling lua/ modules and load its own
          -- plugin/, pack/, and after/ files just like a standard config directory.
          vim.opt.runtimepath:prepend(config_dir)
          vim.opt.runtimepath:append(config_dir .. '/after')
          vim.opt.packpath:prepend(config_dir)
          vim.opt.packpath:append(config_dir .. '/after')
        end
        vim.api.nvim_create_autocmd('VimEnter', {
          once = true,
          callback = function()
            vim.schedule(function() vim.rpcnotify(channel, 'obsidian:ready') end)
          end,
        })
      `, [channel, initPath ? dirname(initPath) : null]]);
      const ready = new Promise<void>((resolve, reject) => {
        this.startup = { resolve, reject };
        startupTimer = setTimeout(() => reject(new Error("Neovim configuration did not finish loading. Check startup messages or try clean mode.")), 30000);
      });
      // Register both promises together so exit/cancellation also rejects cleanly
      // while nvim_ui_attach is still waiting for user configuration to finish.
      await Promise.all([
        ready,
        rpc.request("nvim_ui_attach", [120, 40, {
          rgb: true, ext_linegrid: true, ext_cmdline: true, ext_messages: true, ext_popupmenu: true,
        }], 30000),
      ]);
      await rpc.request("nvim_exec_lua", [BRIDGE_LUA, [channel]]);
      await this.lua("setup_scrolling", []);
      if (this.options.navigation) await this.lua("setup_navigation", []);
    } catch (error) {
      rpc.dispose();
      throw error;
    } finally {
      clearTimeout(startupTimer);
      this.startup = undefined;
    }
  }

  async open(document: EditorDocument): Promise<void> {
    if (this.buffers.has(document.id)) return;
    await this.lua("open", [document.id, document.text.split("\n"), document.name]);
    this.buffers.add(document.id);
  }

  async activate(document: EditorDocument, view = document.id, tick?: number): Promise<boolean> {
    await this.open(document);
    if (this.activeId !== undefined && (this.activeId !== document.id || this.activeView !== view)) await this.input("<Esc>");
    const accepted = await this.lua("activate", [document.id, document.cursor, document.revision, view, tick ?? null]) as boolean;
    if (!accepted) return false;
    this.activeId = document.id;
    this.activeView = view;
    return true;
  }

  async change(id: number, tick: number, token: number, edits: BufferEdit[]): Promise<boolean> {
    return await this.lua("change", [id, tick, token, edits]) as boolean;
  }

  async moveCursor(id: number, cursor: [number, number], revision = 0, view = id, tick?: number): Promise<boolean> {
    return await this.lua("cursor", [id, cursor, revision, view, tick ?? null]) as boolean;
  }

  async rename(id: number, name: string): Promise<void> { await this.lua("rename", [id, name]); }

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
    if (!this.rpc || this.disposed) throw new Error("Neovim is disconnected.");
    // Neovim can defer resizing while waiting for the rest of a command (e.g.
    // Ctrl-W l). Waiting for its reply would block that next key in our queue.
    this.rpc.notify("nvim_ui_try_resize", [Math.max(20, width), Math.max(5, height)]);
  }

  async release(id: number): Promise<void> {
    if (this.activeId === id) {
      await this.input("<Esc>");
      this.activeId = undefined;
    }
    await this.lua("release", [id]);
    this.buffers.delete(id);
  }

  async snapshot(): Promise<void> { await this.lua("snapshot", []); }

  dispose(): void {
    this.disposed = true;
    this.startup?.reject(new Error("Neovim startup cancelled."));
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
    if (method === "obsidian:ready") this.startup?.resolve();
    else if (method === "obsidian:state") this.events.state(args[0] as NeovimState);
    else if (method === "obsidian:changes") this.events.changes?.(args[0] as NeovimChanges);
    else if (method === "obsidian:write") this.events.write(args[0] as number);
    else if (method === "obsidian:navigate" && ["left", "right", "up", "down", "editor"].includes(String(args[0]))) {
      this.events.navigate?.(args[0] as NavigationDirection);
    }
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

function resolveInitPath(path: string, cwd?: string): string {
  const expanded = path === "~" ? homedir() : /^~[/\\]/.test(path) ? resolve(homedir(), path.slice(2)) : path;
  return resolve(cwd ?? process.cwd(), expanded);
}
