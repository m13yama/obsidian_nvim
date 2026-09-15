import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { decodeMultiStream, encode } from "@msgpack/msgpack";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** MessagePack-RPC over the embedded Neovim process's stdin/stdout. */
export class NeovimRpc {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private closed = false;
  private stderr = "";
  onNotification: (method: string, args: unknown[]) => void = () => {};
  onExit: (error: Error) => void = () => {};

  constructor(executable: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
    this.child = spawn(executable, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: "pipe",
      windowsHide: true,
      shell: false,
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      this.fail(new Error(`Neovim exited (${signal ?? code ?? "unknown"}). ${this.stderr}`.trim()));
    });
    void this.read();
  }

  request<T = unknown>(method: string, args: unknown[] = [], timeoutMs = 10000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Neovim is disconnected."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Neovim request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.child.stdin.write(encode([0, id, method, args]));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  dispose(): void {
    if (this.closed && this.child.exitCode !== null) return;
    this.fail(new Error("Neovim connection closed."), false);
    this.child.stdin.destroy();
    this.child.kill();
    const forceKill = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }, 1000);
    forceKill.unref();
    this.child.once("exit", () => clearTimeout(forceKill));
  }

  private async read(): Promise<void> {
    try {
      for await (const message of decodeMultiStream(this.child.stdout)) {
        if (!Array.isArray(message)) throw new Error("Invalid Neovim RPC message.");
        if (message[0] === 1) {
          const pending = this.pending.get(message[1] as number);
          if (!pending) continue;
          this.pending.delete(message[1] as number);
          clearTimeout(pending.timer);
          if (message[2] !== null) {
            const error = message[2] as unknown;
            pending.reject(new Error(Array.isArray(error) ? String(error[1]) : String(error)));
          } else {
            pending.resolve(message[3]);
          }
        } else if (message[0] === 2) {
          this.onNotification(String(message[1]), message[2] as unknown[]);
        } else if (message[0] === 0) {
          // Always reply to unsupported requests so user configuration cannot deadlock RPC.
          this.child.stdin.write(encode([1, message[1], [0, `Unsupported host request: ${message[2]}`], null]));
        }
      }
      this.fail(new Error(`Neovim closed its RPC stream. ${this.stderr}`.trim()));
    } catch (error) {
      this.fail(asError(error));
    }
  }

  private fail(error: Error, notify = true): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (notify) this.onExit(error);
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
