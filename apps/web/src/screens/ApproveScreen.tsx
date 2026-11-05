import { useEffect, useState } from 'react';
import type { ApprovalPreview, PurchaseView } from '../api';
import { DecisionSlip } from '../components/DecisionSlip';
import { api } from '../config';
import { errorText } from '../copy';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'review'; preview: ApprovalPreview }
  | { kind: 'deciding'; preview: ApprovalPreview; decision: 'APPROVE' | 'REJECT' }
  | { kind: 'done'; purchase: PurchaseView; decision: 'APPROVE' | 'REJECT' };

const WHEN = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const CLOSED_TEXT: Record<string, string> = {
  APPROVED: 'This request was already approved.',
  REJECTED: 'This request was already rejected.',
  EXPIRED: 'This approval window has closed. The requester can ask again.',
};

/**
 * The approver's page, opened from the link in the Zapier message. The token is the whole credential: it is
 * single-use, expires, and is sent only in request bodies. It is removed from the address bar once read.
 */
export function ApproveScreen({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    // Keep the token out of the browser history and off the screen once the page has it.
    window.history.replaceState(null, '', '#/approve');
    let live = true;
    api
      .previewApproval(token)
      .then((preview) => live && setState({ kind: 'review', preview }))
      .catch((error: unknown) => live && setState({ kind: 'error', message: errorText(error) }));
    return () => {
      live = false;
    };
  }, [token]);

  async function decide(preview: ApprovalPreview, decision: 'APPROVE' | 'REJECT') {
    setState({ kind: 'deciding', preview, decision });
    try {
      const purchase = await api.decideApproval(token, decision);
      setState({ kind: 'done', purchase, decision });
    } catch (error) {
      setState({ kind: 'error', message: errorText(error) });
    }
  }

  if (state.kind === 'loading') return <p className="empty">Opening the approval request.</p>;
  if (state.kind === 'error') {
    return (
      <div className="narrow">
        <p className="error" role="alert">
          {state.message}
        </p>
        <p className="fine">Approval links work once and expire. Open the latest link from the message, or ask the requester to submit again.</p>
      </div>
    );
  }
  if (state.kind === 'done') {
    return (
      <div className="narrow">
        <h1>{state.decision === 'APPROVE' ? 'Approved' : 'Rejected'}</h1>
        <p className="lede">
          {state.decision === 'APPROVE'
            ? 'The price was checked again before paying. The requester can now finish the payment on PayPal.'
            : 'Nothing was bought, and the budget hold was released.'}
        </p>
        <DecisionSlip purchase={state.purchase} />
      </div>
    );
  }

  const { preview } = state;
  const pending = preview.approval.status === 'PENDING';
  return (
    <div className="narrow">
      <h1>Approve this purchase?</h1>
      <p className="lede">
        {pending
          ? `The mandate sent this to you because it needs a person's decision. Decide by ${WHEN.format(new Date(preview.approval.expiresAt))}.`
          : (CLOSED_TEXT[preview.approval.status] ?? preview.approval.status)}
      </p>
      <DecisionSlip purchase={preview.purchase} />
      {pending && (
        <div className="actions">
          <button type="button" className="button button--primary" disabled={state.kind === 'deciding'} onClick={() => void decide(preview, 'APPROVE')}>
            {state.kind === 'deciding' && state.decision === 'APPROVE' ? 'Approving' : 'Approve purchase'}
          </button>
          <button type="button" className="button" disabled={state.kind === 'deciding'} onClick={() => void decide(preview, 'REJECT')}>
            {state.kind === 'deciding' && state.decision === 'REJECT' ? 'Rejecting' : 'Reject'}
          </button>
        </div>
      )}
    </div>
  );
}
