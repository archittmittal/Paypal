import { randomUUID } from 'node:crypto';
import { PaymentError } from '../src/errors.js';
import { type OrderSummary, PaypalClient } from '../src/client.js';
import { PaypalConfigError, loadPaypalConfig } from '../src/config.js';

// Gate 1 / VERIFY 1 spike against the real PayPal sandbox. Never runs in CI.
// Usage (from packages/payments, with PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the repo .env):
//   pnpm spike create <amountMinor> [--save]   create an order; approve it in a browser as the sandbox buyer
//   pnpm spike capture <orderId> <amountMinor> capture the approved order; prints the vault id if saved
//   pnpm spike charge-saved <vaultId> <amountMinor>  try to pay with the vaulted wallet, no buyer present
//   pnpm spike get <orderId>

const USAGE = 'Usage: spike create <amountMinor> [--save] | capture <orderId> <amountMinor> | charge-saved <vaultId> <amountMinor> | get <orderId>';

function usd(raw: string | undefined) {
  const amountMinor = Number(raw);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 100_000) {
    throw new Error('amountMinor must be an integer between 1 and 100000 (USD cents)');
  }
  return { amountMinor, currency: 'USD' };
}

const key = (step: string) => `spike-${step}-${randomUUID()}`;

function report(step: string, order: OrderSummary): void {
  console.info(JSON.stringify({ step, ...order }, null, 2));
}

async function main(argv: string[]): Promise<void> {
  if (process.env['CI']) throw new Error('The spike never runs in CI');
  const client = new PaypalClient({ config: loadPaypalConfig(process.env) });
  const [command, first, second] = argv;
  const reference = `spike-${Date.now()}`;

  switch (command) {
    case 'create': {
      const order = await client.createOrder({
        amount: usd(first),
        idempotencyKey: key('create'),
        reference,
        description: 'Mandate sandbox spike',
        paymentSource: { kind: 'buyer-approval', saveForLater: argv.includes('--save') },
      });
      report('create', order);
      console.info(`\nNext: open approveUrl, log in as the SANDBOX buyer, approve, then run: pnpm spike capture ${order.id} ${first}`);
      return;
    }
    case 'capture': {
      if (!first) throw new Error(USAGE);
      const order = await client.captureOrder(first, key('capture'), usd(second));
      report('capture', order);
      if (order.vault?.id) {
        console.info(`\nWallet saved. VERIFY 1 next: pnpm spike charge-saved ${order.vault.id} 500`);
      }
      return;
    }
    case 'charge-saved': {
      if (!first) throw new Error(USAGE);
      const order = await client.createOrder({
        amount: usd(second),
        idempotencyKey: key('charge-saved'),
        reference,
        description: 'Mandate spike: agent-initiated',
        paymentSource: { kind: 'vaulted', vaultId: first },
      });
      report('charge-saved', order);
      console.info(
        order.status === 'COMPLETED'
          ? '\nRESULT: paid with no buyer present. VERIFY 1 = yes in sandbox.'
          : `\nRESULT: status ${order.status}. The buyer still has to act; record this as VERIFY 1 = no (or needs capture).`,
      );
      return;
    }
    case 'get': {
      if (!first) throw new Error(USAGE);
      report('get', await client.getOrder(first));
      return;
    }
    default:
      throw new Error(USAGE);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof PaypalConfigError) {
    console.error(`Missing or invalid: ${error.variables.join(', ')}. Add them to the repo .env (see .env.example).`);
  } else if (error instanceof PaymentError) {
    console.error(JSON.stringify({ code: error.code, message: error.message, ...error.details }));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
