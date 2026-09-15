# Changelog

## 0.0.4 — Beta — 2026-09-16

- Scroll Markdown reading view down with `j` and up with `k`, including key repeat. Keep search fields, note titles, editable controls, and dialogs available for normal typing.
- Focus the visible reading view when returning from a sidebar, so `j` / `k` work immediately.
- Center the cursor line in the editor with `zz` in Normal and Visual modes, including counts such as `50zz` and macro playback. Preserve custom global and buffer-local `zz` mappings.
- Prevent unchanged Neovim status notifications from overriding a pending centering request.

Validated with the production build, TypeScript checks, and all seven automated test files using Neovim 0.12.5. New coverage checks reading-view key routing and real Neovim commands reaching CodeMirror's scrolling handler. The new scrolling behavior has not yet been manually verified in desktop Obsidian.

To upgrade, replace `main.js`, `manifest.json`, and `styles.css`, preserve `data.json`, and restart Obsidian.

## 0.0.3 — Beta — 2026-09-15

- Make Normal-mode cursors clearly visible with a steady green block, light/dark colors, a subtle current-line highlight, and a hollow block when unfocused.
- Draw cursor cells on empty lines and after line ends without inserting text; keep emoji and combining characters together.
- Manage editor attributes through CodeMirror so opening notes and focus changes preserve cursor styling. Restore the native caret for typing and IME composition.
- Render blockwise Visual/Select ranges with a purple overlay, including partial tabs, Japanese/Unicode text, wrapped lines, and virtual space. Clear the overlay on mode changes, host edits, and disconnects.
- Route editor keys through Obsidian view scopes before application hotkeys. Ctrl+V enters blockwise Visual mode; Ctrl+A/Ctrl+X perform Vim number operations in Normal mode. Preserve native paste, cut, select-all, and find while typing.
- Keep save, copy, the quick switcher, Ctrl+E editing/reading toggle, Ctrl+Shift shortcuts, Alt shortcuts, and macOS Command shortcuts with Obsidian.
- Add optional Ctrl+W h/j/k/l pane/sidebar navigation and Ctrl+W p to return to the editor, while preserving custom Neovim mappings. Add commands to focus either sidebar or the editor.
- Support h/j/k/l through the file explorer's native tree navigation, with Esc returning to the note; leave renaming, search inputs, and modal shortcuts alone.
- Keep sidebar navigation working after Obsidian's native tree movement releases DOM focus.
- Preserve cursor styling when opening another file replaces the entire CodeMirror state and reuses the editor DOM.
- Use Node timers for process shutdown so restarting or disabling Neovim works inside Obsidian's browser environment.
- Send UI resize notifications without blocking the next key in a pending command, preventing navigation-related timeouts and disconnects.

Validated with the production build, all seven automated test files using Neovim 0.12.5, and an isolated Obsidian 1.12.7 vault on Linux. Desktop checks covered 18 navigation/editing workflows plus restart, disable, and re-enable.

To upgrade, replace `main.js`, `manifest.json`, and `styles.css`, preserve `data.json`, and restart Obsidian completely.

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
