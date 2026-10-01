import type { ToolActivityState } from '@/hooks/useChat'

const LABELS: Record<string, string> = {
  mcp__opendots__search_knowledge: 'Searching knowledge',
  mcp__opendots__find_skill: 'Looking for a skill on skills.sh',
  mcp__opendots__install_skill: 'Installing a skill',
  Read: 'Reading a file',
  Write: 'Writing a file',
  Edit: 'Editing a file',
  Glob: 'Listing files',
  Grep: 'Searching files',
  Bash: 'Running a command',
}

function labelFor(name: string): string {
  return LABELS[name] ?? name.replace(/^mcp__opendots__/, '').replace(/_/g, ' ')
}

/**
 * One quiet line under the in-flight bubble: what the bot is doing right now.
 * Shows the tool by a human label, the argument it was given, and a check or
 * cross once the result is back.
 */
export function ToolActivity({ activity, installedSkills }: { activity: ToolActivityState | null; installedSkills: string[] }) {
  if (!activity && installedSkills.length === 0) return null
  return (
    <div role="status" aria-live="polite" className="mt-1 flex flex-col gap-0.5 pl-1 text-[12px] text-ink-500">
      {activity && (
        <p className="flex items-center gap-1.5">
          {activity.done ? (
            <span aria-hidden="true" className={activity.ok ? 'text-read' : 'text-rose-600'}>{activity.ok ? '✓' : '✕'}</span>
          ) : (
            <span aria-hidden="true" className="inline-block h-2 w-2 animate-pulse rounded-full bg-ink-400" />
          )}
          <span className="truncate">
            {labelFor(activity.name)}
            {activity.summary && <span className="text-ink-400"> · {activity.summary}</span>}
          </span>
        </p>
      )}
      {installedSkills.map((skill) => (
        <p key={skill} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="text-read">✓</span>
          Installed skill <code className="font-mono text-[11px]">{skill}</code>
        </p>
      ))}
    </div>
  )
}
