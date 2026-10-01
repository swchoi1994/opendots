import type { ToolName } from '../../domain/assistant'

/**
 * Maps a bot's tool grants onto Agent SDK tool names.
 *
 * `builtins` become the SDK's `tools` list (what exists for the run) and,
 * together with `mcp`, the `allowedTools` list (what is auto-approved).
 * Anything outside `all` is denied by `canUseTool`, so a grant here is the
 * single place a capability is switched on.
 */
export interface ToolGrants {
  builtins: string[]
  mcp: string[]
  all: string[]
}

export const OPENDOTS_SERVER_NAME = 'opendots'
const mcpName = (tool: string) => `mcp__${OPENDOTS_SERVER_NAME}__${tool}`

const GRANTS: Record<ToolName, { builtins: string[]; mcp: string[] }> = {
  rag_search: { builtins: [], mcp: [mcpName('search_knowledge')] },
  channel_history: { builtins: [], mcp: [] }, // transcript is injected into the prompt
  files: { builtins: ['Read', 'Write', 'Edit', 'Glob', 'Grep'], mcp: [] },
  shell: { builtins: ['Bash'], mcp: [] },
  skills: { builtins: [], mcp: [mcpName('find_skill'), mcpName('install_skill')] },
  web_browser: {
    builtins: [],
    mcp: [
      'browser_open', 'browser_snapshot', 'browser_click', 'browser_type',
      'browser_fill', 'browser_press', 'browser_scroll', 'browser_back',
    ].map(mcpName),
  },
}

export function toolGrants(tools: ToolName[]): ToolGrants {
  const builtins: string[] = []
  const mcp: string[] = []
  for (const tool of new Set(tools)) {
    for (const name of GRANTS[tool].builtins) if (!builtins.includes(name)) builtins.push(name)
    for (const name of GRANTS[tool].mcp) if (!mcp.includes(name)) mcp.push(name)
  }
  return { builtins, mcp, all: [...builtins, ...mcp] }
}
