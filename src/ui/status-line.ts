import type { StatusDetails } from "../editor/controller";
import type { StatusLineStyle } from "../settings";

interface ModeAppearance {
  tone: string;
  label: string;
  symbol: string;
}

const MODES: Record<string, ModeAppearance> = {
  NORMAL: { tone: "normal", label: "NORMAL", symbol: "◆" },
  INSERT: { tone: "insert", label: "INSERT", symbol: "▏" },
  VISUAL: { tone: "visual", label: "VISUAL", symbol: "▧" },
  "VISUAL LINE": { tone: "visual", label: "V-LINE", symbol: "≡" },
  "VISUAL BLOCK": { tone: "visual", label: "V-BLOCK", symbol: "▦" },
  SELECT: { tone: "visual", label: "SELECT", symbol: "▧" },
  "SELECT LINE": { tone: "visual", label: "S-LINE", symbol: "≡" },
  "SELECT BLOCK": { tone: "visual", label: "S-BLOCK", symbol: "▦" },
  REPLACE: { tone: "replace", label: "REPLACE", symbol: "↺" },
  OPERATOR: { tone: "operator", label: "OP-PENDING", symbol: "…" },
  COMMAND: { tone: "command", label: "COMMAND", symbol: ":" },
  PROMPT: { tone: "command", label: "PROMPT", symbol: "?" },
  TERMINAL: { tone: "insert", label: "TERMINAL", symbol: ">" },
  SHELL: { tone: "command", label: "SHELL", symbol: "$" },
  Ready: { tone: "idle", label: "READY", symbol: "◇" },
  Off: { tone: "idle", label: "OFF", symbol: "○" },
  "Starting…": { tone: "starting", label: "STARTING", symbol: "◌" },
  Disconnected: { tone: "error", label: "OFFLINE", symbol: "!" },
};

/** A native DOM status line; no terminal fonts or Neovim UI plugins required. */
export class NeovimStatusLine {
  private button: HTMLButtonElement;
  private symbol: HTMLElement;
  private label: HTMLElement;
  private file: HTMLElement;
  private recording: HTMLElement;
  private position: HTMLElement;
  private progress: HTMLElement;
  private announcement: HTMLElement;
  private lastAnnouncement = "";

  constructor(private container: HTMLElement, private onRestart: () => void, style: StatusLineStyle = "powerline") {
    const document = container.ownerDocument;
    container.classList.add("neovim-status");
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "neovim-statusline";
    const segment = (className: string, text = "", parent: HTMLElement = this.button) => {
      const element = document.createElement("span");
      element.className = className;
      element.textContent = text;
      parent.append(element);
      return element;
    };
    segment("neovim-statusline-engine", "NVIM");
    const mode = segment("neovim-statusline-mode");
    this.symbol = segment("neovim-statusline-symbol", "", mode);
    this.symbol.setAttribute("aria-hidden", "true");
    this.label = segment("neovim-statusline-label", "", mode);
    this.file = segment("neovim-statusline-file");
    this.recording = segment("neovim-statusline-recording");
    this.position = segment("neovim-statusline-position");
    this.progress = segment("neovim-statusline-progress");
    this.announcement = document.createElement("span");
    this.announcement.className = "neovim-statusline-announcement";
    this.announcement.setAttribute("role", "status");
    this.announcement.setAttribute("aria-live", "polite");
    this.announcement.setAttribute("aria-atomic", "true");
    container.append(this.button, this.announcement);
    this.button.addEventListener("click", this.onRestart);
    this.setStyle(style);
    this.update("Off");
  }

  setStyle(style: StatusLineStyle): void {
    this.button.dataset.style = style === "compact" ? "compact" : "powerline";
  }

  update(status: string, details?: StatusDetails): void {
    const appearance = MODES[status] ?? { tone: "idle", label: status.toUpperCase(), symbol: "◇" };
    this.button.dataset.tone = appearance.tone;
    this.button.setAttribute("aria-busy", String(appearance.tone === "starting"));
    this.symbol.textContent = appearance.symbol;
    this.label.textContent = appearance.label;

    const fileName = details?.file?.split(/[/\\]/).pop() ?? "";
    this.file.textContent = fileName;
    this.file.hidden = !fileName;
    this.file.title = details?.file ?? "";
    this.recording.textContent = details?.recording ? `REC @${details.recording}` : "";
    this.recording.hidden = !details?.recording;

    const hasPosition = !!details && details.line > 0 && details.column > 0 && details.totalLines > 0;
    this.position.hidden = !hasPosition;
    this.progress.hidden = !hasPosition;
    this.position.textContent = hasPosition ? `${details.line}:${details.column}` : "";
    this.progress.textContent = hasPosition ? documentProgress(details.line, details.totalLines) : "";

    const description = [`Neovim: ${status}`];
    if (details?.file) description.push(details.file);
    if (hasPosition) description.push(`Line ${details.line} of ${details.totalLines}, column ${details.column}`);
    if (details?.recording) description.push(`Recording macro @${details.recording}`);
    description.push("Restart Neovim");
    this.button.title = description.join(" · ");
    this.button.setAttribute("aria-label", description.join(". "));

    // Announce mode/recording changes, not every cursor movement.
    const announcement = `Neovim ${status}${details?.recording ? `, recording macro ${details.recording}` : ""}`;
    if (announcement !== this.lastAnnouncement) {
      this.announcement.textContent = announcement;
      this.lastAnnouncement = announcement;
    }
  }

  destroy(): void {
    this.button.removeEventListener("click", this.onRestart);
    this.button.remove();
    this.announcement.remove();
    this.container.classList.remove("neovim-status");
  }
}

function documentProgress(line: number, totalLines: number): string {
  if (totalLines === 1) return "ALL";
  if (line <= 1) return "TOP";
  if (line >= totalLines) return "END";
  return `${Math.floor(line / totalLines * 100)}%`;
}
