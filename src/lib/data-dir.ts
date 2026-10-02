import { resolve } from 'node:path'

/**
 * Everything OpenDots writes locally lives under one directory: the embedded
 * database (`db/`), bot workspaces (`workspaces/`) and the bots' own Claude
 * configuration (`claude/`). One variable moves all of it, which is what a
 * container volume or a backup wants.
 */
export function dataDir(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  // A runtime location, not a build input: without the ignore comment, file
  // tracing treats this cwd-relative path as "the whole project" and copies
  // src/, docs/ and scripts/ into the standalone (Docker) output.
  return resolve(/*turbopackIgnore: true*/ env.OPENDOTS_DATA_DIR || '.opendots')
}
