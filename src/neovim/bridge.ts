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
    view = M.view or entry.id,
    revision = M.revision or 0,
    tick = api.nvim_buf_get_changedtick(buf),
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

local function changed(buf, changes, origin, initial)
  local entry = M.buffers[buf]
  if not entry then return end
  vim.rpcnotify(channel, 'obsidian:changes', {
    id = entry.id, tick = api.nvim_buf_get_changedtick(buf),
    changes = changes, origin = origin, initial = initial,
  })
  M.schedule()
end

function M.open(id, lines, name)
  local existing = M.ids[id]
  if existing and api.nvim_buf_is_valid(existing) then return end
  local buf = api.nvim_create_buf(false, true)
  M.ids[id] = buf
  local entry = { id = id }
  M.buffers[buf] = entry
  api.nvim_buf_set_name(buf, 'obsidian://' .. id .. '/' .. name)
  vim.bo[buf].buftype = 'acwrite'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].undofile = false
  local undo = vim.bo[buf].undolevels
  vim.bo[buf].undolevels = -1
  api.nvim_buf_set_lines(buf, 0, -1, true, lines)
  vim.bo[buf].undolevels = undo
  changed(buf, { { first = 0, last = 1, lines = lines } }, nil, true)
  api.nvim_buf_attach(buf, false, {
    on_lines = function(_, _, _, first, last, new_last)
      local edit = { first = first, last = last, lines = api.nvim_buf_get_lines(buf, first, new_last, true) }
      if entry.collecting then table.insert(entry.collecting, edit)
      else changed(buf, { edit }) end
    end,
    on_changedtick = function()
      if not entry.collecting then changed(buf, {}) end
    end,
  })
  api.nvim_create_autocmd('BufWriteCmd', {
    group = group, buffer = buf,
    callback = function()
      M.emit()
      vim.rpcnotify(channel, 'obsidian:write', id)
      vim.bo[buf].modified = false
    end,
  })
  -- FileType hooks run in this note's context, including when initializing a
  -- background view. They may edit the buffer; its listener is already attached.
  api.nvim_buf_call(buf, function() vim.bo[buf].filetype = 'markdown' end)
  vim.bo[buf].buftype = 'acwrite'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].undofile = false
end

function M.activate(id, cursor, revision, view, tick)
  local buf = M.ids[id]
  if type(tick) == 'number' and api.nvim_buf_get_changedtick(buf) ~= tick then return false end
  M.view = view
  M.revision = revision
  api.nvim_set_current_buf(buf)
  set_cursor(cursor)
  M.schedule()
  return true
end

function M.change(id, tick, token, edits)
  local buf = M.ids[id]
  if not buf or not api.nvim_buf_is_valid(buf) then error('Missing Obsidian buffer') end
  -- A pending Neovim key or an asynchronous plugin may have edited the buffer
  -- since the host prepared these coordinates. Retry after rebasing its changes.
  if api.nvim_buf_get_changedtick(buf) ~= tick then return false end
  local entry = M.buffers[buf]
  entry.collecting = {}
  local ok, err = pcall(function()
    for i, edit in ipairs(edits) do
      if i > 1 then api.nvim_buf_call(buf, function() vim.cmd('undojoin') end) end
      api.nvim_buf_set_text(buf, edit.start[1], edit.start[2], edit['end'][1], edit['end'][2], edit.lines)
    end
  end)
  local changes = entry.collecting
  entry.collecting = nil
  changed(buf, changes, token)
  if not ok then error(err) end
  return true
end

function M.cursor(id, cursor, revision, view, tick)
  if api.nvim_get_current_buf() ~= M.ids[id] or M.view ~= view then return true end
  if type(tick) == 'number' and api.nvim_buf_get_changedtick(M.ids[id]) ~= tick then return false end
  M.revision = revision
  set_cursor(cursor)
  M.schedule()
  return true
end

function M.rename(id, name)
  local buf = M.ids[id]
  if buf and api.nvim_buf_is_valid(buf) then api.nvim_buf_set_name(buf, 'obsidian://' .. id .. '/' .. name) end
end

function M.release(id)
  local buf = M.ids[id]
  if not buf then return end
  M.buffers[buf] = nil
  M.ids[id] = nil
  if api.nvim_buf_is_valid(buf) then api.nvim_buf_delete(buf, { force = true }) end
end

function M.snapshot()
  M.emit()
end
`;
