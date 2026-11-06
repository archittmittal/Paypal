# Tech stack: Mandate

One language across the whole repo (TypeScript), one deployable API (Fastify), one source of truth (Postgres), and a deliberately thin LLM layer that holds no tools.
Choices below are optimized for five people, 21 days, and a correctness-critical payment path — not for scale we will never reach.
Where the recommended default is kept but the author disagrees, a **Dissent** note records why; those are open questions for the team, not silent changes.

**Related:** [README](../README.md) · [architecture](architecture.md) · [UML](uml.md) · [ER diagram](er-diagram.md) · [ADRs](adr/)

---

## 1. Stack table

| Layer | Choice | Why | Alternatives | Risk |
|---|---|---|---|---|
| **Language** | TypeScript (strict) | One language for API, SPA, policy, evals. Zod schemas and domain types are shared, not duplicated across a language boundary | Python API with a TS frontend; Go API | Type-level safety is not runtime safety — every boundary still needs Zod validation |
| **Runtime** | Node LTS | Broad library support for PayPal, Channel3 and Elastic clients; matches Render's defaults | Bun, Deno | A library with a native dependency could misbehave on an unusual runtime; LTS avoids that class of problem entirely |
| **Monorepo** | pnpm workspaces | Enforces the module boundaries the architecture depends on: `packages/llm` simply does not depend on the PayPal client, so it cannot call it. Checkable in CI | npm workspaces, Turborepo, separate repos | Workspace protocol and hoisting quirks cost an hour or two early. Separate repos would cost far more |
| **API framework** | Fastify + Zod | Fast, small, first-class schema validation at the route boundary, good TypeScript ergonomics | Express, NestJS, Hono | Fewer copy-paste answers than Express. NestJS brings DI and decorators we do not need at this size |
| **Validation** | Zod, in `packages/shared` | One schema per contract, reused at the HTTP boundary, the LLM output boundary and the webhook boundary. LLM structured output validates against the same schemas | io-ts, Valibot, JSON Schema + Ajv | None material |
| **Database** | Postgres | Transactions, row locking, `jsonb`, unique constraints — the exact primitives the budget reservation and dedupe designs rely on | MySQL, SQLite, a document store | Managed-plan limits on Render are `VERIFY` |
| **ORM / query layer** | Drizzle | SQL-shaped, so the `SELECT ... FOR UPDATE` in the reservation path stays readable and reviewable. Light runtime, straightforward migrations | Prisma, Kysely, raw `pg` | Smaller ecosystem than Prisma; the team may have less prior exposure. See §2 |
| **Frontend** | React + Vite + TypeScript | Matches AG Studio's ecosystem; fast dev loop; builds to a static bundle Render can host directly | Next.js, SvelteKit, Remix | `VERIFY` the AG Studio boilerplate's React and build-tool versions and project layout **before** scaffolding `apps/web`, and align with it. No boilerplate is in this repo yet, so this row is provisional |
| **Dashboard** | AG Studio / AG Grid | Sponsor-core: spend, approvals and blocked attempts with custom widgets | A hand-built table | Trial expiry before judging ends Dec 15 is a tracked risk |
| **LLM access** | Thin provider-agnostic wrapper in `packages/llm`, schema-validated structured output | Provider stays an implementation detail behind one interface, so a rate limit or a pricing surprise is a config change. The wrapper exposes **no tool-calling API at all**, which is how hard rule 1 is enforced structurally | LangChain, LangGraph, Vercel AI SDK, a provider SDK used directly | Writing our own retry and parsing logic. Small, and the alternative frameworks are built around giving models tools — see [ADR 0004](adr/0004-llm-has-no-tools-policy-in-code.md) |
| **Search mirror** | Elasticsearch | Sponsor-supporting; audit search and "have we bought this before?" | Postgres full-text search alone | Operational weight in local development. See §2 |
| **Durable jobs** | Postgres-backed queue in the API repo, run in a worker role | Job state lives in the same transaction boundary as order state, so "capture succeeded but the follow-up job was lost" cannot happen. Runs identically on a laptop | Render Workflows, BullMQ + Redis, Temporal | We write the retry and backoff logic ourselves. See §2 |
| **Unit tests** | Vitest | Same toolchain as Vite; fast. `packages/policy` is pure, so thousands of cases run in milliseconds — which is what makes the three-configuration measurement affordable | Jest, node:test | None material |
| **E2E** | Playwright, exactly one test | One test covering request → decision → payment → dashboard catches integration rot without becoming a maintenance burden in the final week | Cypress, no e2e at all | A flaky e2e in CI wastes scarce time; keep it to one, and keep it deterministic against fixtures |
| **CI** | GitHub Actions: lint, typecheck, test | Cheap, visible on every PR, and judges can see it green | CircleCI, none | Minutes on a fork. Keep the matrix to one Node version |
| **Logging** | pino, structured JSON | Correlates request id → decision id → order id across modules; no credentials or full payment payloads ever logged | console, winston | Discipline required: structured fields, not interpolated strings |
| **Local environment** | Docker Compose: Postgres, Elasticsearch | A stranger runs `docker compose up -d && pnpm dev` — the Gate 3 test | Local installs, cloud-only development | Elasticsearch is heavy on a laptop. See §2 |
| **Deployment** | Render: static site, web service, worker, managed Postgres | Sponsor-core; one platform for all four pieces; straightforward environment-variable config | Fly.io, Railway, Vercel + Neon | `VERIFY` Render database plan limits (storage, connections, retention) |
| **API docs / collection** | Postman collection in the repo | Sponsor-supporting; gives judges a way to exercise the API directly | OpenAPI only | Keeping the collection in step with the code |
| **PayPal integration** | PayPal Agent Toolkit / MCP, called only from the `payments` module | Stage 1 is pass/fail on real PayPal API use | Direct REST calls | Autonomous capture works in sandbox ([spike-results.md](spike-results.md)); `VERIFY` the exact idempotency header name, and whether remote MCP commerce tools work in sandbox |

