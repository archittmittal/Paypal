import { CellStyleModule, ClientSideRowModelModule, type ColDef, ModuleRegistry, RowStyleModule, themeQuartz, TooltipModule, ValidationModule } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useEffect, useMemo, useState } from 'react';
import type { MandateView, PurchaseListItem, Summary } from '../api';
import { api, MANDATE_ID } from '../config';
import { errorText, OUTCOME_LABEL } from '../copy';
import { age, budgetSegments, categoryRows, countBy, type Filter, filterItems } from '../dashboard';
import { formatMoney } from '../money';

// Only the modules this grid uses, which keeps the bundle small. Validation warns about a missing module in dev.
ModuleRegistry.registerModules([ClientSideRowModelModule, CellStyleModule, TooltipModule, RowStyleModule, ...(import.meta.env.DEV ? [ValidationModule] : [])]);

// The grid takes its colours from the page's tokens, so light and dark mode follow the rest of the app.
const gridTheme = themeQuartz.withParams({
  fontFamily: 'inherit',
  backgroundColor: 'var(--surface)',
  foregroundColor: 'var(--ink)',
  borderColor: 'var(--rule)',
  headerBackgroundColor: 'var(--paper)',
  accentColor: 'var(--accent)',
  rowHoverColor: 'color-mix(in oklab, var(--accent) 7%, transparent)',
  wrapperBorderRadius: 2,
});

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; mandate: MandateView; summary: Summary; items: PurchaseListItem[] };

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'paid', label: 'Allowed and paid' },
];

const STATUS_WORD: Record<string, string> = {
  DENIED: 'Denied',
  REJECTED: 'Rejected',
  FAILED: 'Stopped',
  EXPIRED: 'Expired',
  PENDING_APPROVAL: 'Waiting for approval',
  NEEDS_CLARIFICATION: 'Needs detail',
  NO_MATCH: 'No match',
  PAYMENT_PENDING: 'Awaiting PayPal',
  UNKNOWN_OUTCOME: 'Checking PayPal',
  CAPTURED: 'Paid',
};

