# CLAUDE.md: Mandate

Read this first. Keep answers short. Don't re-read files already read this session.

## What we're building
**Mandate**: spending guardrails for AI agents. Entry for the PayPal AI Hackathon (Devpost). Deadline: Nov 12, 2026, 12:00 PM PST (= Nov 13, 1:30 AM IST). Treat the evening of Nov 11 IST as the real deadline.

A team sets a **mandate** (budget, per-item cap, categories, approval threshold, approver). A teammate asks in plain language for something to buy. An LLM finds and ranks products (Channel3). A **deterministic policy engine** returns `ALLOW` / `NEEDS_APPROVAL` / `DENY` with reasons. Allowed carts are paid through PayPal sandbox (Agent Toolkit / MCP). Others go to a human approver (Zapier). A dashboard (AG Studio) shows spend, approvals and blocked attempts. Every step is audited.

**Goal: win.** Judging (equal weight): Technological Implementation (also the tie-break), Design, Potential Impact, Innovation, Presentation. Stage 1 is pass/fail on real PayPal API use. Judges may use automated AI analysis, so the README must be clear and accurate.

**USP: we measure it.** The same attack suite runs against (a) a naive agent, (b) a prompt-hardened agent, (c) Mandate.

## Hard rules (non-negotiable)
1. **The LLM proposes, code decides.** LLM modules never get payment tools or credentials. Only the `payments` module calls PayPal, and only after a policy `ALLOW` or a recorded human approval.
2. **Never trust LLM output for money.** The LLM returns candidate IDs and quantities. Code computes prices and totals from normalized catalog data. Validate every LLM output against a schema (Zod).
3. **Product text is untrusted.** Quarantine it: truncate, delimit, and use it in calls that have no tools.
4. **Money = integer minor units + ISO currency code.** Never floats.
5. **Idempotency:** every money-moving call carries an idempotency key. Webhook handlers dedupe by event ID.
6. **Sandbox only.** No real money. No automation of real retailer checkouts.
7. **No secrets in git** (keys, tokens, trial licenses, `.env`). Use `.env.example`. Judge sandbox credentials go only in the Devpost testing instructions.
8. **Don't claim what we haven't verified.** Mark unknowns `VERIFY`. Never invent citations, datasets or results. Report eval failures honestly.
9. **No employer or confidential material** from any team member's workplace.
10. **Evals:** the held-out attack set is never used for prompt tuning.

## Default stack (rationale in docs/tech-stack.md)
TypeScript everywhere, pnpm workspaces monorepo. Fastify + Zod API as a **modular monolith**. Postgres is the source of truth. Elasticsearch mirrors the audit log for search only. React + Vite frontend with AG Studio. Vitest for tests. Deploy on Render (web service, static site, Workflows, Postgres).

## Repo map (planned; update as it changes)
```
apps/web          React UI + AG Studio dashboard
apps/api          Fastify API (modules: intake, catalog, payments, approvals, audit, webhooks)
packages/policy   Pure TS policy engine (no I/O, no LLM): evaluate() + checkPriceDrift(), unit + property tests
packages/llm      Intent parsing + ranking (no tools, schema-validated)
packages/shared   Zod schemas, types, money utils
packages/evals    Scenarios, fakes (PayPal, Channel3), fixtures, runner, results/
docs/             architecture, uml, er-diagram, tech-stack, adr/
```

## Commands
Real: `pnpm install` · `pnpm lint` · `pnpm typecheck` · `pnpm test` (Vitest + coverage) · `pnpm smoke:offline` (runs each package's offline smoke, CI) · `pnpm smoke:live` (packages that call a real provider; never CI).
Planned: `pnpm dev` · `pnpm eval` · `docker compose up -d` (Postgres, Elasticsearch).

## Git workflow
- `origin` = our **fork**. `upstream` = the main team repo. Branch from `upstream/main`.
- **Never** push to upstream, force-push, or merge PRs without teammate review. Open PRs from fork to upstream `main`.
- Branch names: `type/short-topic` (`feat/`, `fix/`, `docs/`, `chore/`, `test/`, `eval/`).
- Conventional Commits: `feat(policy): block split purchases`. One logical change per commit.
- PR body: summary, what changed, how tested, `VERIFY` items.
- Before a PR: lint, typecheck and tests pass; no secrets; docs updated if behavior changed.

## Token discipline
- If `graphify-out/GRAPH_REPORT.md` exists, read it before architecture questions and before broad grep/glob. Use the graph to navigate. Open raw files only when you must edit or verify them.
- Don't read: `node_modules`, lockfiles, build output, `graphify-out/*.html`, `graphify-out/*.json`, large fixtures.
- Prefer line-range reads and `git diff --stat`. Don't paste large files back. Don't regenerate docs unless asked.
- Don't explore to "get oriented." Use this map and `docs/`.
- Graphify sends non-code content (docs, images) to an LLM for extraction. Never put secrets in docs.

## Scope control
Until Gate 2: **no** Bryntum, KERNEL or Astropods. Stretch only after the end-to-end flow works. Fallback idea if Gate 1 fails: *Runway* (payment-aware project plan for freelancers).

## Schedule and gates
| Date | Gate |
|---|---|
| Oct 24–27 | Payment-autonomy spike + deployed thin slice. **Gate 1 (Oct 27):** one real sandbox transaction executed by deployed code |
| Nov 2 | **Gate 2:** end-to-end MVP works on the deployed app |
| Nov 6 | **Gate 3:** a stranger can run it from the README |
| Nov 7 | Feature freeze |
| Nov 10 | Submit |

## Open VERIFY items
1. Can the agent capture payments autonomously in sandbox (saved/vaulted payment method), or is payer approval always required?
2. Do PayPal's remote MCP commerce tools (gift cards only today) work in sandbox?
3. Exact webhook event names and ordering guarantees.
4. Whether similar agent-spending controls already exist, before we claim novelty.

## Definition of done (any change)
Types and lint clean · tests added or updated · no secrets · docs updated · policy changes include unit tests · LLM changes include an eval run on the dev set only.
