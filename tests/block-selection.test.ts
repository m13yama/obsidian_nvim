import { recordSession } from "./session-recorder";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NeovimSession, type BlockSelectionRow, type NeovimState } from "../src/neovim/session";

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const legacy of [false, true]) test(`real Neovim block ranges match editing (${legacy ? "legacy column helpers" : "native region API"})`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "obsidian-block-selection-"));
  const initPath = join(directory, "init.lua");
  await writeFile(initPath, legacy ? `
local exists = vim.fn.exists
vim.fn.exists = function(name)
  if name == '*getregionpos' then return 0 end
  return exists(name)
end
` : "");
  let state: NeovimState | undefined;
  let text = "";
  let signaled = false;
  const errors: Error[] = [];
  const session = new NeovimSession({ executable: process.env.NVIM_BIN ?? "nvim", useConfig: true, initPath }, {
    ...recordSession((value, valueText) => { state = value; text = valueText; }),
    message: (value) => { if (value.includes("selection-ready")) signaled = true; },
    commandLine: () => {}, write: () => {}, exit: (error) => errors.push(error),
  });
  t.after(async () => { session.dispose(); await rm(directory, { recursive: true, force: true }); });
  await session.start();
  let id = 0;
  const select = async (doc: string, keys: string, options = "") => {
    await session.input("<Esc>");
    await session.activate({ id: ++id, revision: 0, text: doc, cursor: [1, 0], name: "block.md" });
    signaled = false;
    await session.input(":set selection=inclusive virtualedit=<CR>:setlocal tabstop=8 vartabstop=<CR>" +
      ":vnoremap <F12> <Cmd>echo 'selection-ready'<CR><CR>" + (options ? `:set ${options}<CR>` : "") + keys + "<F12>");
    await waitFor(() => signaled, "selection key sequence finished");
    await session.snapshot();
    assert.ok(state?.mode === "\x16" || state?.mode === "\x13");
    assert.equal(text, doc, "selection never changes document text");
    return state!.blockSelection!;
  };
  const yank = async (expected: string) => {
    await session.input('"by');
    await waitFor(() => state?.mode === "n", "yank leaves Visual mode");
    assert.equal(state?.blockSelection, undefined, "Normal snapshots clear the rectangle");
    await session.activate({ id: ++id, revision: 0, text: "", cursor: [1, 0], name: "register.md" });
    await session.input('"bP');
    await waitFor(() => text === expected, "Neovim yanks exactly the highlighted columns");
  };
  const limits = (rows: BlockSelectionRow[]) => rows.map(({ line, from, to }) => [line, from.byte, from.offset, to.byte, to.offset]);

  let rows = await select("abcde\nABCDE", "gg0l<C-v>jl");
  const forward = structuredClone(rows);
  assert.deepEqual(limits(rows), legacy ? [[1, 1, 0, 3, 0], [2, 1, 0, 3, 0]] : [[1, 1, 0, 2, 1], [2, 1, 0, 2, 1]]);
  await yank("bc\nBC");
  rows = await select("abcde\nABCDE", "G02l<C-v>kh");
  assert.deepEqual(rows, forward, "reversed selection covers the same columns");

  rows = await select("a日😀e\u0301z\na日😀e\u0301z", "gg0l<C-v>j2l");
  assert.equal(rows[0]!.from.byte, 1);
  assert.equal(rows[0]!.from.width, 2);
  await yank("日😀e\u0301\n日😀e\u0301");

  rows = await select("abcdef\n\tZ\n日本語\nabcdef", "gg0l<C-v>3jl");
  assert.deepEqual(rows[1], { line: 2, from: { byte: 0, offset: 1, width: 8 }, to: { byte: 0, offset: 3, width: 8 } });
  assert.deepEqual(rows[2], { line: 3, from: { byte: 0, offset: 1, width: 2 }, to: { byte: 3, offset: 1, width: 2 } });
  await yank("bc\n  \n  \nbc");

  rows = await select("abcdef\n\nx", "gg03l<C-v>2j2l", "virtualedit=block");
  assert.deepEqual(rows[1], { line: 2, from: { byte: 0, offset: 3, width: 0 }, to: { byte: 0, offset: 6, width: 0 } });
  assert.deepEqual(rows[2], { line: 3, from: { byte: 1, offset: 2, width: 0 }, to: { byte: 1, offset: 5, width: 0 } });
  await yank("def\n   \n   ");

  rows = await select("\tfoo\n\tbar", "gg0<C-v>jl", "virtualedit=block");
  assert.deepEqual(rows[0]!.from, { byte: 0, offset: 7, width: 8 }, "block mode starts at the normal cursor's tab cell");
  await yank(" f\n b");
  rows = await select("\tfoo\n\tbar", "gg0<C-v>jl", "virtualedit=all");
  assert.deepEqual(rows[0], { line: 1, from: { byte: 0, offset: 0, width: 8 }, to: { byte: 0, offset: 2, width: 8 } });
  await yank("  \n  ");
  await select("日本語\n日本語", "gg0<C-v>j", "virtualedit=all");
  await yank("日\n日");

  await select("abcde\nABCDE", "gg0<C-v>j2l", "selection=exclusive");
  await yank("ab\nAB");
  rows = await select("abcdefghi\nabc\nabcdefgh", "gg0l<C-v>2j$");
  assert.equal(rows.length, 3);
  await yank("bcdefghi\nbc\nbcdefgh");

  rows = await select("abc\nABC", "gg0<C-v>jl<C-g>");
  assert.equal(state!.mode, "\x13", "Select-block mode keeps its region");
  assert.equal(rows.length, 2);
  assert.deepEqual(errors, []);
});