/** Spend against the mandate, what is waiting on a person, and every attempt the guardrails stopped. */
export function DashboardScreen() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [filter, setFilter] = useState<Filter>('all');
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let live = true;
    const refresh = () =>
      Promise.all([api.getMandate(MANDATE_ID), api.getSummary(MANDATE_ID), api.listPurchases(MANDATE_ID, { limit: 200 })])
        .then(([mandate, summary, items]) => {
          if (!live) return;
          setLoad({ kind: 'ready', mandate, summary, items });
          setNow(new Date());
        })
        .catch((error: unknown) => live && setLoad({ kind: 'error', message: errorText(error) }));
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  const currency = load.kind === 'ready' ? load.summary.currency : 'USD';
  const columns = useMemo<ColDef<PurchaseListItem>[]>(
    () => [
      { headerName: 'When', field: 'createdAt', width: 104, valueFormatter: (p) => (typeof p.value === 'string' ? age(p.value, now) : ''), sort: 'desc' },
      { headerName: 'Who', field: 'requester', width: 140, tooltip: true },
      { headerName: 'Request', field: 'text', flex: 2, minWidth: 180, tooltip: true },
      { headerName: 'Status', field: 'status', width: 172, valueFormatter: (p) => (typeof p.value === 'string' ? (STATUS_WORD[p.value] ?? p.value) : '') },
      { headerName: 'Decision', field: 'outcome', width: 138, valueFormatter: (p) => (typeof p.value === 'string' ? (OUTCOME_LABEL[p.value] ?? p.value) : '') },
      { headerName: 'Reasons', field: 'reasonCodes', flex: 1, minWidth: 150, tooltip: true, valueFormatter: (p) => (Array.isArray(p.value) ? p.value.join(', ') : '') },
      {
        headerName: 'Total',
        field: 'totalMinor',
        width: 108,
        type: 'rightAligned',
        valueFormatter: (p) => (typeof p.value === 'number' ? formatMoney(p.value, p.data?.currency ?? currency) : ''),
      },
    ],
    [now, currency],
  );

  if (load.kind === 'loading') return <p className="empty">Loading the dashboard.</p>;
  if (load.kind === 'error') return <p className="error" role="alert">{load.message}</p>;
  const { mandate, summary, items } = load;
  const segments = budgetSegments(summary);
  const counts = countBy(items);
  const pending = filterItems(items, 'waiting').filter((item) => item.status === 'PENDING_APPROVAL');
  const rows = filterItems(items, filter);
  const money = (minor: number) => formatMoney(minor, currency);

  return (
    <div className="dashboard">
      <header>
        <h1>{mandate.name}</h1>
        <p className="lede">
          {counts.all} requests so far. The guardrails stopped {summary.blocked} of them, and {summary.pendingApprovals} {summary.pendingApprovals === 1 ? 'is' : 'are'} waiting for {mandate.approver.displayName}.
        </p>
      </header>

      <section className="budget" aria-labelledby="budget-title">
        <h2 id="budget-title">Budget</h2>
        <div className="meter" role="img" aria-label={`${money(segments.committed)} spent, ${money(segments.held)} held, ${money(segments.remaining)} left of ${money(summary.budgetMinor)}`}>
          <span className="meter__spent" style={{ flexGrow: segments.shares[0] }} />
          <span className="meter__held" style={{ flexGrow: segments.shares[1] }} />
          <span className="meter__left" style={{ flexGrow: segments.shares[2] }} />
        </div>
        <dl className="budget__legend">
          <div>
            <dt><span className="key key--spent" />Spent</dt>
            <dd>{money(segments.committed)}</dd>
          </div>
          <div>
            <dt><span className="key key--held" />Held for orders in progress</dt>
            <dd>{money(segments.held)}</dd>
          </div>
          <div>
            <dt><span className="key key--left" />Left</dt>
            <dd>{money(segments.remaining)}</dd>
          </div>
          <div>
            <dt>Budget</dt>
            <dd>{money(summary.budgetMinor)}</dd>
          </div>
        </dl>
      </section>

      <div className="dashboard__pair">
        <section aria-labelledby="categories-title">
          <h2 id="categories-title">By category</h2>
          <ul className="cat-bars">
            {categoryRows(summary, mandate).map((row) => (
              <li key={row.category} className={row.allowed ? '' : 'cat-bars__blocked'}>
                <div className="cat-bars__label">
                  <span>{row.category}</span>
                  <span className="fine">
                    {!row.allowed ? 'Not allowed' : row.capMinor === null ? `${money(row.spentMinor + row.heldMinor)}, no cap` : `${money(row.spentMinor + row.heldMinor)} of ${money(row.capMinor)}`}
                  </span>
                </div>
                {row.allowed && row.share !== null && (
                  <span className="cat-bars__track">
                    <span className={row.share >= 0.9 ? 'cat-bars__fill cat-bars__fill--near' : 'cat-bars__fill'} style={{ width: `${Math.min(row.share, 1) * 100}%` }} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="pending-title">
          <h2 id="pending-title">Waiting for approval</h2>
          {pending.length === 0 ? (
            <p className="fine">Nothing is waiting. Large carts appear here until {mandate.approver.displayName} decides.</p>
          ) : (
            <ul className="queue">
              {pending.map((item) => (
                <li key={item.id}>
                  <a href={`#/purchases/${item.id}`}>{item.text}</a>
                  <span className="fine">
                    {item.requester}, waiting {age(item.createdAt, now)}
                    {item.totalMinor !== null ? `, ${money(item.totalMinor)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby="requests-title">
        <div className="requests__head">
          <h2 id="requests-title">Requests</h2>
          <div className="chips" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" className="chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label} <span className="chip__count">{counts[f.key]}</span>
              </button>
            ))}
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="empty">{filter === 'all' ? 'No requests yet. Ask for something on the New request screen.' : 'No requests in this group.'}</p>
        ) : (
          <div className="grid">
            <AgGridReact<PurchaseListItem>
              theme={gridTheme}
              rowData={rows}
              columnDefs={columns}
              getRowId={(p) => p.data.id}
              domLayout="autoHeight"
              onRowClicked={(e) => {
                if (e.data) window.location.hash = `#/purchases/${e.data.id}`;
              }}
              onCellKeyDown={(e) => {
                // Keyboard users open a request with Enter, like a click.
                if (e.event instanceof KeyboardEvent && e.event.key === 'Enter' && e.data) window.location.hash = `#/purchases/${e.data.id}`;
              }}
              rowClass="grid__row"
            />
          </div>
        )}
        <p className="fine">Select a row, or press Enter on it, to see the full decision and its audit trail. Updates every 15 seconds.</p>
      </section>
    </div>
  );
}
