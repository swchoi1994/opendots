import { resolve } from 'node:path'

/**
 * Everything OpenDots writes locally lives under one directory: the embedded
 * database (`db/`), bot workspaces (`workspaces/`) and the bots' own Claude
 * configuration (`claude/`). One variable moves all of it, which is what a
 * container volume or a backup wants.
 */
export function dataDir(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  return resolve(env.OPENDOTS_DATA_DIR || '.opendots')
}
