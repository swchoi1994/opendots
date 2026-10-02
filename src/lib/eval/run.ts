import { planBotTurn } from '../ai/agents/bot-turn'
import { getAiConfig } from '../ai/config'
import { checkInput } from '../ai/guardrails/policies'
import { GOLDEN_SET, assistantForCase, type GoldenCase } from './golden-set'
import type { EvaluationInput } from './evaluators'
import { getRepository } from '../repository'
import { LOCAL_SCOPE } from '../repository/chat-repository'

/** The eval is single-user and local whatever the auth mode: its documents live in `local`. */
const repo = () => getRepository(LOCAL_SCOPE)

export interface CaseResult {
  id: string
  description: string
  passed: boolean
  skipped?: boolean
  assertions: { passed: boolean; detail: string }[]
  error?: string
}

export interface SuiteResult {
  total: number
  passed: number
  failed: number
  results: CaseResult[]
}

async function runCase(testCase: GoldenCase): Promise<CaseResult> {
  if (testCase.requiresSemanticRetrieval && getAiConfig().rag.vectorStore !== 'pgvector') {
    return {
      id: testCase.id, description: testCase.description, passed: true, skipped: true,
      assertions: [{ passed: true, detail: 'skipped: needs semantic retrieval (Phase 1b, local embeddings)' }],
    }
  }

  const uploadedIds: string[] = []

  try {
    for (const skill of testCase.skills ?? []) {
      const created = await repo().createSkill(skill)
      uploadedIds.push(created.id)
    }

    const assistant = assistantForCase(testCase.assistant, uploadedIds)
    let input: EvaluationInput

    if (testCase.guardrailOnly) {
      const verdict = checkInput(testCase.question, assistant.guardrails)
      input = {
        route: '',
        retrievedTitles: [],
        retrievedSources: [],
        answer: verdict.text,
        trace: [],
        guardrailAction: verdict.action,
        guardrailPolicies: verdict.findings.map((finding) => finding.policy),
      }
    } else {
      const planned = await planBotTurn({
        question: testCase.question,
        channelUrl: null,
        transcript: '',
        memory: testCase.memory ?? [],
        bot: assistant,
        skillIds: assistant.skillIds,
        repo: repo(),
        hasSession: testCase.hasSession ?? false,
      })
      input = {
        route: planned.route,
        retrievedTitles: planned.context.map((chunk) => chunk.title),
        retrievedSources: planned.context.map((chunk) => chunk.source),
        // In dry-run this text deliberately echoes the resolved model, tools,
        // and system message — that is what makes configuration assertable
        // without calling the brain.
        answer: planned.dryRunAnswer,
        trace: planned.trace.map((entry) => entry.detail),
      }
    }

    const assertions = testCase.assertions.map((assertion) => assertion(input))
    return {
      id: testCase.id,
      description: testCase.description,
      passed: assertions.every((outcome) => outcome.passed),
      assertions,
    }
  } catch (cause) {
    return {
      id: testCase.id,
      description: testCase.description,
      passed: false,
      assertions: [],
      error: cause instanceof Error ? cause.message : 'case threw',
    }
  } finally {
    // Tear down uploaded skills so cases cannot contaminate each other's index.
    for (const id of uploadedIds) {
      await repo().deleteSkill(id).catch(() => undefined)
    }
  }
}

export async function runGoldenSet(cases: GoldenCase[] = GOLDEN_SET): Promise<SuiteResult> {
  const results: CaseResult[] = []
  // Sequential on purpose: cases mutate the shared skill index, and running
  // them concurrently would make retrieval-scoping assertions flaky.
  for (const testCase of cases) {
    results.push(await runCase(testCase))
  }

  const passed = results.filter((result) => result.passed).length
  return { total: results.length, passed, failed: results.length - passed, results }
}
