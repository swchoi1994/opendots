# OpenDots roadmap: what ships before the public release

**Date:** 2026-10-01
**Status:** Decomposition and order approved in chat; each sub-project gets its own design spec.

## Goal

OpenDots is an open-source, self-hostable team of always-on AI coworkers: named bots with their own role, tools, browser, workspace and memory, that you message like people. It takes its shape from two products: xAI's Grok Bot (early beta 2026-08-11) and OpenAI's Dots (announced 2026-09-29). It runs on Claude through an Anthropic API key or on local models through Ollama.

The code starts from EigenBots (the `bots/` app in the private eigenoffice repo), imported with fresh history and renamed. The owner holds the rights to all of it.

## Release gate

The GitHub repository (`swchoi1994/opendots`) stays **private** until all six sub-projects below have shipped and been verified. Making it public is the owner's call, not part of any sub-project.

## Decisions that apply to every sub-project

| Topic | Decision |
| --- | --- |
| Name | OpenDots. Other repositories with this name exist (for example `diggerhq/opendots`); the owner accepted that. |
| License | MIT. |
| Brain | One agent loop, the Claude Agent SDK, for every model. Ollama and other Anthropic-compatible endpoints are reached by pointing the SDK at a different base URL. Verified 2026-10-01: an SDK turn on local `qwq` through Ollama called an in-process MCP tool and finished in 2 turns. |
| No subscription login | The Agent SDK docs say: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." OpenDots never uses or advertises a claude.ai login. Claude runs only through an API key. |
| Ownership (from B on) | Workspaces. Every person has a personal workspace and can create team workspaces with members (Clerk Organizations). Bots, chats, files and memory belong to a workspace. |
| Storage | Postgres everywhere: PGlite (embedded) by default, a Postgres server when `DATABASE_URL` is set. Verified 2026-10-01: all existing `db/*.sql` migrations, pgvector and the seed advisory lock run unchanged on PGlite 0.5.8. |
| Graph storage | Apache AGE (Cypher in Postgres). Verified 2026-10-01: a Cypher create and match round-trip works in PGlite with `@electric-sql/pglite-age`. A server Postgres image with both AGE and pgvector is still an open item for D. |

## Sub-projects, in build order

| Order | Sub-project | Delivers | Depends on |
| --- | --- | --- | --- |
| 1 | **A. Core** | Model choice (Anthropic API key, Ollama, any Anthropic-compatible endpoint), PGlite by default, safe defaults, MIT license, README, CI | — |
| 2 | **B. Login** | Clerk sign-in with Google and Microsoft; workspaces (personal and team) with members; single-user local mode when Clerk is not configured | A |
| 3 | **C. Multimodal** | Images and files in chat, read by Claude or by a local Ollama vision model | A |
| 4 | **F. Bot team** | Bots message each other, call on each other to do part of a task and wait for the answer, create new bots on the user's behalf, and share group chats with people and other bots | B |
| 5 | **D. Graph memory** | Bots record the people, companies, decisions and facts they learn as a graph, and recall them in later chats | B, F |
| 6 | **E. Workflow graph** | A multi-step job as a visible, editable graph of steps (bot turns, tools, conditions, waits) with schedule and event triggers | F |

"Graph engineering" covers D, E and the team side of F: the owner chose all three meanings.

## Questions each sub-project settles in its own design

- **B:** how share links (today's passcode-gated deployments) behave once there is real sign-in; how local single-user mode maps onto workspaces.
- **C:** which file types count for v1; where attachments are stored, and how they reach Ollama models that cannot see images.
- **F:** whether a bot may create another bot without asking the person first; how loops between bots are prevented; how much one bot can see of another bot's workspace.
- **D:** what counts as a fact worth saving; memory per bot or per workspace; how a person sees and deletes what a bot remembers.
- **E:** the editor library (for example React Flow / xyflow, MIT); how a workflow run is shown in chat; how Phase 3 automations from EigenBots fold in.
