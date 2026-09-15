# Neovim for Obsidian

An early desktop plugin that uses a **real local Neovim process** to edit notes in Obsidian, inspired by vscode-neovim. Obsidian keeps its Markdown editor and saves the notes. Neovim runs in the background and handles editing commands over MessagePack-RPC.

## Install

Requirements: desktop Obsidian **1.8.7+**, Neovim **0.9+**, and Node.js **22+** for development. Neovim 0.12.5 is tested locally. Mobile is not supported.

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

## What works in this version

- Neovim normal, insert, replace, operator-pending, and keyboard visual editing.
- Motions, text objects, counts, registers, macros, dot repeat, undo (`u`), and redo (`Ctrl-R`) handled by Neovim.
- Neovim `/` and `?` searches and `:` commands, with a small command-line/message display in Obsidian.
- `:w` asks Obsidian to save the current note. Normal Obsidian autosave continues to work.
- Plain-text paste uses `nvim_paste`, so text such as `<Esc>` is inserted literally.
- Unicode conversion between Neovim’s UTF-8 byte columns and CodeMirror’s UTF-16 positions.
- A separate Neovim buffer for each editor, shared registers within the process, and synchronization of changes made through Obsidian.
- Optional Neovim configuration and key mappings.
- **Neovim: Toggle Neovim** and **Neovim: Restart Neovim** commands. Clicking the status bar also restarts Neovim.
- If startup or the process fails, keyboard input returns to Obsidian and note text remains in the editor.

## Neovim configuration

The default is a clean Neovim to make the initial setup predictable. To use your configuration, enable **Load Neovim configuration** and restart. Leave **Custom init file** empty for your normal config, or provide an absolute path to a dedicated `init.lua`/`init.vim`.

`vim.g.obsidian` is set **before** Neovim reads your configuration. For example:

```lua
if vim.g.obsidian then
  vim.g.mapleader = ' '
  vim.keymap.set('i', 'jj', '<Esc>')
  vim.keymap.set('n', '<leader>w', '<Cmd>write<CR>')
  -- Configure editing mappings here; Obsidian owns the visible editor.
  return
end

-- The rest of your terminal Neovim configuration.
```

The plugin uses managed `acwrite` buffers named `obsidian://…`. It disables swap/backup files, automatic Neovim writes, persistent undo, and ShaDa for the embedded process. Obsidian owns note paths and saving. Restarting resets Neovim’s undo history and registers; it preserves text already synchronized to Obsidian.

## Current limits

This is a working foundation, **not full vscode-neovim feature parity**. The automated tests exercise a real Neovim and CodeMirror in a simulated DOM. The Obsidian desktop UI still needs manual testing.

- All ordinary typing, including insert-mode typing, goes through Neovim. Obsidian autocomplete, automatic bracket insertion, and other plugins’ key handlers may behave differently. Conflicting Obsidian shortcuts may need to be unbound.
- Use Obsidian to open, switch, and close notes. Neovim window/tab layouts, terminal buffers, floating windows, Telescope, completion menus, and `:edit`/`:split`/`:buffer` navigation are not integrated. Use a small config focused on editing mappings.
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
Local nvim --embed --headless
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
6. Enable a dedicated config with `jj` mapped to Escape and verify the mapping.

### API references

- [Obsidian editor extensions](https://docs.obsidian.md/Plugins/Editor/Editor+extensions)
- [Accessing Obsidian’s CodeMirror editor](https://docs.obsidian.md/Plugins/Editor/Communicating+with+editor+extensions)
- [Neovim API and RPC](https://neovim.io/doc/user/api/)
- [Neovim external UI events](https://neovim.io/doc/user/api-ui-events/)
