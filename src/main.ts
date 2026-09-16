import { editorInfoField, FileSystemAdapter, MarkdownView, Notice, Plugin, PluginSettingTab, Scope, Setting, type App } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { EditorController } from "./editor/controller";
import { neovimExtension } from "./editor/extension";
import { DEFAULT_SETTINGS, type NeovimSettings, type StatusLineStyle } from "./settings";
import { NeovimStatusLine } from "./ui/status-line";
import { EditorKeyRouter } from "./editor/key-router";
import { WorkspaceNavigation } from "./obsidian/navigation";
import { ReadingPositionSync } from "./obsidian/reading-position";

export default class NeovimPlugin extends Plugin {
  settings: NeovimSettings = { ...DEFAULT_SETTINGS };
  private controller!: EditorController;
  private statusLine!: NeovimStatusLine;
  private commandLine!: HTMLElement;
  private messageTimer?: ReturnType<typeof setTimeout>;
  private showingCommand = false;
  private unloaded = false;
  private keyRouter = new EditorKeyRouter();
  private navigation!: WorkspaceNavigation;
  private readingPosition!: ReadingPositionSync;

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() };
    this.statusLine = new NeovimStatusLine(this.addStatusBarItem(), () => { void this.restart(); }, this.settings.statusLineStyle);
    this.register(() => this.statusLine.destroy());
    this.commandLine = document.body.createDiv({ cls: "neovim-command-line" });
    this.commandLine.setAttribute("role", "status");
    this.commandLine.setAttribute("aria-live", "polite");
    this.commandLine.hidden = true;
    this.register(() => this.commandLine.remove());

    this.controller = new EditorController({
      status: (status, details) => this.statusLine.update(status, details),
      commandLine: (text) => {
        this.showingCommand = text.length > 0;
        this.showMessage(text);
      },
      message: (text) => { if (!this.showingCommand) this.showMessage(text, 6000); },
      error: (error) => {
        console.error("Obsidian Neovim:", error);
        new Notice(`Neovim: ${error.message}\nCheck Neovim settings, then run “Restart Neovim”.`, 10000);
      },
      navigate: (direction) => {
        if (this.settings.navigation) void this.navigation.navigate(direction).catch((error: unknown) => this.navigationError(error));
      },
    });
    this.navigation = new WorkspaceNavigation(this.app, (parent) => new Scope(parent), this.keyRouter,
      () => this.controller.ready, () => this.settings.navigation, (error) => this.navigationError(error));
    this.readingPosition = new ReadingPositionSync(this.app, () => this.controller.ready);
    this.register(() => this.navigation.destroy());
    this.register(() => this.readingPosition.destroy());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshViews()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshViews()));
    this.registerEditorExtension(neovimExtension(this.controller, {
      name: (view) => view.state.field(editorInfoField, false)?.file?.path ?? this.markdownView(view)?.file?.path ?? "untitled.md",
      save: async (view) => { await this.markdownView(view)?.save(); },
      registerKeys: (view, handler) => this.keyRouter.register(view.contentDOM, handler),
    }));
    this.addSettingTab(new NeovimSettingTab(this.app, this));
    this.addCommand({ id: "restart", name: "Restart Neovim", callback: () => { void this.restart(); } });
    for (const side of ["left", "right"] as const) {
      this.addCommand({ id: `focus-${side}-sidebar`, name: `Focus ${side} sidebar`,
        hotkeys: side === "left" ? [{ modifiers: ["Ctrl"], key: "0" }] : [],
        callback: () => { void this.navigation.focusSidebar(side).catch((error: unknown) => this.navigationError(error)); } });
    }
    this.addCommand({ id: "focus-editor", name: "Focus editor", callback: () => {
      void this.navigation.focusEditor().catch((error: unknown) => this.navigationError(error));
    } });
    this.addCommand({
      id: "toggle", name: "Toggle Neovim",
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        void this.saveData(this.settings);
        if (this.settings.enabled) void this.restart();
        else this.controller.stop();
      },
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.refreshViews();
      if (this.settings.enabled) void this.restart();
      else this.controller.stop();
    });
  }

  onunload(): void {
    this.unloaded = true;
    clearTimeout(this.messageTimer);
    this.controller?.stop();
  }

  async restart(): Promise<void> {
    this.settings.enabled = true;
    await this.saveData(this.settings);
    if (this.unloaded) return;
    const adapter = this.app.vault.adapter;
    await this.controller.start({
      executable: this.settings.executable.trim() || "nvim",
      useConfig: this.settings.useConfig,
      initPath: this.settings.initPath,
      navigation: this.settings.navigation,
      cwd: adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined,
    });
  }

  async setStatusLineStyle(style: StatusLineStyle): Promise<void> {
    this.settings.statusLineStyle = style;
    this.statusLine.setStyle(style);
    await this.saveData(this.settings);
  }

  private navigationError(error: unknown): void {
    console.error("Obsidian Neovim navigation:", error);
    new Notice(error instanceof Error ? `Neovim: ${error.message}` : "Neovim could not complete that workspace action.");
  }

  private refreshViews(): void {
    this.navigation.refresh();
    this.readingPosition.refresh();
  }

  private markdownView(editor: EditorView): MarkdownView | undefined {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (!(leaf.view instanceof MarkdownView)) continue;
      // Obsidian documents editor.cm as the CM6 access point but omits it from its types.
      const candidate = leaf.view.editor as typeof leaf.view.editor & { cm?: EditorView };
      if (candidate.cm === editor) return leaf.view;
    }
    return undefined;
  }

  private showMessage(text: string, timeout?: number): void {
    clearTimeout(this.messageTimer);
    this.commandLine.setText(text);
    this.commandLine.hidden = text.length === 0;
    if (timeout && text) this.messageTimer = setTimeout(() => {
      this.commandLine.hidden = true;
    }, timeout);
  }
}

class NeovimSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NeovimPlugin) { super(app, plugin); }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Neovim" });
    this.containerEl.createEl("p", { text: "Requires desktop Obsidian and Neovim 0.9 or newer. Turn off Obsidian’s built-in Vim key bindings. Apply changes with Restart Neovim below." });
    new Setting(this.containerEl)
      .setName("Status line style")
      .setDesc("Powerline shows colored mode segments, the note name, cursor position, and progress. Compact keeps the mode and position. Changes apply immediately.")
      .addDropdown((dropdown) => dropdown
        .addOption("powerline", "Powerline")
        .addOption("compact", "Compact")
        .setValue(this.plugin.settings.statusLineStyle)
        .onChange(async (value) => { await this.plugin.setStatusLineStyle(value as StatusLineStyle); }));
    new Setting(this.containerEl)
      .setName("Vim pane and sidebar navigation")
      .setDesc("Ctrl+0 focuses the left sidebar. Ctrl+W then j/k/l moves down/up/right between panes and the right sidebar; p returns to the editor. Files uses vscode-neovim keys: a/A create a note/folder, r renames, d deletes, y/x/p copy/cut/paste, v opens to the right, R refreshes. Esc returns to the note. Existing Neovim mappings take priority. Restart Neovim to apply.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.navigation).onChange(async (value) => {
        this.plugin.settings.navigation = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(this.containerEl)
      .setName("Neovim executable")
      .setDesc("Use nvim if it is on Obsidian’s PATH, or the full path to the executable. Do not include command-line arguments.")
      .addText((text) => text.setPlaceholder("nvim").setValue(this.plugin.settings.executable).onChange(async (value) => {
        this.plugin.settings.executable = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(this.containerEl)
      .setName("Load Neovim configuration")
      .setDesc("On by default. Loads your init.lua/init.vim, modules, and plugins. Use vim.g.obsidian in Lua or g:obsidian in Vimscript to detect Obsidian before your config loads. Turn off for clean mode; restart to apply.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.useConfig).onChange(async (value) => {
        this.plugin.settings.useConfig = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(this.containerEl)
      .setName("Custom init file")
      .setDesc("Leave blank to use your normal Neovim config. A custom init.lua/init.vim also loads modules and plugins from its directory. Paths starting with ~/ are supported.")
      .addText((text) => text.setPlaceholder("/path/to/obsidian-init.lua").setValue(this.plugin.settings.initPath).onChange(async (value) => {
        this.plugin.settings.initPath = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(this.containerEl)
      .setName("Restart Neovim")
      .setDesc("Applies settings. Neovim registers and undo history reset; open note text stays in Obsidian.")
      .addButton((button) => button.setButtonText("Restart Neovim").onClick(() => { void this.plugin.restart(); }));
  }
}
