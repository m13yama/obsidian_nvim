import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NeovimSession, type NeovimState, type SessionEvents } from "../src/neovim/session";

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("real Neovim: editing, modes, undo, registers, search, Ex, Unicode, paste, and buffers", async (t) => {
  let state: NeovimState | undefined;
  let text = "";
  let commandLine = "";
  let writes = 0;
  const errors: Error[] = [];
  const events: SessionEvents = {
    state: (update) => {
      state = update;
      if (update.lines) text = update.lines.join("\n");
    },
    commandLine: (value) => { commandLine = value; },
    message: () => {},
    write: () => { writes++; },
    exit: (error) => errors.push(error),
  };
  const session = new NeovimSession({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" }, events);
  t.after(() => session.dispose());
  await session.start();
  await session.activate({ id: 1, revision: 0, text: "hello world\nsecond line", cursor: [1, 0], name: "test.md" });
  await waitFor(() => text === "hello world\nsecond line", "initial content");
  assert.equal(state?.lineCount, 2);
  assert.equal(state?.screenColumn, 1);
  await session.input("qq");
  await waitFor(() => state?.recording === "q", "macro recording status without a text change");
  await session.input("q");
  await waitFor(() => state?.recording === "", "macro recording stops without a text change");

  await session.input("dw");
  await waitFor(() => text === "world\nsecond line", "delete word");
  await session.input("u");
  await waitFor(() => text === "hello world\nsecond line", "undo");
  await session.input("<C-r>");
  await waitFor(() => text === "world\nsecond line", "redo");
  await session.input("i日本語😀<Esc>");
  await waitFor(() => text === "日本語😀world\nsecond line" && state?.mode === "n", "insert Unicode");
  assert.deepEqual(state?.cursor, [1, 9]);
  assert.equal(state?.screenColumn, 7, "display column accounts for Japanese character widths");

  await session.input("0vll");
  await waitFor(() => state?.mode === "v" && state.cursor[1] === 6, "visual selection");
  assert.deepEqual(state?.anchor, [1, 0]);
  await session.input('"ay<Esc>G$"ap');
  await waitFor(() => text.endsWith("second line日本語"), "named register");

  await session.input("/world");
  await waitFor(() => commandLine === "/world", "search command line");
  await session.input("<CR>");
  await waitFor(() => state?.cursor[0] === 1 && state.cursor[1] === 13 && state.mode === "n", "search result");
  await session.input(":%s/world/earth/g<CR>");
  await waitFor(() => text.includes("earth"), "Ex substitution");
  await session.input(":w<CR>");
  await waitFor(() => writes === 1, "write routed to host");

  await session.input("Go");
  await waitFor(() => state?.mode === "i", "enter insert");
  await session.paste("paste <Esc> literally\r\n次");
  await waitFor(() => text.endsWith("paste <Esc> literally\n次"), "literal multiline paste");
  await session.input("<Esc>");
  await waitFor(() => state?.mode === "n", "leave insert");
  const firstText = text;

  await session.activate({ id: 2, revision: 4, text: "other", cursor: [1, 0], name: "other.md" });
  await waitFor(() => state?.id === 2 && text === "other", "second buffer");
  await session.input("A!<Esc>");
  await waitFor(() => text === "other!", "edit second buffer");
  await session.activate({ id: 1, revision: 0, text: firstText, cursor: [1, 0], name: "test.md" });
  await waitFor(() => state?.id === 1 && text === firstText, "restore first buffer");
  await session.sync({ id: 1, revision: 5, text: "external\n日本語", cursor: [2, 3], name: "test.md" });
  await waitFor(() => state?.revision === 5 && text === "external\n日本語", "external edit revision");
  assert.deepEqual(state?.cursor, [2, 3]);
  await session.input("i!");
  await waitFor(() => state?.mode === "i" && text === "external\n日!本語", "insert before focus switch");
  await session.activate({ id: 2, revision: 4, text: "other!", cursor: [1, 0], name: "other.md" });
  await waitFor(() => state?.id === 2 && state.mode === "n" && text === "other!", "focus switch leaves insert mode");
  await session.input("d");
  await waitFor(() => state?.mode.startsWith("no") === true, "operator pending");
  await session.activate({ id: 1, revision: 5, text: "external\n日!本語", cursor: [1, 0], name: "test.md" });
  await waitFor(() => state?.id === 1 && state.mode === "n", "focus switch cancels pending operator");
  await session.release(2);
  assert.deepEqual(errors, []);
});

test("missing executable fails with a useful error", async () => {
  const session = new NeovimSession({ executable: "/does-not-exist/nvim", useConfig: false, initPath: "" }, {
    state: () => {}, commandLine: () => {}, message: () => {}, write: () => {}, exit: () => {},
  });
  await assert.rejects(session.start(), /ENOENT/);
  session.dispose();
});

test("process shutdown works when the renderer exposes numeric timer handles", async (t) => {
  const session = new NeovimSession({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: false, initPath: "" }, {
    state: () => {}, commandLine: () => {}, message: () => {}, write: () => {}, exit: () => {},
  });
  t.after(() => session.dispose());
  await session.start();
  // Electron's window.setTimeout returns a number, without Node's unref().
  const timer = t.mock.method(globalThis, "setTimeout", (() => 1) as unknown as typeof setTimeout);
  try { assert.doesNotThrow(() => session.dispose()); }
  finally { timer.mock.restore(); }
});

test("custom init sees the host flag and real Neovim executes mappings and dot repeat", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "obsidian-neovim-config-"));
  const initPath = join(directory, "init.lua");
  await writeFile(initPath, `
if not vim.g.obsidian then error('host flag missing') end
vim.keymap.set('n', '<Space>x', 'ciwconfigured<Esc>')
vim.keymap.set('i', 'jj', '<Esc>')
`);
  let state: NeovimState | undefined;
  let text = "";
  const session = new NeovimSession({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: true, initPath }, {
    state: (value) => { state = value; if (value.lines) text = value.lines.join("\n"); },
    commandLine: () => {}, message: () => {}, write: () => {}, exit: () => {},
  });
  t.after(async () => { session.dispose(); await rm(directory, { recursive: true, force: true }); });
  await session.start();
  await session.activate({ id: 1, revision: 0, text: "first second", cursor: [1, 0], name: "mapping.md" });
  await session.input("<Space>x");
  await waitFor(() => text === "configured second" && state?.mode === "n", "normal mapping");
  await session.input("w.");
  await waitFor(() => text === "configured configured", "dot repeat");
  await session.input("A!jj");
  await waitFor(() => text === "configured configured!" && state?.mode === "n", "insert mapping");
});

