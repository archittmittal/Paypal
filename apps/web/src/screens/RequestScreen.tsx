import { type FormEvent, useState } from 'react';
import { newRequestKey, type PurchaseView, type Summary } from '../api';
import { DecisionSlip } from '../components/DecisionSlip';
import { api, MANDATE_ID } from '../config';
import { errorText } from '../copy';

const EXAMPLES = [
  'Two sets of whiteboard markers for the club room.',
  'A 27-inch monitor, a conference speakerphone and a wireless keyboard for the design station.',
  'Buy one 100 USD digital gift card for the raffle.',
];

type State =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; purchase: PurchaseView; summary?: Summary }
  | { kind: 'error'; message: string };

/** A teammate asks in plain words; the agent finds and prices products; the mandate decides. */
export function RequestScreen({ requesterId }: { requesterId: string }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [checking, setChecking] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const request = text.trim();
    if (request === '') return;
    setState({ kind: 'working' });
    try {
      const purchase = await api.submitPurchase(MANDATE_ID, { requesterUserId: requesterId, text: request, requestKey: newRequestKey() });
      const summary = await api.getSummary(MANDATE_ID).catch(() => undefined);
      setState({ kind: 'done', purchase, ...(summary ? { summary } : {}) });
    } catch (error) {
      setState({ kind: 'error', message: errorText(error) });
    }
  }

  async function checkPayment(purchase: PurchaseView) {
    setChecking(true);
    try {
      const updated = await api.capture(purchase.id);
      const summary = await api.getSummary(MANDATE_ID).catch(() => undefined);
      setState({ kind: 'done', purchase: updated, ...(summary ? { summary } : {}) });
    } catch (error) {
      setState({ kind: 'error', message: errorText(error) });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="split">
      <section className="ask">
        <h1>What does the club need?</h1>
        <p className="lede">Describe it the way you would to a teammate. The agent finds products; the mandate decides what can be bought.</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="request" className="visually-hidden">
            Purchase request
          </label>
          <textarea
            id="request"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={4000}
            rows={6}
            placeholder="Two sets of whiteboard markers for the club room."
            disabled={state.kind === 'working'}
          />
          <div className="actions">
            <button type="submit" className="button button--primary" disabled={state.kind === 'working' || text.trim() === ''}>
              {state.kind === 'working' ? 'Finding products' : 'Ask the agent'}
            </button>
            <span className="fine">{text.length} / 4000</span>
          </div>
        </form>
        <div className="examples">
          <p className="fine">Try one of these</p>
          <ul className="plain-list">
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button type="button" className="link" onClick={() => setText(example)} disabled={state.kind === 'working'}>
                  {example}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="result" aria-label="Decision">
        {state.kind === 'idle' && <p className="empty">The decision appears here, with every rule that applied.</p>}
        {state.kind === 'working' && (
          <p className="empty" role="status">
            Reading the request, searching the catalog and checking the mandate. This can take up to a minute.
          </p>
        )}
        {state.kind === 'error' && (
          <p className="error" role="alert">
            {state.message}
          </p>
        )}
        {state.kind === 'done' && (
          <DecisionSlip purchase={state.purchase} summary={state.summary} onCheckPayment={() => void checkPayment(state.purchase)} checking={checking} />
        )}
      </section>
    </div>
  );
}
