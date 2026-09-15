# Neovim for Obsidian

**0.0.2 — Beta**

An early desktop plugin that uses a **real local Neovim process** to edit notes in Obsidian, inspired by vscode-neovim. Obsidian keeps its Markdown editor and saves the notes. Neovim runs in the background and handles editing commands over MessagePack-RPC.

## Install

Requirements: desktop Obsidian **1.8.7+**, Neovim **0.9+**, and Node.js **22+** for development. Neovim 0.12.5 is tested locally. Mobile is not supported.

For the beta, download `main.js`, `manifest.json`, and `styles.css` from the [0.0.2 release](https://github.com/m13yama/obsidian_nvim/releases/tag/0.0.2), then follow steps 2–5 below. Alternatively, extract `obsidian-neovim-0.0.2.zip` into `<your-vault>/.obsidian/plugins/`. Node.js is only needed when building from source.

1. Build the plugin in this folder:

   ```sh
   npm ci
   npm run build
   ```

2. Create `<your-vault>/.obsidian/plugins/obsidian-neovim/` and copy these three files into it:

   ```text
   main.js
   manifest.json
   styles.css
   ```

3. In Obsidian, turn off **Settings → Editor → Vim key bindings**. Enable community plugins, reload Obsidian, and enable **Neovim** in the community plugin list.
4. Open a Markdown note in editing mode. The status bar should show `NVIM NORMAL`.
5. If Obsidian cannot find Neovim, set **Settings → Neovim → Neovim executable** to its absolute path, then click **Restart Neovim**. GUI apps may have a different `PATH` from your terminal. Use `command -v nvim` on Linux/macOS or `where nvim` on Windows to find the path.

The three install files are already generated after `npm run build`; Node.js and `node_modules` are not needed in your vault.

To upgrade an existing installation, replace all three files, keep your existing `data.json`, and reload Obsidian. See the configuration section below to enable your normal Neovim config when upgrading from 0.0.1.

## What works in this version

- Neovim normal, insert, replace, operator-pending, and keyboard visual editing.
- Motions, text objects, counts, registers, macros, dot repeat, undo (`u`), and redo (`Ctrl-R`) handled by Neovim.
- Neovim `/` and `?` searches and `:` commands, with a small command-line/message display in Obsidian.
- `:w` asks Obsidian to save the current note. Normal Obsidian autosave continues to work.
- Plain-text paste uses `nvim_paste`, so text such as `<Esc>` is inserted literally.
- Unicode conversion between Neovim’s UTF-8 byte columns and CodeMirror’s UTF-16 positions.
- A separate Neovim buffer for each editor, shared registers within the process, and synchronization of changes made through Obsidian.
- Your normal Neovim configuration, key mappings, and startup plugins load by default for new installations (see below for the 0.0.1 upgrade setting).
- **Neovim: Toggle Neovim** and **Neovim: Restart Neovim** commands. Clicking the status bar also restarts Neovim.
- If startup or the process fails, keyboard input returns to Obsidian and note text remains in the editor.

## Mode display

A Powerline-style status line in Obsidian’s status bar shows:

- Green for Normal, blue for Insert, purple for Visual/Select, pink for Replace, amber for Command, and orange for pending operators.
- The active note name, line/display column, and position within the document. The column accounts for tabs and wide characters.
- A `REC @q` indicator while recording a macro into register `q`.
- Distinct Ready, Starting, Off, and Offline states. Hover for the full note path and position; click the status line to restart Neovim.

Choose **Settings → Neovim → Status line style → Powerline / Compact**. The style changes immediately. Compact shows the mode, cursor position, and any macro recording indicator. Narrow windows automatically hide extra details. Both styles follow Obsidian’s light/dark backgrounds and work without a Nerd Font.

![Powerline and compact mode displays in dark and light themes](docs/status-line-preview.png)

This is a standalone preview of the plugin’s actual display component. Both styles are included in 0.0.2.

## Neovim configuration

New installations load your normal Neovim configuration by default. Leave **Custom init file** empty to use Neovim’s usual configuration discovery, including `init.lua`/`init.vim`, required Lua modules, `plugin/`, packages, `after/plugin/`, and filetype plugins. Neovim inherits the Obsidian process’s environment, including `NVIM_APPNAME` and XDG paths if present.

**Upgrading from 0.0.1:** that version defaults to clean mode. Existing saved preferences are preserved, so enable **Settings → Neovim → Load Neovim configuration**, then click **Restart Neovim**. New installations of 0.0.2 start with this setting enabled.

For a custom configuration, set **Custom init file** to an `init.lua` or `init.vim`. Absolute paths and `~/` paths work. Its parent directory is added to Neovim’s runtime and package paths, so sibling `lua/`, `plugin/`, `pack/`, and `after/` files load too. Turn off **Load Neovim configuration** to start a clean Neovim when troubleshooting.

The UI attaches before configuration loads, and the bridge waits for `VimEnter` before opening notes. Startup plugins can detect the attached UI, and Markdown `FileType` hooks run in the note’s buffer. Editing options, clipboard preferences, and display options are preserved in Neovim; settings such as colorschemes, status lines, and line numbers do not automatically change Obsidian’s appearance.

### Detect startup from Obsidian

The plugin sets **`vim.g.obsidian = true`** (Vimscript: **`g:obsidian`**) in its Neovim process **before** `init.lua` or `init.vim` runs. Use it to choose Obsidian-specific settings or skip plugins that need Neovim’s own windows. No extra option needs to be enabled.

In `init.lua` or a required Lua module:

```lua
if vim.g.obsidian then
  -- Neovim was started by the Obsidian plugin.
  vim.keymap.set('i', 'jj', '<Esc>')
else
  -- Settings for other Neovim sessions.
end

-- Shared settings continue to load in every session.
vim.opt.ignorecase = true
vim.opt.smartcase = true
```

In `init.vim`:

```vim
if get(g:, 'obsidian', v:false)
  " Neovim was started by the Obsidian plugin.
  inoremap jj <Esc>
else
  " Settings for other Neovim sessions.
endif
```

For a lazy.nvim plugin that requires Neovim windows, use `cond = not vim.g.obsidian` in its plugin specification ([lazy.nvim condition documentation](https://lazy.folke.io/spec#spec-loading)). Keep your shared configuration outside the conditional so it still loads inside Obsidian. To check the flag in a running session, use `:echo get(g:, 'obsidian', v:false)`.

### Settings managed by the bridge

The plugin uses managed `acwrite` buffers named `obsidian://…`. These note buffers keep `bufhidden=hide`, `swapfile=false`, and `undofile=false`. The bridge enables `hidden`, disables `autowrite`/`autowriteall`, and starts with ShaDa disabled because Obsidian owns note paths and saving. Other user options are left intact. Restarting resets Neovim’s undo history and registers; it preserves text already synchronized to Obsidian.

## Current limits

This is a working foundation, **not full vscode-neovim feature parity**. The automated tests exercise a real Neovim and CodeMirror in a simulated DOM. The Obsidian desktop UI still needs manual testing.

- All ordinary typing, including insert-mode typing, goes through Neovim. Obsidian autocomplete, automatic bracket insertion, and other plugins’ key handlers may behave differently. Conflicting Obsidian shortcuts may need to be unbound.
- Use Obsidian to open, switch, and close notes. Your configured plugins load, but Neovim window/tab layouts, terminal buffers, floating windows, Telescope, completion menus, and `:edit`/`:split`/`:buffer` navigation are not integrated. Some plugins skip managed `acwrite` buffers or require file-read events that these virtual notes do not emit; loading a plugin does not guarantee it can attach to a note.
- Characterwise and linewise visual selections are displayed. Blockwise visual operations run in Neovim, but the rectangular selection is not rendered yet. Mouse selection is synchronized as a cursor position; use `v`/`V` for visual editing.
- `j`/`k` operate on document lines. The Neovim window size is estimated from the editor, so wrapped-line motions, folds, and scrolling do not exactly match Obsidian’s Live Preview layout.
- Native `Ctrl/Cmd-C`, `Ctrl/Cmd-X`, `Ctrl/Cmd-V`, and `Ctrl/Cmd-S` remain available. `Ctrl-C` is reserved for copy; use `Esc` or `Ctrl-[` to leave insert mode. Cmd shortcuts stay with Obsidian. Vim registers are separate from native clipboard operations.
- IME composition is left to CodeMirror and synchronized after composition commits. Japanese IME, dead-key layouts, and pop-out windows need manual verification in Obsidian. The command-line display currently lives in the main window.
- Changes synchronize as one minimal text replacement. Large notes are not optimized yet. If a separate plugin edits a note while Neovim input is still in flight, the newer host revision takes priority; this can discard the pending Neovim edit. Split panes for the same note rely on Obsidian propagating changes between editors.

## Development

```sh
npm run dev        # rebuild main.js when source files change
npm run typecheck  # TypeScript checks
npm test           # unit tests and real Neovim integration tests
npm run check      # production build plus all tests
```

Set `NVIM_BIN=/absolute/path/to/nvim` when running tests if necessary. Tests require Neovim; they do not silently skip it. Reload the plugin in Obsidian after rebuilding.

### Architecture

```text
Obsidian / CodeMirror 6
  ↕ keystrokes, note changes, cursor/selection updates
Editor controller (ordered work queue, revision checks)
  ↕ MessagePack-RPC over stdin/stdout
Local nvim --embed
  ↕ Lua callbacks
Managed note buffers, modes, registers, mappings, undo
```

- `src/editor/`: CodeMirror extension, keyboard translation, Unicode positions, and process coordination.
- `src/neovim/`: process/RPC transport, session API, and the Lua bridge.
- `src/main.ts`: Obsidian lifecycle, settings, status, and save integration.
- CodeMirror and Obsidian are external to the bundle so the plugin uses Obsidian’s own editor classes.

### Manual smoke test

Use a scratch note for the first desktop test:

1. Type `ihello<Esc>`, then try `dw`, `u`, `Ctrl-R`, `ciw`, `.`, and `yy`/`p`.
2. Try `v`, `V`, `/hello`, `:%s/hello/world/g`, and `:w`.
3. Type Japanese text and emoji, move across them, and paste multiline text containing `<Esc>`.
4. Switch notes, open the same note in two panes, and edit through another Obsidian command.
5. Restart/toggle the plugin and try an invalid executable path; the note must remain editable.
6. Enable your normal config and verify its mappings, indentation, and search options. Repeat with a custom config that requires sibling Lua modules.

### API references

- [Obsidian editor extensions](https://docs.obsidian.md/Plugins/Editor/Editor+extensions)
- [Accessing Obsidian’s CodeMirror editor](https://docs.obsidian.md/Plugins/Editor/Communicating+with+editor+extensions)
- [Neovim API and RPC](https://neovim.io/doc/user/api/)
- [Neovim external UI events](https://neovim.io/doc/user/api-ui-events/)
- [Neovim startup and configuration discovery](https://neovim.io/doc/user/starting/)
