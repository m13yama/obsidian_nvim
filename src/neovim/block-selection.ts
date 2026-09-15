/** Returns byte positions plus cell offsets, including partially selected tabs. */
export const BLOCK_SELECTION_LUA = String.raw`
local function character_at(text, byte)
  if byte >= #text then return #text, 0 end
  local index = vim.fn.charidx(text, math.max(0, byte))
  local first = vim.fn.byteidx(text, index)
  local last = vim.fn.byteidx(text, index + 1)
  if last < 0 then last = #text end
  local before = vim.fn.strdisplaywidth(text:sub(1, first))
  return first, vim.fn.strdisplaywidth(text:sub(first + 1, last), before)
end

local function selection_point(text, column, offset, is_end)
  local byte, width = character_at(text, math.max(0, column - 1))
  return { byte = byte, offset = is_end and offset == 0 and width or offset, width = width }
end

local function display_span(pos)
  local text = vim.fn.getline(pos[2])
  local byte, width = character_at(text, pos[3] - 1)
  local first = vim.fn.strdisplaywidth(text:sub(1, byte)) + pos[4]
  return first, first + math.max(1, width)
end

local function point_at_column(text, row, column)
  local eol = vim.fn.strdisplaywidth(text)
  if column >= eol then return { byte = #text, offset = column - eol, width = 0 } end
  local byte, width = character_at(text, vim.fn.virtcol2col(0, row, column + 1) - 1)
  local first = vim.fn.strdisplaywidth(text:sub(1, byte))
  return { byte = byte, offset = column - first, width = width }
end

local function block_selection(anchor, cursor)
  local result = {}
  local first, last = math.min(anchor[2], cursor[2]), math.max(anchor[2], cursor[2])
  local lines = api.nvim_buf_get_lines(0, first - 1, last, true)
  local to_eol = vim.fn.winsaveview().curswant == vim.v.maxcol
  if vim.fn.exists('*getregionpos') == 1 then
    local positions = vim.fn.getregionpos(anchor, cursor, { type = string.char(22), eol = true })
    for _, pair in ipairs(positions) do
      local a, b = pair[1], pair[2]
      local text = lines[a[2] - first + 1]
      if to_eol then b = { b[1], b[2], #text, 0 } end
      if a[3] > 0 and b[3] > 0 then
        local from = selection_point(text, a[3], a[4], false)
        local finish = selection_point(text, b[3], b[4], true)
        if finish.byte > from.byte or (finish.byte == from.byte and finish.offset > from.offset) then
          result[#result + 1] = { line = a[2], from = from, to = finish }
        end
      end
    end
  else
    -- Neovim 0.9 has no getregionpos(). Use its display-width and column helpers.
    local virtual = vim.o.virtualedit:find('all') or vim.o.virtualedit:find('block')
    local function span(pos)
      local first_cell, end_cell = display_span(pos)
      if virtual and (pos[4] > 0 or vim.fn.getline(pos[2]):sub(pos[3], pos[3]) == '\t') then
        end_cell = first_cell + 1
      end
      return first_cell, end_cell
    end
    local a, a_end = span(anchor)
    local b, b_end = span(cursor)
    local left, right = math.min(a, b), math.max(a_end, b_end)
    if vim.o.selection == 'exclusive' and a ~= b then right = math.max(a, b) end
    for row = first, last do
      local text = lines[row - first + 1]
      local eol = vim.fn.strdisplaywidth(text)
      local finish = to_eol and eol or (virtual and right or math.min(right, eol))
      if finish > left then
        result[#result + 1] = {
          line = row,
          from = point_at_column(text, row, left),
          to = point_at_column(text, row, finish),
        }
      end
    end
  end
  return result
end
`;
