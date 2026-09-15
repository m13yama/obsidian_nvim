# Changelog

## 0.0.2 — Beta — 2026-09-15

- Add a colored Powerline status line with the note name, cursor position, document progress, and macro recording indicator; include an immediately switchable compact style.
- Distinguish visual/select variants, pending operators, prompts, and connection states in the mode display.
- Load the normal Neovim configuration by default for new installs; preserve existing saved clean-mode preferences.
- Attach the UI before init files and plugins run, and wait for startup hooks before activating notes.
- Preserve user editing, clipboard, and display options in Neovim while retaining the settings required for Obsidian-owned note buffers and saving.
- Load sibling modules, runtime plugins, packages, and `after/` files for custom init paths, with support for `~/` paths and clear errors for invalid init files.
- Run Markdown filetype configuration in the note’s buffer and add integration coverage for standard profiles, custom Lua/Vim configs, and clean mode.
- Document `vim.g.obsidian` / `g:obsidian`, set before startup configuration, for host-specific settings and plugin conditions.

To upgrade, replace `main.js`, `manifest.json`, and `styles.css`, keep your existing `data.json`, and reload Obsidian. Existing clean-mode preferences are preserved: enable **Load Neovim configuration** in the plugin settings and restart Neovim to use your normal config.

## 0.0.1 — Beta — 2026-09-15

Initial beta release of Neovim for Obsidian.

### Features

- Edit Markdown notes using a real local Neovim process connected to Obsidian’s CodeMirror editor.
- Use Neovim modes, mappings, registers, macros, undo/redo, search, and Ex commands.
- Synchronize note text, Unicode cursor positions, and characterwise/linewise visual selections.
- Route `:w` through Obsidian and support literal multiline paste.
- Configure the Neovim executable and an optional custom init file.
- Toggle or restart Neovim, with native editor input restored after connection failures.

### Requirements and validation

- Desktop Obsidian 1.8.7 or newer and local Neovim 0.9 or newer.
- Production build, TypeScript checks, and automated tests pass with Neovim 0.12.5.
- Tests cover real Neovim and CodeMirror in a simulated DOM; desktop Obsidian still needs manual validation.

### Known limitations

- Neovim windows, terminal buffers, floating windows, completion menus, and buffer navigation are not integrated.
- Blockwise visual selections are not rendered, and wrapped-line motions can differ from Obsidian’s layout.
- IME, Live Preview, pop-out windows, and interactions with other plugins need desktop testing.
- Concurrent edits by other plugins can take priority over pending Neovim input. See the README for details before using the beta.
