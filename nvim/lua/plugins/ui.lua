return {
  -- Disable neo-tree auto-open, only show on demand with <leader>e
  {
    "nvim-neo-tree/neo-tree.nvim",
    opts = {
      filesystem = {
        hijack_netrw_behavior = "disabled",
      },
    },
  },

  -- Minimal lualine with Nord Zero colors
  {
    "nvim-lualine/lualine.nvim",
    opts = function(_, opts)
      local c = require("custom.nord-zero").colors
      local nord_zero_theme = {
        normal = {
          a = { fg = c.frost1, bg = c.bg_darker },
          b = { fg = c.fg_dark, bg = c.bg_darker },
          c = { fg = c.comment, bg = c.bg_darker },
        },
        insert = {
          a = { fg = c.green, bg = c.bg_darker },
        },
        visual = {
          a = { fg = c.purple, bg = c.bg_darker },
        },
        replace = {
          a = { fg = c.red, bg = c.bg_darker },
        },
        command = {
          a = { fg = c.yellow, bg = c.bg_darker },
        },
        inactive = {
          a = { fg = c.gray3, bg = c.bg_darker },
          b = { fg = c.gray3, bg = c.bg_darker },
          c = { fg = c.gray3, bg = c.bg_darker },
        },
      }
      opts.options = opts.options or {}
      opts.options.theme = nord_zero_theme
      opts.options.component_separators = { left = "", right = "" }
      opts.options.section_separators = { left = "", right = "" }

      -- Show active formatters/linters
      local function lsp_clients()
        local clients = vim.lsp.get_clients({ bufnr = 0 })
        if #clients == 0 then
          return ""
        end
        local names = {}
        for _, client in ipairs(clients) do
          table.insert(names, client.name)
        end
        return table.concat(names, " ")
      end

      -- Minimal sections
      opts.sections = {
        lualine_a = { "mode" },
        lualine_b = { { "branch", icon = "" } },
        lualine_c = { { "filename", path = 1 } }, -- relative path
        lualine_x = { "diagnostics", lsp_clients },
        lualine_y = { "filetype" },
        lualine_z = { "location" },
      }
      opts.inactive_sections = {
        lualine_a = {},
        lualine_b = {},
        lualine_c = { { "filename", path = 1 } },
        lualine_x = { "location" },
        lualine_y = {},
        lualine_z = {},
      }
    end,
  },
}
