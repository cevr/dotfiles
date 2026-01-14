return {
  -- Disable the default LazyVim colorscheme
  { "folke/tokyonight.nvim", enabled = false },
  { "catppuccin/nvim", enabled = false },

  -- Set colorscheme to Nord Zero on startup
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = function()
        require("custom.nord-zero").setup()
      end,
    },
  },
}
