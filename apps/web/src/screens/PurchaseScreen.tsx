import { useEffect, useState } from 'react';
import type { PurchaseView, Summary } from '../api';
import { DecisionSlip } from '../components/DecisionSlip';
import { api, MANDATE_ID } from '../config';
import { errorText } from '../copy';

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; purchase: PurchaseView; summary?: Summary };

/** The decision view for one request, linked from the dashboard. */
export function PurchaseScreen({ purchaseId }: { purchaseId: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    Promise.all([api.getPurchase(purchaseId), api.getSummary(MANDATE_ID).catch(() => undefined)])
      .then(([purchase, summary]) => live && setState({ kind: 'ready', purchase, ...(summary ? { summary } : {}) }))
      .catch((error: unknown) => live && setState({ kind: 'error', message: errorText(error) }));
    return () => {
      live = false;
    };
  }, [purchaseId]);

  async function checkPayment(purchase: PurchaseView) {
    setChecking(true);
    try {
      setState({ kind: 'ready', purchase: await api.capture(purchase.id) });
    } catch (error) {
      setState({ kind: 'error', message: errorText(error) });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="narrow">
      {state.kind === 'loading' && <p className="empty">Loading the request.</p>}
      {state.kind === 'error' && <p className="error" role="alert">{state.message}</p>}
      {state.kind === 'ready' && <DecisionSlip purchase={state.purchase} summary={state.summary} onCheckPayment={() => void checkPayment(state.purchase)} checking={checking} />}
    </div>
  );
}
