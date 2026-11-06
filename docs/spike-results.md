# PayPal sandbox spike results (VERIFY 1, issue #9)

**Question.** Can Mandate charge a saved (vaulted) PayPal wallet with no buyer present, or must the buyer approve every order?

**Answer (sandbox, 2026-11-06): yes.** After the buyer approved one order that saved their wallet, our code charged the saved wallet with no buyer present. PayPal returned `COMPLETED` straight from order creation. Live behaviour is not verified. See [Limits](#limits).

## Setup

- PayPal REST sandbox (`https://api-m.sandbox.paypal.com`), Orders v2. The client has no setting that targets the live API ([`packages/payments/src/config.ts`](../packages/payments/src/config.ts)).
- Sandbox REST app with **Accept payments** and **Vault** (Advanced options) enabled in the Developer Dashboard. The buyer was a sandbox **Personal** account.
- Credentials were in a local, git-ignored `.env`. None appear here.
- Code: `packages/payments` at commit `43785ee`, driven by [`packages/payments/smoke/spike.ts`](../packages/payments/smoke/spike.ts). Every money-moving call sent a fresh `PayPal-Request-Id`.
- Amount: 500 USD minor units ($5.00, sandbox money) per order.

## What was run and what happened

All IDs are PayPal sandbox identifiers. They are not secrets. No call returned an error, so there are no `debug_id`s to record.

| # | Time (UTC) | Command | Outcome |
|---|---|---|---|
| 1 | 2026-11-06 17:12 | `pnpm --filter @mandate/payments spike create 500 --save` | Order `7UF80317VH897320V`, status **`PAYER_ACTION_REQUIRED`**, with an approve link (`https://www.sandbox.paypal.com/checkoutnow?token=7UF80317VH897320V`) |
| 2 | 17:12–17:44 | A person opened the link, logged in as the sandbox buyer and approved | Approval done in the browser |
| 3 | before 17:44 | `pnpm --filter @mandate/payments spike capture 7UF80317VH897320V 500` | Order **`COMPLETED`**. Capture `66P59884YA789644G` **`COMPLETED`**, 500 USD (our amount check passed). Vault **`VAULTED`**, vault id `7dk93064y5629801m`, customer id `MkSnmBKqqR` |
| 4 | 17:44 | `pnpm --filter @mandate/payments spike charge-saved 7dk93064y5629801m 500` | New order `3NS71238VV0748509`, **`COMPLETED` on create**, no buyer present. Capture `3WW6864649114192E` **`COMPLETED`**, 500 USD |
| 5 | 17:45 | `spike get 7UF80317VH897320V` and `spike get 3NS71238VV0748509` | Both orders `COMPLETED` on PayPal, one `COMPLETED` 500 USD capture each. Order 1 still shows vault `VAULTED` `7dk93064y5629801m` |

Step 3 is the first real sandbox payment made by our own code. It ran from a laptop, not from the deployed service. The Gate 1 deployed transaction is #14.

## Field names (confirmed against the API)

Request fields came from PayPal's docs ("Save PayPal with the Orders API" and "Save PayPal with the Payment Method Tokens API", developer.paypal.com, read 2026-11-05). The live responses above confirmed them.

| Purpose | Field | In code |
|---|---|---|
| Save the wallet on the first order | `payment_source.paypal.attributes.vault = { "store_in_vault": "ON_SUCCESS", "usage_type": "MERCHANT" }`, with `experience_context.return_url` / `cancel_url` | `client.ts` `#paypalSource` (`saveForLater`) |
| Read the saved wallet after capture | `payment_source.paypal.attributes.vault.id`, `.status` (`VAULTED`), `.customer.id` | `schemas.ts` `OrderResponseSchema`; `OrderSummary.vault` |
| Charge the saved wallet later | `payment_source.paypal.vault_id` | `client.ts` `#paypalSource` (`kind: 'vaulted'`) |
| Idempotency | `PayPal-Request-Id` header on create and capture | `client.ts` `#send` |

No field names changed. `customer_type`, `permit_multiple_payment_tokens` and `stored_credential` were not sent and were not needed in sandbox.

## Which flow Mandate uses, and why

Two variants (see [uml.md](uml.md)):

- **Variant B, buyer approval (what the API runs today).** After `ALLOW`, or after a recorded human approval, the API creates the order and returns PayPal's `approveUrl`. Once the buyer approves, the API captures through `POST /purchases/:id/capture`, or through `reconcile()` when a webhook or the job sees the order `APPROVED`. The capture is checked against the approved amount.
- **Variant A, saved wallet (shown to work in sandbox by this spike, not yet in the API).** The mandate owner approves one order that saves their wallet. After that, an `ALLOW` decision can pay within the mandate with no human present. This is the autonomous path the product is about.

Variant A needs more than this issue covers: a vault id stored per mandate, a one-time "save wallet" step, and an amount check on the **create** response. A vaulted order completes on create, while the client checks amounts only at capture today. That work is a follow-up. Either way, the policy engine decides what reaches PayPal, and the database now refuses a payment order without `ALLOW` or an `APPROVED` approval (migration `0004`).

## Fixes made alongside the spike

- **PENDING captures.** An order can be `COMPLETED` while its capture is still `PENDING`. Before this change, the client skipped the amount check and the service marked the request `CAPTURED`. Now the client checks `COMPLETED` and `PENDING` captures, and the service marks `CAPTURED` only when PayPal reports a settled capture for the exact amount. A pending capture keeps the budget held. An amount mismatch becomes `UNKNOWN_OUTCOME` for a human.
- **Pay only after authorization, in the database.** Migration `0004_payment_order_authorization.sql` refuses a `payment_order` unless its decision belongs to the same request and is `ALLOW`, or is `NEEDS_APPROVAL` with that decision's own approval `APPROVED`. It also refuses an amount above the decision's evaluated total, or a different currency.

## Limits

- **Sandbox only, one run.** One saved wallet and one $5.00 charge. Declines, revoked tokens, insufficient funds and repeated charges were not tested.
- **Live will differ.** PayPal's docs say saving PayPal as a payment source needs approval for reference transactions ("Contact your account manager"). They also say charges with saved PayPal tokens need Risk Data Acquisition (FraudNet/Magnes) and are "likely to be declined" without it. Sandbox did not require either. We did not test live.
- **Unclear guidance.** The "Save PayPal with the Orders API" page has a note: "Don't save PayPal as a payment method during purchase." It is not clear what it means, given that the page documents exactly that flow. `VERIFY` with PayPal before relying on this flow outside sandbox.
- **Not exercised here:** webhooks (no webhook was registered on the app), the idempotency window of `PayPal-Request-Id`, and the deployed service (#14).
- The sandbox accounts' country was not recorded. PayPal lists the US among the supported countries for saving PayPal.
