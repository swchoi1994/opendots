import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ChatRepository } from '../../repository/chat-repository'
import { getRetriever, type RetrievedChunk } from '../rag/retriever'
import { browserTools, type BrowserToolsContext } from './browser-tools'
import { OPENDOTS_SERVER_NAME } from './grants'
import { installSkill, searchSkills } from './skills-sh'

/**
 * App-internal tools exposed to the bot as an in-process MCP server.
 *
 * Runs inside the Next.js process, so tools reach the repository and the
 * retriever directly. Tool names appear to the model as
 * `mcp__opendots__<name>`; grants.ts is the only other place that spells them.
 */
export interface OpenDotsServerContext {
  /** The turn's workspace store: knowledge search sees only its documents. */
  repo: ChatRepository
  /** Uploaded knowledge documents this bot may search. */
  skillIds: string[]
  workspaceDir: string
  /** Lets the caller build provenance from what the bot actually looked at. */
  onRetrieved?: (chunks: RetrievedChunk[]) => void
  onSkillInstalled?: (skill: string) => void
  /** Present only when `web_browser` is granted; wires up the eight browser_* tools. */
  browser?: BrowserToolsContext
}

function text(value: string, isError = false) {
  return { content: [{ type: 'text' as const, text: value }], ...(isError ? { isError: true } : {}) }
}

export function createOpenDotsServer(ctx: OpenDotsServerContext): McpSdkServerConfigWithInstance {
  const searchKnowledge = tool(
    'search_knowledge',
    'Search this bot\'s uploaded knowledge documents and the built-in corpus. Use it before answering questions about policies, runbooks, or anything the operator may have uploaded.',
    { query: z.string().min(1).describe('What to look for, as a natural-language question') },
    async ({ query }) => {
      const retriever = await getRetriever(undefined, ctx.repo)
      const chunks = await retriever.retrieve(query, { skillIds: ctx.skillIds })
      ctx.onRetrieved?.(chunks)
      if (chunks.length === 0) return text('No passages matched. Answer from your own knowledge and say so.')
      return text(chunks.map((c, i) => `[${i + 1}] ${c.title} (${c.source}, score ${c.score.toFixed(2)})\n${c.text}`).join('\n\n'))
    },
    { annotations: { readOnlyHint: true } },
  )

  const findSkill = tool(
    'find_skill',
    'Search skills.sh for an installable skill (a SKILL.md package) that teaches you how to do something you do not know how to do yet, e.g. "browser automation", "pdf extraction".',
    { query: z.string().min(1) },
    async ({ query }) => {
      const results = await searchSkills(query)
      if (results.length === 0) return text(`No skills on skills.sh matched "${query}".`)
      return text(
        results
          .map((r) => `${r.ref}  —  ${r.installs.toLocaleString()} installs  —  ${r.url}`)
          .join('\n') + '\n\nInstall one with install_skill(ref).',
      )
    },
    { annotations: { readOnlyHint: true } },
  )

  const installSkillTool = tool(
    'install_skill',
    'Install a skill from skills.sh into your workspace. Pass the exact ref from find_skill (owner/repo@skill). The skill becomes available on your next turn.',
    { ref: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/, 'owner/repo@skill') },
    async ({ ref }) => {
      try {
        const { skill, path } = await installSkill(ref, ctx.workspaceDir)
        ctx.onSkillInstalled?.(skill)
        return text(`Installed skill "${skill}" at ${path}. It loads automatically on your next turn; tell the user it is installed and finish the current answer without it.`)
      } catch (cause) {
        return text(`Could not install "${ref}": ${cause instanceof Error ? cause.message : String(cause)}`, true)
      }
    },
  )

  return createSdkMcpServer({
    name: OPENDOTS_SERVER_NAME,
    version: '1.0.0',
    tools: [searchKnowledge, findSkill, installSkillTool, ...(ctx.browser ? browserTools(ctx.browser) : [])],
  })
}
