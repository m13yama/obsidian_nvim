import { editorInfoField, FileSystemAdapter, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { EditorController } from "./editor/controller";
import { neovimExtension } from "./editor/extension";
import { DEFAULT_SETTINGS, type NeovimSettings } from "./settings";

export default class NeovimPlugin extends Plugin {
  settings: NeovimSettings = { ...DEFAULT_SETTINGS };
  private controller!: EditorController;
  private status!: HTMLElement;
  private commandLine!: HTMLElement;
  private messageTimer?: ReturnType<typeof setTimeout>;
  private showingCommand = false;
  private unloaded = false;

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() };
    this.status = this.addStatusBarItem();
    this.status.addClass("neovim-status");
    this.status.setAttribute("aria-label", "Neovim status");
    this.commandLine = document.body.createDiv({ cls: "neovim-command-line" });
    this.commandLine.setAttribute("role", "status");
    this.commandLine.setAttribute("aria-live", "polite");
    this.commandLine.hidden = true;
    this.register(() => this.commandLine.remove());

    this.controller = new EditorController({
      status: (status) => this.status.setText(`NVIM ${status}`),
      commandLine: (text) => {
        this.showingCommand = text.length > 0;
        this.showMessage(text);
      },
      message: (text) => { if (!this.showingCommand) this.showMessage(text, 6000); },
      error: (error) => {
        console.error("Obsidian Neovim:", error);
        new Notice(`Neovim: ${error.message}\nCheck Neovim settings, then run “Restart Neovim”.`, 10000);
      },
    });
    this.registerEditorExtension(neovimExtension(this.controller, {
      name: (view) => view.state.field(editorInfoField, false)?.file?.path ?? this.markdownView(view)?.file?.path ?? "untitled.md",
      save: async (view) => { await this.markdownView(view)?.save(); },
    }));
    this.addSettingTab(new NeovimSettingTab(this.app, this));
    this.addCommand({ id: "restart", name: "Restart Neovim", callback: () => { void this.restart(); } });
    this.addCommand({
      id: "toggle", name: "Toggle Neovim",
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        void this.saveData(this.settings);
        if (this.settings.enabled) void this.restart();
        else this.controller.stop();
      },
    });
    this.registerDomEvent(this.status, "click", () => { void this.restart(); });
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
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
      cwd: adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined,
    });
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
      .setName("Neovim executable")
      .setDesc("Use nvim if it is on Obsidian’s PATH, or the full path to the executable. Do not include command-line arguments.")
      .addText((text) => text.setPlaceholder("nvim").setValue(this.plugin.settings.executable).onChange(async (value) => {
        this.plugin.settings.executable = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(this.containerEl)
      .setName("Load Neovim configuration")
      .setDesc("Off starts a clean Neovim. When on, loads your usual configuration or the init file below. vim.g.obsidian is set before your config runs.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.useConfig).onChange(async (value) => {
        this.plugin.settings.useConfig = value;
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(this.containerEl)
      .setName("Custom init file")
      .setDesc("Optional absolute path to init.lua or init.vim. Leave blank to use your normal Neovim config.")
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
