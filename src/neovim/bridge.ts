import { BLOCK_SELECTION_LUA } from "./block-selection";

/** Runs inside Neovim. Note text lives in managed acwrite buffers, never a vault file. */
export const BRIDGE_LUA = String.raw`
local channel = ...
local api = vim.api
local M = { buffers = {}, ids = {}, pending = false }
_G.obsidian_bridge = M
vim.g.obsidian = true
-- Keep note buffers available while switching editors. Obsidian owns saving.
-- Leave editing, clipboard, and display preferences from the user's config intact.
vim.o.hidden = true
vim.o.autowrite = false
vim.o.autowriteall = false

${BLOCK_SELECTION_LUA}

function M.setup_navigation()
  for key, direction in pairs({ j = 'down', k = 'up', l = 'right', p = 'editor' }) do
    local target = direction
    local lhs = '<C-w>' .. key
    -- Preserve custom user mappings; these defaults replace only built-in window motions.
    if vim.fn.maparg(lhs, 'n') == '' then
      vim.keymap.set('n', lhs, function()
        vim.rpcnotify(channel, 'obsidian:navigate', target)
      end, { silent = true, desc = 'Obsidian: focus ' .. target })
    end
  end
end

function M.setup_scrolling()
  for _, mode in ipairs({ 'n', 'x' }) do
    if vim.fn.maparg('zz', mode) == '' then
      vim.keymap.set(mode, 'zz', function()
        local count = vim.v.count > 0 and tostring(vim.v.count) or ''
        vim.cmd('normal! ' .. count .. 'zz')
        -- zz can leave both text and cursor unchanged, so emit explicitly.
        M.emit('center')
      end, { silent = true, desc = 'Obsidian: center cursor line' })
    end
  end
end

function M.emit(scroll)
  M.pending = false
  local buf = api.nvim_get_current_buf()
  local entry = M.buffers[buf]
  if not entry then return end
  local anchor = vim.fn.getpos('v')
  local cursor = vim.fn.getpos('.')
  local mode = api.nvim_get_mode().mode
  local screen_column = display_span(cursor)
  local state = {
    id = entry.id,
    revision = entry.revision,
    cursor = api.nvim_win_get_cursor(0),
    anchor = { anchor[2], math.max(0, anchor[3] - 1) },
    mode = mode,
    lineCount = api.nvim_buf_line_count(buf),
    screenColumn = screen_column + 1,
    recording = vim.fn.reg_recording(),
    scroll = scroll,
  }
  if mode == string.char(22) or mode == string.char(19) then
    state.blockSelection = block_selection(anchor, cursor)
  end
  if entry.dirty then
    state.lines = api.nvim_buf_get_lines(buf, 0, -1, true)
    entry.dirty = false
  end
  vim.rpcnotify(channel, 'obsidian:state', state)
end

function M.schedule()
  if M.pending then return end
  M.pending = true
  vim.schedule(M.emit)
end

local group = api.nvim_create_augroup('ObsidianNeovimBridge', { clear = true })
api.nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI', 'ModeChanged', 'TextChanged', 'TextChangedI', 'RecordingEnter', 'RecordingLeave' }, {
  group = group, callback = M.schedule,
})

local function set_cursor(cursor)
  local row = math.max(1, math.min(cursor[1], api.nvim_buf_line_count(0)))
  local line = api.nvim_buf_get_lines(0, row - 1, row, true)[1] or ''
  api.nvim_win_set_cursor(0, { row, math.max(0, math.min(cursor[2], #line)) })
end

local function replace_lines(buf, lines)
  local old = api.nvim_buf_get_lines(buf, 0, -1, true)
  local first = 1
  while first <= #old and first <= #lines and old[first] == lines[first] do first = first + 1 end
  local old_end, new_end = #old, #lines
  while old_end >= first and new_end >= first and old[old_end] == lines[new_end] do
    old_end = old_end - 1
    new_end = new_end - 1
  end
  if first > old_end and first > new_end then return end
  local replacement = {}
  for i = first, new_end do replacement[#replacement + 1] = lines[i] end
  api.nvim_buf_set_lines(buf, first - 1, old_end, true, replacement)
end

function M.activate(id, lines, cursor, revision, name)
  local buf = M.ids[id]
  local created = false
  if not buf or not api.nvim_buf_is_valid(buf) then
    buf = api.nvim_create_buf(false, true)
    created = true
    M.ids[id] = buf
    M.buffers[buf] = { id = id, revision = revision, dirty = true }
    api.nvim_buf_set_name(buf, 'obsidian://' .. id .. '/' .. name)
    vim.bo[buf].buftype = 'acwrite'
    vim.bo[buf].bufhidden = 'hide'
    vim.bo[buf].swapfile = false
    vim.bo[buf].undofile = false
    local undo = vim.bo[buf].undolevels
    vim.bo[buf].undolevels = -1
    api.nvim_buf_set_lines(buf, 0, -1, true, lines)
    vim.bo[buf].undolevels = undo
    api.nvim_buf_attach(buf, false, {
      on_lines = function()
        if M.buffers[buf] then M.buffers[buf].dirty = true; M.schedule() end
      end,
    })
    api.nvim_create_autocmd('BufWriteCmd', {
      group = group, buffer = buf,
      callback = function()
        M.buffers[buf].dirty = true
        M.emit()
        vim.rpcnotify(channel, 'obsidian:write', id)
        vim.bo[buf].modified = false
      end,
    })
  end
  api.nvim_set_current_buf(buf)
  if created then
    -- FileType and after/ftplugin hooks must run in the displayed note's context.
    vim.bo[buf].filetype = 'markdown'
    -- A filetype plugin may change buffer options; note storage still belongs to Obsidian.
    vim.bo[buf].buftype = 'acwrite'
    vim.bo[buf].bufhidden = 'hide'
    vim.bo[buf].swapfile = false
    vim.bo[buf].undofile = false
  end
  M.sync(id, lines, cursor, revision)
end

function M.sync(id, lines, cursor, revision)
  local buf = M.ids[id]
  if not buf or not api.nvim_buf_is_valid(buf) then return end
  local entry = M.buffers[buf]
  entry.revision = revision
  replace_lines(buf, lines)
  entry.dirty = true
  if api.nvim_get_current_buf() == buf then set_cursor(cursor) end
  M.schedule()
end

function M.cursor(id, cursor)
  if api.nvim_get_current_buf() == M.ids[id] then set_cursor(cursor); M.schedule() end
end

function M.release(id)
  local buf = M.ids[id]
  if not buf then return end
  M.buffers[buf] = nil
  M.ids[id] = nil
  if api.nvim_buf_is_valid(buf) then api.nvim_buf_delete(buf, { force = true }) end
end

function M.snapshot()
  local entry = M.buffers[api.nvim_get_current_buf()]
  if entry then entry.dirty = true end
  M.emit()
end
`;
