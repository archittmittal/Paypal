import { useEffect, useState } from 'react';
import type { AuditEntry, PurchaseView, Summary } from '../api';
import { DecisionSlip } from '../components/DecisionSlip';
import { api, MANDATE_ID } from '../config';
import { errorText } from '../copy';
import { describeAudit } from '../dashboard';

const TIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; purchase: PurchaseView; summary?: Summary; audit?: AuditEntry[] };

/** The decision view for one request, linked from the dashboard. */
export function PurchaseScreen({ purchaseId }: { purchaseId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    Promise.all([api.getPurchase(purchaseId), api.getSummary(MANDATE_ID).catch(() => undefined), api.getAudit(purchaseId).catch(() => undefined)])
      .then(([purchase, summary, audit]) => live && setState({ kind: 'ready', purchase, ...(summary ? { summary } : {}), ...(audit ? { audit } : {}) }))
      .catch((error: unknown) => live && setState({ kind: 'error', message: errorText(error) }));
    return () => {
      live = false;
    };
  }, [purchaseId]);

  async function checkPayment(purchase: PurchaseView) {
    setChecking(true);
    try {
      const updated = await api.capture(purchase.id);
      const audit = await api.getAudit(purchase.id).catch(() => undefined);
      setState({ kind: 'ready', purchase: updated, ...(audit ? { audit } : {}) });
    } catch (error) {
      setState({ kind: 'error', message: errorText(error) });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="narrow">
      <p>
        <a href="#/dashboard">Back to the dashboard</a>
      </p>
      {state.kind === 'loading' && <p className="empty">Loading the request.</p>}
      {state.kind === 'error' && <p className="error" role="alert">{state.message}</p>}
      {state.kind === 'ready' && <DecisionSlip purchase={state.purchase} summary={state.summary} onCheckPayment={() => void checkPayment(state.purchase)} checking={checking} />}
      {state.kind === 'ready' && state.audit && state.audit.length > 0 && (
        <section className="audit" aria-labelledby="audit-title">
          <h2 id="audit-title">Audit trail</h2>
          <ol className="audit__list">
            {state.audit.map((entry, index) => {
              const { what, who } = describeAudit(entry);
              return (
                <li key={`${entry.at}-${index}`}>
                  <time dateTime={entry.at}>{TIME.format(new Date(entry.at))}</time>
                  <span>{what}</span>
                  <span className="fine">{who}</span>
                </li>
              );
            })}
          </ol>
          <p className="fine">Recorded in an append-only log. Entries cannot be edited or deleted.</p>
        </section>
      )}
    </div>
  );
}
