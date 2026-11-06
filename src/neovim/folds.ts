/** The active Obsidian pane supplies all fold boundaries, including open ones. */
export const FOLDS_LUA = String.raw`
function M.set_folds(ranges)
  M.fold_ranges = nil
  M.fold_buf = nil
  if type(ranges) ~= 'table' then return end
  M.fold_buf = api.nvim_get_current_buf()
  local saved = vim.fn.winsaveview()
  vim.wo.foldmethod = 'manual'
  vim.wo.foldminlines = 0
  vim.wo.foldenable = true
  vim.cmd('silent normal! zE')
  M.fold_ranges = ranges
  -- Create children first. An Ex range inside an already closed parent would
  -- otherwise be expanded by Neovim into a second copy of the parent fold.
  for i = #ranges, 1, -1 do
    local range = ranges[i]
    vim.cmd(('silent %d,%dfold'):format(range.from, range.to))
  end
  vim.cmd('silent normal! zR')
  for i = #ranges, 1, -1 do
    local range = ranges[i]
    if range.closed then vim.cmd(('silent %dfoldclose'):format(range.from)) end
  end
  vim.fn.winrestview(saved)
end

function M.fold_state()
  if not M.fold_ranges or M.fold_buf ~= api.nvim_get_current_buf() then return nil end
  local closed, result, saved = {}, {}, vim.fn.winsaveview()
  -- Inspect hidden children too, preserving their own open/closed state.
  -- Opening and restoring here is synchronous; no intermediate UI is emitted.
  for _, range in ipairs(M.fold_ranges) do
    local is_closed = vim.fn.foldclosed(range.from) == range.from and vim.fn.foldclosedend(range.from) == range.to
    table.insert(result, { from = range.from, to = range.to, closed = is_closed })
    if is_closed then
      table.insert(closed, { range.from, range.to })
      vim.cmd(('silent %dfoldopen'):format(range.from))
    end
  end
  for i = #closed, 1, -1 do vim.cmd(('silent %dfoldclose'):format(closed[i][1])) end
  vim.fn.winrestview(saved)
  return result
end

function M.folds(id, view, revision, tick, ranges)
  if api.nvim_get_current_buf() ~= M.ids[id] or M.view ~= view then return false end
  if api.nvim_buf_get_changedtick(M.ids[id]) ~= tick then return false end
  M.revision = revision
  M.set_folds(ranges)
  M.schedule()
  return true
end

function M.move_fold_ranges(first, last, new_last)
  if not M.fold_ranges then return end
  local delta, ranges = new_last - last, {}
  for _, range in ipairs(M.fold_ranges) do
    if range.from > last then range.from = range.from + delta
    elseif range.from > first then range.from = first + 1 end
    if range.to > last then range.to = range.to + delta
    elseif range.to > first then range.to = new_last end
    if range.to > range.from then table.insert(ranges, range) end
  end
  M.fold_ranges = ranges
end

function M.setup_fold_keys()
  if vim.fn.maparg('<CR>', 'n') == '' then
    vim.keymap.set('n', '<CR>', function()
      local count = vim.v.count > 0 and tostring(vim.v.count) or ''
      if M.fold_ranges and vim.fn.foldlevel('.') > 0 then
        vim.cmd('normal! ' .. count .. 'za')
      else
        vim.cmd('normal! ' .. count .. '\r')
      end
      M.emit()
    end, { buffer = true, silent = true, desc = 'Obsidian: toggle fold' })
  end
end

-- Fold commands can leave text, mode, and cursor unchanged. Also observe keys
-- executed by mappings/macros so za/zR/zM still publish their new fold state.
vim.on_key(function() if M.fold_ranges then M.schedule() end end, api.nvim_create_namespace('obsidian-folds'))
`;
