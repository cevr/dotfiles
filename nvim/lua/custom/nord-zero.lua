-- Nord Zero colorscheme for Neovim
-- Ported from the VS Code Nord Zero theme

local M = {}

-- Nord Zero color palette
M.colors = {
  -- Backgrounds (darkest to lightest)
  bg_darkest = "#0a0b0f",    -- activityBar
  bg_darker = "#0d0e12",     -- statusBar, titleBar
  bg_dark = "#11141c",       -- panel, terminal
  bg_sidebar = "#111318",    -- sideBar
  bg = "#151820",            -- editor
  bg_highlight = "#1a1d23",  -- editorWidget, dropdown
  bg_visual = "#1a1e26",     -- tab inactive
  bg_float = "#242932",      -- hover widget

  -- Polar Night (grays)
  gray0 = "#2e3440",
  gray1 = "#3b4252",
  gray2 = "#434c5e",
  gray3 = "#4c566a",

  -- Snow Storm (whites)
  fg_dark = "#d8dee9",
  fg = "#d8dee9",
  fg_light = "#e5e9f0",
  fg_bright = "#eceff4",

  -- Frost (blues/cyans)
  frost0 = "#8fbcbb",        -- teal - classes, types, attributes
  frost1 = "#88c0d0",        -- cyan - functions, links
  frost2 = "#81a1c1",        -- blue - keywords, tags
  frost3 = "#5e81ac",        -- dark blue - preprocessor

  -- Aurora (accents)
  red = "#bf616a",           -- errors, deleted
  orange = "#d08770",        -- warnings (secondary)
  yellow = "#ebcb8b",        -- warnings, regex, chars
  green = "#a3be8c",         -- strings, inserted
  purple = "#b48ead",        -- numbers, debug

  -- UI specific
  comment = "#616e88",
  punctuation = "#6b7894",
  line_nr = "#4c566a",
  line_nr_active = "#d8dee9",
  cursor = "#ffffff",
  selection = "#3b4252",
}

