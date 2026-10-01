export interface KnowledgeDocument {
  id: string
  title: string
  source: string
  text: string
}

/**
 * Built-in seed corpus for the in-memory retriever.
 *
 * Sample runbook content so retrieval is demonstrable the moment the app boots,
 * without provisioning a vector database. Real knowledge is expected to arrive
 * as uploaded skills, which are indexed alongside these documents.
 */
export const KNOWLEDGE_BASE: KnowledgeDocument[] = [
  {
    id: 'kb_failing_job',
    title: 'Diagnosing a failing scheduled job',
    source: 'internal/runbook/failing-jobs.md',
    text: 'When a scheduled job fails or will not finish, first confirm whether it failed fast or hung. A job that exits within seconds is usually a configuration or permissions error; one that hangs is usually waiting on a lock, a slow query, or an unavailable upstream. Check the last successful run and what changed between them: a schema migration, a credential rotation, or a dependency bump. A job that produces no stack trace at all is often being killed by the scheduler for exceeding its memory or time limit, so check the scheduler logs and not only the application logs.',
  },
  {
    id: 'kb_schema_change',
    title: 'Schema changes and downstream breakage',
    source: 'internal/runbook/schema-changes.md',
    text: 'A schema change breaks downstream consumers when a column is renamed, dropped, or has its type narrowed. Symptoms include validation errors on load, silently empty result sets, and nightly runs that fail only after the first batch. Always deploy schema changes as expand then contract: add the new column, backfill it, move readers across, and only then remove the old one. If a job started failing right after a migration, compare the migration timestamp with the first failed run before looking anywhere else.',
  },
  {
    id: 'kb_deploy_rollback',
    title: 'Deployments and rollback',
    source: 'internal/runbook/deploy-rollback.md',
    text: 'Roll back first and diagnose afterwards when a deployment causes elevated error rates, latency regressions, or failed health checks. Note the deployment id and the commit range before rolling back, since that range is the entire search space for the cause. A rollback that does not restore health means the cause is not the application code — look at configuration, feature flags, database state, or an upstream dependency that changed at the same time.',
  },
  {
    id: 'kb_incident_escalation',
    title: 'When to escalate an incident',
    source: 'internal/runbook/escalation.md',
    text: 'Escalate immediately for data loss or corruption, a security exposure, customer-facing downtime beyond fifteen minutes, or any incident where the responder does not know the next diagnostic step. Escalate to the owning team rather than broadcasting widely. Include what is broken, what you have already ruled out, the blast radius, and whether a rollback has been attempted. Escalating early is cheaper than escalating late; an incident that resolves itself during escalation is not a wasted page.',
  },
  {
    id: 'kb_stack_trace',
    title: 'Reading a stack trace',
    source: 'internal/runbook/stack-traces.md',
    text: 'Read a stack trace from the innermost frame outward, but start with the exception type and message. Frames inside third party libraries usually indicate misuse at the boundary rather than a bug in the library. A truncated trace, or one with no application frames at all, often means the error crossed an async boundary and lost its context; capture and rethrow with the original cause attached so the chain survives. Timeout exceptions rarely name the real culprit — look at what the call was waiting on.',
  },
  {
    id: 'kb_flaky_pipeline',
    title: 'Flaky builds and pipelines',
    source: 'internal/runbook/flaky-pipelines.md',
    text: 'A build that fails intermittently is usually order dependent, time dependent, or contending for a shared resource. Re-running until green hides the cause and lets it reach production. Quarantine the flaky test, record the failure output, and reproduce it by running the suite in a randomised order. Tests that depend on the current clock, on network access, or on a fixed port are the most common sources of flakiness in a pipeline.',
  },
]
