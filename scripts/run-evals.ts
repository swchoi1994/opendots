import { loadEnv } from './load-env'
import { runGoldenSet } from '../src/lib/eval/run'

// `tsx` does not read .env files the way `next dev` does, so load them first —
// otherwise DATA_STORE / RAG_VECTOR_STORE / DATABASE_URL are all invisible and
// the suite silently runs on the memory store.
loadEnv(process.cwd())

// The golden set asserts configuration through the planner's DRY-RUN answer,
// so force dry-run here: the suite never calls a model.
process.env.BRAIN_DRY_RUN = '1'

// And the in-memory store: the golden set uploads skills as fixtures, which
// must never land in the operator's real database.
process.env.DATA_STORE = 'memory'

/**
 * CLI entry point: `pnpm eval`.
 *
 * Exits non-zero on any failure so it can gate a deploy from CI without
 * anyone having to read the output.
 */
async function main() {
  const suite = await runGoldenSet()

  for (const result of suite.results) {
    const mark = result.skipped ? '[33mSKIP[0m' : result.passed ? '[32mPASS[0m' : '[31mFAIL[0m'
    console.log(`${mark}  ${result.id}  —  ${result.description}`)

    if (result.error) {
      console.log(`        error: ${result.error}`)
    }
    // Print assertion detail only where it is informative: all of them for a
    // failing case, none for a passing one.
    for (const assertion of result.assertions) {
      if (result.passed) continue
      const symbol = assertion.passed ? '  ok ' : '  ->'
      console.log(`      ${symbol} ${assertion.detail}`)
    }
  }

  // Skips count as passes in the suite total, which read as "16/16 passed" and
  // hid the two cases nothing actually exercised. Report them separately.
  const skipped = suite.results.filter((result) => result.skipped).length
  const summary =
    skipped > 0 ? `${suite.passed - skipped} passed, ${skipped} skipped` : `${suite.passed}/${suite.total} passed`
  console.log(`\n${summary}` + (suite.failed > 0 ? `, ${suite.failed} failed` : ''))

  process.exit(suite.failed > 0 ? 1 : 0)
}

void main()
