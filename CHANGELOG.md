# Changelog

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
