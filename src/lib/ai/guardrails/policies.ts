/**
 * Guardrails — policies that check inputs and outputs.
 *
 * Deliberately deterministic: a regex that finds an AWS key cannot itself be
 * talked out of finding it, whereas an LLM-judged guardrail inherits every
 * weakness of the thing it is guarding. Model-judged policies belong on top of
 * this layer, not instead of it.
 */

import { DEFAULT_GUARDRAILS, type GuardrailConfig } from '../../domain/assistant'

export type { GuardrailConfig }

export type GuardrailAction = 'allow' | 'redact' | 'block'
export type GuardrailSeverity = 'info' | 'warn' | 'critical'
export type GuardrailStage = 'input' | 'output'

export interface GuardrailFinding {
  policy: string
  severity: GuardrailSeverity
  message: string
}

export interface GuardrailResult {
  action: GuardrailAction
  /** Text after redaction; identical to the input when nothing was redacted. */
  text: string
  findings: GuardrailFinding[]
}

const REDACTED = '[redacted]'

interface SecretPattern {
  policy: string
  pattern: RegExp
  message: string
}

/*
 * Ordered most-specific first so a provider-shaped key is reported by name
 * rather than by the generic high-entropy rule.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  {
    policy: 'secret.aws_access_key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    message: 'Looks like an AWS access key id',
  },
  {
    policy: 'secret.openai_key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    message: 'Looks like an OpenAI-style API key',
  },
  {
    policy: 'secret.github_token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    message: 'Looks like a GitHub token',
  },
  {
    policy: 'secret.bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
    message: 'Looks like a bearer token',
  },
  {
    policy: 'secret.private_key',
    pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----/g,
    message: 'Looks like a private key block',
  },
  {
    policy: 'secret.connection_string',
    // Any URL carrying inline credentials, e.g. postgres://user:pass@host
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
    message: 'Looks like a connection string with an inline password',
  },
]

const INJECTION_PATTERNS: { policy: string; pattern: RegExp; message: string }[] = [
  {
    policy: 'injection.override_instructions',
    pattern: /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|earlier|above|all)\b[^.]{0,20}\b(instruction|prompt|rule|direction)/i,
    message: 'Attempts to override prior instructions',
  },
  {
    policy: 'injection.reveal_prompt',
    pattern: /\b(reveal|show|print|repeat|output)\b[^.]{0,30}\b(system prompt|system message|instructions)\b/i,
    message: 'Attempts to extract the system prompt',
  },
  {
    policy: 'injection.role_override',
    pattern: /\byou are now\b|\bact as (?:if you are )?(?:a )?(?:developer|admin|root|dan)\b/i,
    message: 'Attempts to reassign the assistant role',
  },
]

function findSecrets(text: string): { redacted: string; findings: GuardrailFinding[] } {
  let redacted = text
  const findings: GuardrailFinding[] = []

  for (const { policy, pattern, message } of SECRET_PATTERNS) {
    // Fresh lastIndex each pass; these are module-level /g regexes.
    pattern.lastIndex = 0
    if (!pattern.test(redacted)) continue

    pattern.lastIndex = 0
    redacted = redacted.replace(pattern, REDACTED)
    findings.push({ policy, severity: 'critical', message })
  }

  return { redacted, findings }
}

/** Runs the policies that apply to a user's message before it reaches an agent. */
export function checkInput(
  text: string,
  config: GuardrailConfig = DEFAULT_GUARDRAILS,
): GuardrailResult {
  if (!config.enabled) return { action: 'allow', text, findings: [] }

  const findings: GuardrailFinding[] = []

  if (text.length > config.maxInputChars) {
    return {
      action: 'block',
      text,
      findings: [
        {
          policy: 'input.max_length',
          severity: 'warn',
          message: `Message exceeds ${config.maxInputChars} characters`,
        },
      ],
    }
  }

  let output = text

  if (config.blockSecrets) {
    const { redacted, findings: secretFindings } = findSecrets(text)
    if (secretFindings.length > 0) {
      /*
       * Block rather than redact on input. A redacted secret has still been
       * typed, stored, and is about to be sent to a third-party API — refusing
       * it outright is the only response that actually prevents the leak.
       */
      return { action: 'block', text: redacted, findings: secretFindings }
    }
    output = redacted
  }

  if (config.flagInjection) {
    for (const { policy, pattern, message } of INJECTION_PATTERNS) {
      if (pattern.test(text)) findings.push({ policy, severity: 'warn', message })
    }
  }

  return { action: 'allow', text: output, findings }
}

/** Runs the policies that apply to a generated answer before it is persisted. */
export function checkOutput(
  text: string,
  config: GuardrailConfig = DEFAULT_GUARDRAILS,
): GuardrailResult {
  if (!config.enabled) return { action: 'allow', text, findings: [] }

  if (config.blockSecrets) {
    const { redacted, findings } = findSecrets(text)
    if (findings.length > 0) {
      // Redact rather than block: the user asked a legitimate question and
      // suppressing the whole answer hides that a leak was caught at all.
      return { action: 'redact', text: redacted, findings }
    }
  }

  return { action: 'allow', text, findings: [] }
}