function M.setup()
  local c = M.colors

  -- Reset highlighting
  vim.cmd("hi clear")
  if vim.fn.exists("syntax_on") then
    vim.cmd("syntax reset")
  end
  vim.o.termguicolors = true
  vim.g.colors_name = "nord-zero"

  -- Helper function
  local function hi(group, opts)
    vim.api.nvim_set_hl(0, group, opts)
  end

  -- Editor
  hi("Normal", { fg = c.fg, bg = c.bg })
  hi("NormalFloat", { fg = c.fg, bg = c.bg_float })
  hi("FloatBorder", { fg = c.gray1, bg = c.bg_float })
  hi("ColorColumn", { bg = c.bg_highlight })
  hi("Cursor", { fg = c.bg, bg = c.cursor })
  hi("CursorLine", { bg = c.bg_highlight })
  hi("CursorColumn", { bg = c.bg_highlight })
  hi("CursorLineNr", { fg = c.line_nr_active, bold = true })
  hi("LineNr", { fg = c.line_nr })
  hi("SignColumn", { fg = c.gray2, bg = c.bg })
  hi("VertSplit", { fg = c.gray1, bg = c.bg })
  hi("WinSeparator", { fg = c.gray1, bg = c.bg })
  hi("Folded", { fg = c.comment, bg = c.bg_highlight })
  hi("FoldColumn", { fg = c.gray2, bg = c.bg })
  hi("MatchParen", { fg = c.fg_bright, bg = c.gray2 })
  hi("NonText", { fg = c.gray2 })
  hi("SpecialKey", { fg = c.gray2 })
  hi("Whitespace", { fg = c.gray2 })
  hi("EndOfBuffer", { fg = c.bg })

  -- Search
  hi("Search", { fg = c.bg, bg = c.frost1 })
  hi("IncSearch", { fg = c.bg, bg = c.frost0 })
  hi("CurSearch", { fg = c.bg, bg = c.frost0 })
  hi("Substitute", { fg = c.bg, bg = c.red })

  -- Visual
  hi("Visual", { bg = c.selection })
  hi("VisualNOS", { bg = c.selection })

  -- Statusline
  hi("StatusLine", { fg = c.fg, bg = c.bg_darker })
  hi("StatusLineNC", { fg = c.gray3, bg = c.bg_darker })

  -- Tabline
  hi("TabLine", { fg = c.fg_dark, bg = c.bg_visual })
  hi("TabLineFill", { bg = c.bg_visual })
  hi("TabLineSel", { fg = c.fg, bg = c.bg })

  -- Pmenu (completion menu)
  hi("Pmenu", { fg = c.fg, bg = c.bg_highlight })
  hi("PmenuSel", { fg = c.fg, bg = c.gray2 })
  hi("PmenuSbar", { bg = c.bg_highlight })
  hi("PmenuThumb", { bg = c.gray2 })

  -- Messages
  hi("ModeMsg", { fg = c.fg })
  hi("MsgArea", { fg = c.fg })
  hi("MoreMsg", { fg = c.frost1 })
  hi("Question", { fg = c.frost1 })
  hi("ErrorMsg", { fg = c.red })
  hi("WarningMsg", { fg = c.yellow })

  -- Diff
  hi("DiffAdd", { fg = c.green, bg = "#2e3d34" })
  hi("DiffChange", { fg = c.yellow, bg = "#3d3929" })
  hi("DiffDelete", { fg = c.red, bg = "#3d2e2e" })
  hi("DiffText", { fg = c.fg, bg = "#4d4939" })
  hi("diffAdded", { fg = c.green })
  hi("diffRemoved", { fg = c.red })
  hi("diffChanged", { fg = c.yellow })

  -- Spelling
  hi("SpellBad", { sp = c.red, undercurl = true })
  hi("SpellCap", { sp = c.yellow, undercurl = true })
  hi("SpellLocal", { sp = c.frost1, undercurl = true })
  hi("SpellRare", { sp = c.purple, undercurl = true })

  -- Diagnostics
  hi("DiagnosticError", { fg = c.red })
  hi("DiagnosticWarn", { fg = c.yellow })
  hi("DiagnosticInfo", { fg = c.frost1 })
  hi("DiagnosticHint", { fg = c.frost0 })
  hi("DiagnosticVirtualTextError", { fg = c.red, bg = "#2d2226" })
  hi("DiagnosticVirtualTextWarn", { fg = c.yellow, bg = "#2d2b22" })
  hi("DiagnosticVirtualTextInfo", { fg = c.frost1, bg = "#222a2d" })
  hi("DiagnosticVirtualTextHint", { fg = c.frost0, bg = "#222d2b" })
  hi("DiagnosticUnderlineError", { sp = c.red, undercurl = true })
  hi("DiagnosticUnderlineWarn", { sp = c.yellow, undercurl = true })
  hi("DiagnosticUnderlineInfo", { sp = c.frost1, undercurl = true })
  hi("DiagnosticUnderlineHint", { sp = c.frost0, undercurl = true })

  -- Syntax highlighting
  hi("Comment", { fg = c.comment, italic = true })

  hi("Constant", { fg = c.fg })
  hi("String", { fg = c.green })
  hi("Character", { fg = c.yellow })
  hi("Number", { fg = c.purple })
  hi("Boolean", { fg = c.frost2 })
  hi("Float", { fg = c.purple })

  hi("Identifier", { fg = c.fg })
  hi("Function", { fg = c.frost1 })

  hi("Statement", { fg = c.frost2 })
  hi("Conditional", { fg = c.frost2 })
  hi("Repeat", { fg = c.frost2 })
  hi("Label", { fg = c.frost2 })
  hi("Operator", { fg = c.frost2 })
  hi("Keyword", { fg = c.frost2 })
  hi("Exception", { fg = c.frost2 })

  hi("PreProc", { fg = c.frost3 })
  hi("Include", { fg = c.frost2 })
  hi("Define", { fg = c.frost2 })
  hi("Macro", { fg = c.frost2 })
  hi("PreCondit", { fg = c.frost3 })

  hi("Type", { fg = c.frost0 })
  hi("StorageClass", { fg = c.frost2 })
  hi("Structure", { fg = c.frost2 })
  hi("Typedef", { fg = c.frost0 })

  hi("Special", { fg = c.frost1 })
  hi("SpecialChar", { fg = c.yellow })
  hi("Tag", { fg = c.frost2 })
  hi("Delimiter", { fg = c.punctuation })
  hi("SpecialComment", { fg = c.frost1 })
  hi("Debug", { fg = c.purple })

  hi("Underlined", { fg = c.frost1, underline = true })
  hi("Ignore", { fg = c.gray2 })
  hi("Error", { fg = c.red })
  hi("Todo", { fg = c.yellow, bold = true })

  hi("Title", { fg = c.frost0, bold = true })
  hi("Directory", { fg = c.frost1 })

  -- Treesitter
  hi("@comment", { link = "Comment" })
  hi("@error", { fg = c.red })
  hi("@punctuation", { fg = c.punctuation })
  hi("@punctuation.bracket", { fg = c.punctuation })
  hi("@punctuation.delimiter", { fg = c.punctuation })
  hi("@punctuation.special", { fg = c.frost2 })

  hi("@constant", { fg = c.fg })
  hi("@constant.builtin", { fg = c.frost2 })
  hi("@constant.macro", { fg = c.frost2 })
  hi("@string", { fg = c.green })
  hi("@string.escape", { fg = c.yellow })
  hi("@string.regex", { fg = c.yellow })
  hi("@string.special", { fg = c.yellow })
  hi("@character", { fg = c.yellow })
  hi("@number", { fg = c.purple })
  hi("@boolean", { fg = c.frost2 })
  hi("@float", { fg = c.purple })

  hi("@function", { fg = c.frost1 })
  hi("@function.builtin", { fg = c.frost1 })
  hi("@function.macro", { fg = c.frost1 })
  hi("@function.call", { fg = c.frost1 })
  hi("@method", { fg = c.frost1 })
  hi("@method.call", { fg = c.frost1 })
  hi("@parameter", { fg = c.fg })
  hi("@parameter.reference", { fg = c.fg })

  hi("@keyword", { fg = c.frost2 })
  hi("@keyword.function", { fg = c.frost2 })
  hi("@keyword.operator", { fg = c.frost2 })
  hi("@keyword.return", { fg = c.frost2 })
  hi("@conditional", { fg = c.frost2 })
  hi("@repeat", { fg = c.frost2 })
  hi("@label", { fg = c.frost2 })
  hi("@operator", { fg = c.frost2 })
  hi("@exception", { fg = c.frost2 })
  hi("@include", { fg = c.frost2 })

  hi("@type", { fg = c.frost0 })
  hi("@type.builtin", { fg = c.frost0 })
  hi("@type.qualifier", { fg = c.frost2 })
  hi("@type.definition", { fg = c.frost0 })
  hi("@storageclass", { fg = c.frost2 })
  hi("@attribute", { fg = c.frost0 })

  hi("@variable", { fg = c.fg })
  hi("@variable.builtin", { fg = c.frost2 })
  hi("@field", { fg = c.fg })
  hi("@property", { fg = c.fg })

  hi("@namespace", { fg = c.frost0 })
  hi("@symbol", { fg = c.fg })
  hi("@text", { fg = c.fg })
  hi("@text.strong", { bold = true })
  hi("@text.emphasis", { italic = true })
  hi("@text.underline", { underline = true })
  hi("@text.strike", { strikethrough = true })
  hi("@text.title", { fg = c.frost0, bold = true })
  hi("@text.literal", { fg = c.green })
  hi("@text.uri", { fg = c.frost1, underline = true })
  hi("@text.todo", { fg = c.yellow, bold = true })
  hi("@text.note", { fg = c.frost1, bold = true })
  hi("@text.warning", { fg = c.yellow, bold = true })
  hi("@text.danger", { fg = c.red, bold = true })
  hi("@text.diff.add", { fg = c.green })
  hi("@text.diff.delete", { fg = c.red })

  hi("@tag", { fg = c.frost2 })
  hi("@tag.attribute", { fg = c.frost0 })
  hi("@tag.delimiter", { fg = c.punctuation })

  hi("@constructor", { fg = c.frost0 })
  hi("@annotation", { fg = c.frost1 })

  -- LSP Semantic Tokens
  hi("@lsp.type.class", { fg = c.frost0 })
  hi("@lsp.type.decorator", { fg = c.frost1 })
  hi("@lsp.type.enum", { fg = c.frost0 })
  hi("@lsp.type.enumMember", { fg = c.frost0 })
  hi("@lsp.type.function", { fg = c.frost1 })
  hi("@lsp.type.interface", { fg = c.frost0 })
  hi("@lsp.type.macro", { fg = c.frost2 })
  hi("@lsp.type.method", { fg = c.frost1 })
  hi("@lsp.type.namespace", { fg = c.frost0 })
  hi("@lsp.type.parameter", { fg = c.fg })
  hi("@lsp.type.property", { fg = c.fg })
  hi("@lsp.type.struct", { fg = c.frost0 })
  hi("@lsp.type.type", { fg = c.frost0 })
  hi("@lsp.type.typeParameter", { fg = c.frost0 })
  hi("@lsp.type.variable", { fg = c.fg })

  -- Git signs
  hi("GitSignsAdd", { fg = c.green })
  hi("GitSignsChange", { fg = c.frost1 })
  hi("GitSignsDelete", { fg = c.frost3 })

  -- Telescope
  hi("TelescopeBorder", { fg = c.gray1, bg = c.bg_highlight })
  hi("TelescopeNormal", { fg = c.fg, bg = c.bg_highlight })
  hi("TelescopePromptBorder", { fg = c.gray1, bg = c.bg })
  hi("TelescopePromptNormal", { fg = c.fg, bg = c.bg })
  hi("TelescopePromptPrefix", { fg = c.frost1 })
  hi("TelescopeSelection", { bg = c.gray2 })
  hi("TelescopeSelectionCaret", { fg = c.frost1 })
  hi("TelescopeMatching", { fg = c.frost1 })

  -- Neo-tree
  hi("NeoTreeNormal", { fg = c.fg, bg = c.bg_sidebar })
  hi("NeoTreeNormalNC", { fg = c.fg, bg = c.bg_sidebar })
  hi("NeoTreeVertSplit", { fg = c.bg_sidebar, bg = c.bg_sidebar })
  hi("NeoTreeWinSeparator", { fg = c.bg_sidebar, bg = c.bg_sidebar })
  hi("NeoTreeDirectoryIcon", { fg = c.frost2 })
  hi("NeoTreeDirectoryName", { fg = c.frost1 })
  hi("NeoTreeFileName", { fg = c.fg })
  hi("NeoTreeGitAdded", { fg = c.green })
  hi("NeoTreeGitModified", { fg = c.frost1 })
  hi("NeoTreeGitDeleted", { fg = c.frost3 })
  hi("NeoTreeGitUntracked", { fg = c.orange })
  hi("NeoTreeIndentMarker", { fg = c.gray2 })
  hi("NeoTreeRootName", { fg = c.frost0, bold = true })

  -- Which-key
  hi("WhichKey", { fg = c.frost1 })
  hi("WhichKeyGroup", { fg = c.frost2 })
  hi("WhichKeyDesc", { fg = c.fg })
  hi("WhichKeySeparator", { fg = c.comment })
  hi("WhichKeyFloat", { bg = c.bg_highlight })
  hi("WhichKeyBorder", { fg = c.gray1, bg = c.bg_highlight })

  -- Lazy
  hi("LazyButton", { fg = c.fg, bg = c.gray2 })
  hi("LazyButtonActive", { fg = c.bg, bg = c.frost1 })
  hi("LazyH1", { fg = c.bg, bg = c.frost1, bold = true })
  hi("LazyNormal", { fg = c.fg, bg = c.bg_highlight })

  -- Noice
  hi("NoiceCmdlinePopup", { fg = c.fg, bg = c.bg_highlight })
  hi("NoiceCmdlinePopupBorder", { fg = c.gray1, bg = c.bg_highlight })
  hi("NoiceCmdlineIcon", { fg = c.frost1 })

  -- Notify
  hi("NotifyINFOBorder", { fg = c.frost1 })
  hi("NotifyINFOTitle", { fg = c.frost1 })
  hi("NotifyINFOIcon", { fg = c.frost1 })
  hi("NotifyWARNBorder", { fg = c.yellow })
  hi("NotifyWARNTitle", { fg = c.yellow })
  hi("NotifyWARNIcon", { fg = c.yellow })
  hi("NotifyERRORBorder", { fg = c.red })
  hi("NotifyERRORTitle", { fg = c.red })
  hi("NotifyERRORIcon", { fg = c.red })

  -- Indent Blankline
  hi("IndentBlanklineChar", { fg = c.gray2 })
  hi("IndentBlanklineContextChar", { fg = c.comment })
  hi("IblIndent", { fg = c.gray2 })
  hi("IblScope", { fg = c.comment })

  -- Mini
  hi("MiniIndentscopeSymbol", { fg = c.comment })

  -- Dashboard / Alpha
  hi("DashboardHeader", { fg = c.frost1 })
  hi("DashboardFooter", { fg = c.comment })
  hi("DashboardCenter", { fg = c.frost0 })
  hi("DashboardShortCut", { fg = c.frost2 })

  -- Cmp
  hi("CmpItemAbbr", { fg = c.fg })
  hi("CmpItemAbbrMatch", { fg = c.frost1, bold = true })
  hi("CmpItemAbbrMatchFuzzy", { fg = c.frost1 })
  hi("CmpItemAbbrDeprecated", { fg = c.gray3, strikethrough = true })
  hi("CmpItemKind", { fg = c.frost2 })
  hi("CmpItemMenu", { fg = c.comment })

  -- Bufferline
  hi("BufferLineFill", { bg = c.bg_visual })
  hi("BufferLineBackground", { fg = c.gray3, bg = c.bg_visual })
  hi("BufferLineBuffer", { fg = c.gray3, bg = c.bg_visual })
  hi("BufferLineBufferSelected", { fg = c.fg, bg = c.bg, bold = true })
  hi("BufferLineBufferVisible", { fg = c.fg_dark, bg = c.bg_highlight })

  -- Lualine colors are handled separately in the lualine config

  -- Terminal colors
  vim.g.terminal_color_0 = c.gray1
  vim.g.terminal_color_1 = c.red
  vim.g.terminal_color_2 = c.green
  vim.g.terminal_color_3 = c.yellow
  vim.g.terminal_color_4 = c.frost2
  vim.g.terminal_color_5 = c.purple
  vim.g.terminal_color_6 = c.frost1
  vim.g.terminal_color_7 = c.fg_light
  vim.g.terminal_color_8 = c.gray3
  vim.g.terminal_color_9 = c.red
  vim.g.terminal_color_10 = c.green
  vim.g.terminal_color_11 = c.yellow
  vim.g.terminal_color_12 = c.frost2
  vim.g.terminal_color_13 = c.purple
  vim.g.terminal_color_14 = c.frost0
  vim.g.terminal_color_15 = c.fg_bright
end

return M
