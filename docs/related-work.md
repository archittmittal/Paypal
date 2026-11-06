# Related work and name check

Status: **first pass, 2026-11-06.** This is a desk survey for [#29](https://github.com/PxA-Labs/Paypal/issues/29) and `VERIFY` item 4. It is not a complete literature review, and it is not user research (the interviews in #29 are still open).

How to read it: every row cites the page it came from. "Not stated" means the page we read did not say, not that the feature is absent. Vendor blogs are marketing; we mark them. Nothing here has been tested by us.

## What already exists

| Product or standard | What it is | How it limits or authorizes agent spending | Status (as read) | Source |
|---|---|---|---|---|
| **Stripe Issuing for agents** | Virtual cards and credentials that agents use to buy autonomously | Spend limits per transaction or rolling period; merchant-category controls; real-time authorization webhook (`issuing_authorization.request`, 2 s default timeout) so the business can approve or decline each charge; transaction visibility | Not stated as GA or preview; the page says to apply or contact Stripe | [docs.stripe.com/issuing/agents](https://docs.stripe.com/issuing/agents) |
| **Google AP2 (Agent Payments Protocol)** | Open protocol, an extension of A2A, built on verifiable credentials | Checkout and Payment *mandates*. Each has an "Open" stage (user constraints such as budget and allowed instruments) and a "Closed" stage (authorization for one finalized transaction). Claims a cryptographic audit trail | Spec and samples on GitHub (Apache-2.0). The site mentions a v0.2 release; no GA label | [ap2-protocol.org](https://ap2-protocol.org), [github.com/google-agentic-commerce/AP2](https://github.com/google-agentic-commerce/AP2) |
| **Ramp Agent Cards** | Tokenized virtual cards issued to agents via API or MCP | Single-agent, single-transaction scope; merchant locks and dollar caps; approval workflows above a threshold; dashboard visibility. **Vendor marketing post** | Not stated | [ramp.com/blog/ai-agent-spending-controls](https://ramp.com/blog/ai-agent-spending-controls) (published May 29, 2026) |
| **Visa Intelligent Commerce** | Visa platform for agents, wallets and enablers using Visa credentials | Consumer-approved purchase instructions, Visa Payment Passkeys for consent, agent registration and signature validation, tokenized credentials. Spend limits and categories: not stated on the page we read | Gated; sandbox, certification and production each need Visa approval | [developer.visa.com/capabilities/visa-intelligent-commerce](https://developer.visa.com/capabilities/visa-intelligent-commerce) |
| **Mastercard Agent Pay** | Agentic tokens plus permission rules (per third-party summaries) | **Not verified.** Mastercard's page returned HTTP 403 to our fetch, so we have only secondhand descriptions | Unknown | Not read |
| **PayPal Agent Toolkit and MCP server** | Library connecting PayPal commerce functions (orders, invoices) to agent frameworks | We found **no documented spending limits** in the pages surfaced by search. Absence in a search is weak evidence; check PayPal's reference before saying PayPal has none | Public | [developer.paypal.com/community/blog/paypal-agentic-ai-toolkit](https://developer.paypal.com/community/blog/paypal-agentic-ai-toolkit/) |

## Name check: "Mandate"

"Mandate" is not a unique name in this space. Treat it as a collision to disclose, not to ignore.

- **AP2 uses "mandate" as a core term** (Checkout Mandate, Payment Mandate). A judge or reader who knows AP2 may assume we implement it. We do not: our "mandate" is a team policy record (budget, per-item cap, categories, approval threshold, approver), not a signed verifiable credential. The README should say so.
- **MandateGuard**, an MCP server described on [glama.ai](https://glama.ai/mcp/servers/cb07u2zjay) as a policy engine returning approved, denied or requires-approval, with signed mandates and a hash-chained audit ledger. We read only the directory listing, not the code. Its shape is close to ours, so do not call the policy-engine idea novel on its own.
- **Mandatum**, a hosted spending-limit and authorization service for agents ([pypi.org/project/mandatumio](https://pypi.org/project/mandatumio/)). Listing only, not inspected.

## What this means for our claims

Safe to say, given what we read:
- Scoped spend limits, category controls, per-transaction approval hooks and audit trails for agent payments **already exist** from card issuers and in AP2. We should not claim to have invented the idea of agent spending controls.

Not safe to say yet:
- "First", "only" or "novel" for the policy-engine pattern. At least one open-source project (MandateGuard) describes the same three-way decision.
- Anything about Mastercard Agent Pay or PayPal's controls, until their primary pages are read.

What we can honestly point to as different, from this repo (verify each against the code and results before it ships in the README):
- The policy engine is deterministic TypeScript with no I/O and no LLM, and it sits in front of PayPal sandbox payments (`packages/policy`, `packages/payments`).
- The same attack suite runs against a naive agent, a prompt-hardened agent and Mandate, with a held-out half (`packages/evals`). Our survey found no equivalent published benchmark in the pages we read, but we did not search for one exhaustively. That is a gap in this survey, not a finding.

## Open items

- [ ] Read Mastercard Agent Pay and PayPal's agent documentation from primary pages (the fetch above was blocked or not attempted).
- [ ] Inspect MandateGuard's repository rather than its directory listing.
- [ ] Search for published agent-spending benchmarks before claiming the three-configuration result is unique.
- [ ] Interviews (5+) and README "Who it is for" findings, still owned by #29.
- [ ] Decide whether to keep the name "Mandate" or add a qualifier, given AP2 and MandateGuard.
