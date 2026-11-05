import type { PurchaseView, Summary } from '../api';
import { failureText, OUTCOME_LABEL, STATUS_TEXT } from '../copy';
import { formatMoney } from '../money';

interface Props {
  purchase: PurchaseView;
  summary?: Summary | undefined;
  onCheckPayment?: (() => void) | undefined;
  checking?: boolean;
}

const STAMP_CLASS: Record<string, string> = { ALLOW: 'stamp--allow', NEEDS_APPROVAL: 'stamp--review', DENY: 'stamp--deny' };

/**
 * The purchase slip: what was asked, what the agent priced, and the mandate's decision stamped across it.
 * Every reason the policy engine gave is listed; titles and messages render as text only.
 */
export function DecisionSlip({ purchase, summary, onCheckPayment, checking = false }: Props) {
  const { decision, cart, order } = purchase;
  const headline = purchase.status === 'FAILED' ? failureText(purchase.failureCode) : (STATUS_TEXT[purchase.status] ?? purchase.status);
  const currency = cart?.currency ?? decision?.evaluatedTotal.currency ?? summary?.currency ?? 'USD';

  return (
    <article className="slip" aria-live="polite">
      <header className="slip__head">
        <p className="slip__status">{headline}</p>
        {decision && (
          <p className={`stamp ${STAMP_CLASS[decision.outcome] ?? ''}`} aria-label={`Decision: ${OUTCOME_LABEL[decision.outcome] ?? decision.outcome}`}>
            {OUTCOME_LABEL[decision.outcome] ?? decision.outcome}
          </p>
        )}
      </header>

      {purchase.clarifications && purchase.clarifications.length > 0 && (
        <section className="slip__section">
          <h3>Questions from the agent</h3>
          <ul className="plain-list">
            {purchase.clarifications.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </section>
      )}

      {cart && (
        <section className="slip__section">
          <h3>Cart, priced from the catalog</h3>
          <table className="lines">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col" className="num">Qty</th>
                <th scope="col" className="num">Each</th>
                <th scope="col" className="num">Line</th>
              </tr>
            </thead>
            <tbody>
              {cart.items.map((item, index) => (
                <tr key={`${item.title}-${index}`}>
                  <td>
                    <span className="lines__title">{item.title}</span>
                    <span className="lines__category">{item.category}</span>
                  </td>
                  <td className="num">{item.quantity}</td>
                  <td className="num">{formatMoney(item.unitPriceMinor, cart.currency)}</td>
                  <td className="num">{formatMoney(item.lineTotalMinor, cart.currency)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>Total</th>
                <td className="num">{formatMoney(cart.totalMinor, cart.currency)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      {decision && (
        <section className="slip__section">
          <h3>Why</h3>
          <ul className="reasons">
            {decision.reasons.map((reason, index) => (
              <li key={`${reason.code}-${index}`} className={`reason reason--${reason.severity.toLowerCase()}`}>
                <span className="reason__message">{reason.message}</span>
                <code className="reason__code">{reason.code}</code>
              </li>
            ))}
          </ul>
          <p className="fine">Policy {decision.policyVersion}. The agent proposed products; these rules decided.</p>
        </section>
      )}

      {order && (
        <section className="slip__section slip__pay">
          <p>
            PayPal order <code>{order.id}</code>: {order.providerStatus ?? order.state}
          </p>
          <div className="actions">
            {order.approveUrl && (
              <a className="button button--primary" href={order.approveUrl} target="_blank" rel="noopener noreferrer">
                Pay on PayPal (sandbox)
              </a>
            )}
            {onCheckPayment && purchase.status === 'PAYMENT_PENDING' && (
              <button type="button" className="button" onClick={onCheckPayment} disabled={checking}>
                {checking ? 'Checking payment' : 'Check payment'}
              </button>
            )}
          </div>
        </section>
      )}

      {summary && (
        <footer className="slip__foot">
          <span>Left in this mandate</span>
          <strong>{formatMoney(summary.remainingMinor, currency)}</strong>
          <span className="fine">
            of {formatMoney(summary.budgetMinor, currency)}, after {formatMoney(summary.heldMinor, currency)} held for orders in progress
          </span>
        </footer>
      )}
    </article>
  );
}