## 2. Dissent notes

The recommended defaults above stand. These are the places where the author would argue differently, recorded so the team can decide rather than inherit.

### Dissent 1 — Elasticsearch should not be required to run the project locally

**Default kept:** Elasticsearch in `docker compose`, mirroring `audit_log`.

**Disagreement.** Gate 3 is "a stranger can run it from the README," and a judge's first run is the one that counts. Elasticsearch adds a multi-hundred-megabyte container, a memory floor that strains a modest laptop, and a startup failure mode (`vm.max_map_count`, heap settings) that has nothing to do with our product. The one feature it serves — audit search — is covered acceptably by Postgres full-text search at our data volume, which is hundreds of rows, not millions.

**What I would do instead.** Keep Elasticsearch as a deployed, sponsor-visible feature and in the demo video, but make it **optional locally**: a `SEARCH_BACKEND=postgres|elastic` switch defaulting to `postgres`, with the Elasticsearch service behind a Compose profile. The audit mirror is already non-authoritative ([ADR 0003](adr/0003-postgres-source-of-truth-elastic-mirror.md)), so nothing about correctness changes, and a fresh clone starts with one container instead of two.

**Why it is a dissent and not a change.** Sponsor depth is judged, and a reviewer may reasonably want Elasticsearch exercised by default on every developer machine. That is the team's call.

### Dissent 2 — durable jobs: Postgres queue over Render Workflows

**Default kept:** both are listed as viable in [architecture.md](architecture.md#4-architecture-style-decision); the stack table picks the Postgres-backed queue.

**Disagreement with the alternative.** Render Workflows is the more sponsor-visible option and would likely score as depth of Render usage. The author still prefers the Postgres queue, because the hardest correctness problem we have is the gap between "money moved" and "we recorded that money moved." A queue in the same database as the order lets enqueue and state change share one transaction. An external orchestrator reintroduces exactly the distributed-failure modes that [ADR 0001](adr/0001-modular-monolith.md) rejects microservices to avoid, on the path where it hurts most.

**Reversal condition.** If the Render prize is judged primarily on Workflows usage, move the *outer* orchestration (approval timers, tracking polls) to Workflows while keeping money-moving steps transactional with the database. That split keeps the correctness property and buys the sponsor depth.

### Dissent 3 — Drizzle over Prisma, weakly held

**Default kept:** Drizzle, as recommended.

**Position.** This is close, and the author would not fight for it. Drizzle wins because the reservation path needs explicit `SELECT ... FOR UPDATE`, and SQL-shaped code makes the lock visible in review. Prisma's interactive transactions can do the same thing, and Prisma's migrations and tooling are friendlier to a team under time pressure. **If more than one teammate has real Prisma experience and none has Drizzle experience, switch** — the ORM is not where this project's risk lives, and familiarity is worth more than elegance in 21 days. Whoever makes that call should record it as an ADR amendment rather than a quiet swap.

## 3. Things deliberately not in the stack

| Not using | Reason |
|---|---|
| An agent framework with tool calling | Contradicts hard rule 1. We would spend the time constraining it rather than using it |
| Redis | The Postgres queue removes the need; one fewer service for a stranger to start |
| A microservice split | See [ADR 0001](adr/0001-modular-monolith.md) |
| Kubernetes, Terraform, a service mesh | Five people, 21 days, one deployable |
| Bryntum, KERNEL, Astropods | Stretch only, and not before Gate 2 |
| A second database for analytics | The dashboard reads Postgres directly at our volume |
| Floating-point money anywhere | Hard rule 4 |

## 4. Versions

Pinned versions are decided at scaffold time and recorded here then, against the Node LTS current on that date. Nothing in this document asserts a version we have not installed.

| Item | Status |
|---|---|
| Node LTS major | TBD at scaffold |
| pnpm | TBD at scaffold |
| React / Vite | `VERIFY` against the AG Studio boilerplate first, then pin to match |
| Postgres | TBD, matching the Render managed version |
| Everything else | Pinned in the lockfile; the lockfile is committed |

## 5. Open VERIFY items owned by this document

| # | Item |
|---|---|
| 1 | Render database plan limits: storage, connection count, backup and retention policy |
| 2 | The exact PayPal idempotency request header name and its semantics on retry |
| 3 | ~~Whether autonomous capture via a saved or vaulted payment method works in sandbox~~ Answered: yes in sandbox, see [spike-results.md](spike-results.md). Live still needs PayPal's approval for reference transactions |
| 4 | Whether PayPal's remote MCP commerce tools work in sandbox |
| 5 | The AG Studio boilerplate's React and build-tool versions and project layout |
| 6 | How AG Grid and Elastic handle trials that expire before judging ends Dec 15 |

## 6. Decision records

| ADR | Decision |
|---|---|
| [0001](adr/0001-modular-monolith.md) | Modular monolith with durable background jobs, not microservices |
| [0002](adr/0002-typescript-monorepo.md) | TypeScript everywhere in a pnpm workspaces monorepo |
| [0003](adr/0003-postgres-source-of-truth-elastic-mirror.md) | Postgres is the source of truth; Elasticsearch is a non-authoritative mirror |
| [0004](adr/0004-llm-has-no-tools-policy-in-code.md) | The LLM has no tools; policy lives in deterministic code |
