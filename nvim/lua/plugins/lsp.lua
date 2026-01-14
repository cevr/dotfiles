-- Check if package.json has tsgo in dependencies
local function has_tsgo()
  local cwd = vim.fn.getcwd()
  local package_json = cwd .. "/package.json"
  if vim.fn.filereadable(package_json) == 1 then
    local content = vim.fn.readfile(package_json)
    local json = table.concat(content, "\n")
    if json:match('"@typescript/native%-preview"') then
      return true
    end
  end
  return false
end

return {
  -- TypeScript - prefer tsgo if in package.json, else ts_ls
  {
    "neovim/nvim-lspconfig",
    opts = function(_, opts)
      opts.servers = opts.servers or {}

      -- ESLint - monorepo support
      opts.servers.eslint = {
        settings = {
          workingDirectories = { mode = "auto" },
        },
      }

      -- TypeScript - dynamic selection
      if has_tsgo() then
        opts.servers.tsgo = {}
        -- Disable ts_ls completely
        opts.servers.ts_ls = false
      else
        opts.servers.ts_ls = {}
        opts.servers.tsgo = false
      end

      return opts
    end,
  },

  -- Prettier - use local config from nearest package.json
  {
    "stevearc/conform.nvim",
    opts = {
      formatters = {
        prettier = {
          require_cwd = true, -- Only run if config found
        },
      },
    },
  },
}
