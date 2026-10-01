/**
 * Evaluators — named scorers a golden set can reference.
 *
 * Every evaluator here is deterministic. That is a deliberate constraint: an
 * LLM judge cannot fail a regression caused by the very model it shares, and a
 * suite whose verdicts drift is worse than no suite because it erodes trust in
 * the red build. Model-judged scorers belong alongside these, not instead.
 */

export interface EvaluationInput {
  /** The bot slug that planned the turn. */
  route: string
  /** Titles of the passages retrieved, in rank order. */
  retrievedTitles: string[]
  /** Sources of the passages retrieved, in rank order. */
  retrievedSources: string[]
  /** The answer text, or the planner's dry-run text when the brain is in dry-run. */
  answer: string
  /** Trace details emitted by the planner. */
  trace: string[]
  /** Guardrail decision for the input, when the case exercised one. */
  guardrailAction?: 'allow' | 'redact' | 'block'
  guardrailPolicies?: string[]
}

export interface EvaluationOutcome {
  passed: boolean
  detail: string
}

export type Evaluator = (input: EvaluationInput) => EvaluationOutcome

const pass = (detail: string): EvaluationOutcome => ({ passed: true, detail })
const fail = (detail: string): EvaluationOutcome => ({ passed: false, detail })

export const evaluators = {
  /** A passage from this source must appear in the retrieved set. */
  retrievesSource(fragment: string): Evaluator {
    return (input) => {
      const hit = input.retrievedSources.find((source) => source.includes(fragment))
      return hit
        ? pass(`retrieved ${hit}`)
        : fail(`no retrieved source matched "${fragment}" (got ${input.retrievedSources.join(', ') || 'nothing'})`)
    }
  },

  /** Retrieval must return nothing — used to prove scoping and tool denial. */
  retrievesNothing(): Evaluator {
    return (input) =>
      input.retrievedTitles.length === 0
        ? pass('retrieved nothing, as expected')
        : fail(`expected no retrieval, got ${input.retrievedTitles.join(', ')}`)
  },

  /** A source must NOT appear — proves a skill stayed scoped to its own conversation. */
  doesNotRetrieveSource(fragment: string): Evaluator {
    return (input) => {
      const leaked = input.retrievedSources.find((source) => source.includes(fragment))
      return leaked
        ? fail(`"${fragment}" leaked into retrieval as ${leaked}`)
        : pass(`"${fragment}" correctly absent`)
    }
  },

  /** Every fragment must appear in the answer text. */
  answerContains(...fragments: string[]): Evaluator {
    return (input) => {
      const missing = fragments.filter((fragment) => !input.answer.includes(fragment))
      return missing.length === 0
        ? pass(`answer contained ${fragments.length} fragment(s)`)
        : fail(`answer missing: ${missing.join(', ')}`)
    }
  },

  /** A trace line must match — how configuration effects are asserted. */
  traceIncludes(fragment: string): Evaluator {
    return (input) => {
      const hit = input.trace.find((entry) => entry.includes(fragment))
      return hit
        ? pass(`trace: ${hit}`)
        : fail(`no trace entry matched "${fragment}" (got ${input.trace.join(' | ') || 'nothing'})`)
    }
  },

  /** The input guardrail must have taken this action. */
  guardrailAction(expected: 'allow' | 'redact' | 'block'): Evaluator {
    return (input) =>
      input.guardrailAction === expected
        ? pass(`guardrail ${expected}`)
        : fail(`expected guardrail ${expected}, got ${input.guardrailAction ?? 'none'}`)
  },

  /** A named policy must have fired. */
  guardrailPolicy(policy: string): Evaluator {
    return (input) =>
      (input.guardrailPolicies ?? []).some((entry) => entry.includes(policy))
        ? pass(`policy ${policy} fired`)
        : fail(`policy ${policy} did not fire (got ${(input.guardrailPolicies ?? []).join(', ') || 'none'})`)
  },
} as const