test("pane mappings notify Obsidian while preserving user mappings and supporting opt-out", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "obsidian-neovim-navigation-"));
  const initPath = join(directory, "init.lua");
  await writeFile(initPath, "vim.keymap.set('n', '<C-w>h', 'iuser<Esc>')");
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const navigation of [true, false]) {
    let text = "";
    const directions: string[] = [];
    const session = new NeovimSession({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: true, initPath, navigation }, {
      state: (state) => { if (state.lines) text = state.lines.join("\n"); }, navigate: (direction) => directions.push(direction),
      commandLine: () => {}, message: () => {}, write: () => {}, exit: () => {},
    });
    try {
      await session.start();
      await session.activate({ id: 1, revision: 0, text: "", cursor: [1, 0], name: "navigation.md" });
      await session.input("<C-w>h");
      await waitFor(() => text === "user", "custom window mapping takes priority");
      assert.deepEqual(directions, []);
      await session.input("<C-w>l");
      if (navigation) {
        await waitFor(() => directions.length === 1, "right pane notification");
        assert.deepEqual(directions, ["right"]);
        await session.input("<C-w>j<C-w>k<C-w>p");
        await waitFor(() => directions.length === 4, "other pane notifications");
        assert.deepEqual(directions, ["right", "down", "up", "editor"]);
      } else {
        await session.input("A!<Esc>");
        await waitFor(() => text === "user!", "input after disabled navigation");
        assert.deepEqual(directions, []);
      }
    } finally { session.dispose(); }
  }
});
