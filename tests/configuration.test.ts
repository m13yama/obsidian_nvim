import { recordSession } from "./session-recorder";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { NeovimSession, type SessionOptions } from "../src/neovim/session";
import { DEFAULT_SETTINGS } from "../src/settings";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "obsidian-neovim-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    NVIM_APPNAME: "nvim", NVIM_LOG_FILE: join(root, "nvim.log"),
    // Do not inherit an init override from the shell running the tests.
    VIMINIT: "", EXINIT: "",
  };
  return { root, env };
}

async function configuration(directory: string, initName: "init.lua" | "init.vim" = "init.lua") {
  const files: Record<string, string> = {
    [initName]: initName === "init.lua" ? "require('fixture.init')" : "lua require('fixture.init')",
    "lua/fixture/init.lua": `
      assert(vim.g.obsidian, 'host flag must precede init')
      vim.g.fixture_has_ui = #vim.api.nvim_list_uis() > 0
      require('fixture.options')
      vim.cmd('filetype plugin indent on')
      vim.api.nvim_create_autocmd('UIEnter', { callback = function() vim.g.fixture_ui_enter = true end })
      vim.api.nvim_create_autocmd('VimEnter', {
        callback = function()
          vim.g.fixture_vim_enter = true
          vim.keymap.set('n', '<F6>', function()
            local result = {
              has_ui = vim.g.fixture_has_ui,
              ui_enter = vim.g.fixture_ui_enter,
              vim_enter = vim.g.fixture_vim_enter,
              module = vim.g.fixture_module,
              plugin = vim.g.fixture_plugin,
              after_plugin = vim.g.fixture_after_plugin,
              package_plugin = vim.g.fixture_package,
              tabstop = vim.bo.tabstop,
              shiftwidth = vim.bo.shiftwidth,
              expandtab = vim.bo.expandtab,
              textwidth = vim.bo.textwidth,
              ignorecase = vim.o.ignorecase,
              smartcase = vim.o.smartcase,
              clipboard = vim.o.clipboard,
              mouse = vim.o.mouse,
              wrap = vim.wo.wrap,
              number = vim.wo.number,
              ruler = vim.o.ruler,
              showmode = vim.o.showmode,
              laststatus = vim.o.laststatus,
              virtualedit = vim.o.virtualedit,
              backup = vim.o.backup,
              writebackup = vim.o.writebackup,
              hidden = vim.o.hidden,
              autowrite = vim.o.autowrite,
              autowriteall = vim.o.autowriteall,
              buftype = vim.bo.buftype,
              swapfile = vim.bo.swapfile,
              undofile = vim.bo.undofile,
            }
            vim.api.nvim_buf_set_lines(0, 0, -1, true, { vim.json.encode(result) })
          end)
        end,
      })
    `,
    "lua/fixture/options.lua": `
      vim.g.fixture_module = true
      vim.opt.tabstop = 6
      vim.opt.shiftwidth = 6
      vim.opt.expandtab = true
      vim.opt.ignorecase = true
      vim.opt.smartcase = true
      vim.opt.clipboard = 'unnamedplus'
      vim.opt.mouse = 'a'
      vim.opt.wrap = true
      vim.opt.number = true
      vim.opt.ruler = true
      vim.opt.showmode = true
      vim.opt.laststatus = 3
      vim.opt.virtualedit = 'onemore'
      vim.opt.backup = true
      vim.opt.writebackup = true
      vim.opt.hidden = false
      vim.opt.autowrite = true
      vim.opt.autowriteall = true
    `,
    "plugin/fixture.lua": "vim.g.fixture_plugin = (vim.g.fixture_plugin or 0) + 1",
    "after/plugin/fixture.lua": "vim.g.fixture_after_plugin = vim.g.fixture_plugin == 1",
    "pack/example/start/fixture/plugin/fixture_package.lua": "vim.g.fixture_package = (vim.g.fixture_package or 0) + 1",
    "after/ftplugin/markdown.lua": `
      vim.bo.tabstop = 6
      vim.bo.shiftwidth = 3
      vim.bo.textwidth = 77
      vim.keymap.set('n', '<F7>', function()
        vim.api.nvim_buf_set_lines(0, 0, -1, true, { 'markdown buffer mapping' })
      end, { buffer = true })
    `,
  };
  for (const [name, text] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  return join(directory, initName);
}

async function start(t: TestContext, options: Partial<SessionOptions>) {
  let text = "";
  const messages: string[] = [];
  const errors: Error[] = [];
  const session = new NeovimSession({
    ...DEFAULT_SETTINGS, executable: process.env.NVIM_BIN ?? "nvim", ...options,
  }, {
    ...recordSession((_state, valueText) => { text = valueText; }),
    commandLine: () => {}, message: (message) => messages.push(message), write: () => {},
    exit: (error) => errors.push(error),
  });
  t.after(() => session.dispose());
  await session.start();
  await session.activate({ id: 1, revision: 0, text: "note", cursor: [1, 0], name: "note.md" });
  const waitFor = async (check: (text: string) => boolean) => {
    const deadline = Date.now() + 3000;
    while (!check(text)) {
      if (Date.now() > deadline) throw new Error(`Missing config result. Text: ${text}. Messages: ${messages.join("; ")}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(errors, []);
    return text;
  };
  return { session, waitFor };
}

const expected = {
  has_ui: true, ui_enter: true, vim_enter: true, module: true, plugin: 1, after_plugin: true, package_plugin: 1,
  tabstop: 6, shiftwidth: 3, expandtab: true, textwidth: 77, ignorecase: true, smartcase: true,
  clipboard: "unnamedplus", mouse: "a", wrap: true, number: true, ruler: true, showmode: true, laststatus: 3,
  virtualedit: "onemore", backup: true, writebackup: true,
  hidden: true, autowrite: false, autowriteall: false, buftype: "acwrite", swapfile: false, undofile: false,
};

for (const kind of ["standard", "standard-explicit", "appname", "custom-lua", "custom-vim"] as const) {
  test(`${kind} config loads modules, plugins, startup hooks, and Markdown settings without resetting user options`, async (t) => {
    const { root, env } = await fixture(t);
    if (kind === "appname") env.NVIM_APPNAME = "obsidian-test-profile";
    const standard = kind === "standard" || kind === "appname";
    const directory = standard || kind === "standard-explicit"
      ? join(env.XDG_CONFIG_HOME, env.NVIM_APPNAME) : join(root, "custom configuration");
    const initPath = await configuration(directory, kind === "custom-vim" ? "init.vim" : "init.lua");
    const { session, waitFor } = await start(t, { env, initPath: standard ? "" : initPath });
    await session.input("<F6>");
    assert.deepEqual(JSON.parse(await waitFor((text) => text.startsWith("{"))), expected);
    await session.input("<F7>");
    await waitFor((text) => text === "markdown buffer mapping");
    await session.activate({ id: 2, revision: 0, text: "another note", cursor: [1, 0], name: "second.md" });
    await session.input("<F6>");
    assert.deepEqual(JSON.parse(await waitFor((text) => text.startsWith("{"))), expected);
    await session.input("<F7>");
    await waitFor((text) => text === "markdown buffer mapping");
  });
}

test("clean mode still bypasses user init and plugin scripts", async (t) => {
  const { root, env } = await fixture(t);
  const directory = join(env.XDG_CONFIG_HOME, "nvim");
  await mkdir(join(directory, "plugin"), { recursive: true });
  const marker = join(root, "should-not-load");
  const source = `vim.fn.writefile({ 'loaded' }, ${JSON.stringify(marker)})\nvim.keymap.set('n', 'i', '<Nop>')`;
  await writeFile(join(directory, "init.lua"), source);
  await writeFile(join(directory, "plugin/unwanted.lua"), source);
  const { session, waitFor } = await start(t, { env, useConfig: false, initPath: join(directory, "init.lua") });
  await session.input("iclean<Esc>");
  await waitFor((text) => text === "cleannote");
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("an invalid custom init reports its path instead of silently ignoring the config", async (t) => {
  const { root, env } = await fixture(t);
  await assert.rejects(start(t, { env, initPath: join(root, "missing.lua") }), /Cannot read Neovim init file: .*missing\.lua/);
  await assert.rejects(start(t, { env, initPath: root }), /Cannot read Neovim init file:/);
});

test("a configuration that exits during startup rejects without leaving a pending handshake", async (t) => {
  const { root, env } = await fixture(t);
  const initPath = join(root, "exit.lua");
  await writeFile(initPath, "vim.cmd('quitall!')");
  await assert.rejects(start(t, { env, initPath }), /Neovim (exited|closed)/);
});
