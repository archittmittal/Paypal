import { type FormEvent, useEffect, useState } from 'react';
import type { MandateView } from '../api';
import { api, DEMO_PEOPLE, MANDATE_ID } from '../config';
import { errorText } from '../copy';
import { type FieldErrors, fromForm, type MandateForm, toForm } from '../mandateForm';

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; mandate: MandateView };

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The rules the agent works under. Only an admin can change them; every change is audited. */
export function MandateScreen({ actorId }: { actorId: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [form, setForm] = useState<MandateForm | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const actor = DEMO_PEOPLE.find((person) => person.id === actorId);
  const canEdit = actor?.role === 'admin';

  useEffect(() => {
    let live = true;
    api
      .getMandate(MANDATE_ID)
      .then((mandate) => {
        if (!live) return;
        setLoad({ kind: 'ready', mandate });
        setForm(toForm(mandate));
      })
      .catch((error: unknown) => live && setLoad({ kind: 'error', message: errorText(error) }));
    return () => {
      live = false;
    };
  }, []);

  if (load.kind === 'loading') return <p className="empty">Loading the mandate.</p>;
  if (load.kind === 'error') return <p className="error" role="alert">{load.message}</p>;
  if (!form) return null;
  const { mandate } = load;

  const set = <K extends keyof MandateForm>(key: K, value: MandateForm[K]) => setForm({ ...form, [key]: value });
  const setRow = (index: number, patch: Partial<MandateForm['categories'][number]>) =>
    set('categories', form.categories.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    const result = fromForm(form, mandate.currency);
    setErrors(result.ok ? {} : result.errors);
    setNotice(null);
    if (!result.ok) return;
    setSaving(true);
    try {
      const updated = await api.updateMandate(MANDATE_ID, actorId, result.change);
      setLoad({ kind: 'ready', mandate: updated });
      setForm(toForm(updated));
      setNotice({ kind: 'ok', text: 'Mandate saved. New requests are checked against these rules.' });
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) });
    } finally {
      setSaving(false);
    }
  }

  const money = (key: 'budget' | 'perItemCap' | 'approvalThreshold', label: string, hint: string) => (
    <div className="field">
      <label htmlFor={key}>{label}</label>
      <div className="money-input">
        <span aria-hidden="true">{mandate.currency}</span>
        <input id={key} inputMode="decimal" value={form[key]} onChange={(e) => set(key, e.target.value)} disabled={!canEdit} aria-describedby={`${key}-hint`} aria-invalid={Boolean(errors[key])} />
      </div>
      <p id={`${key}-hint`} className={errors[key] ? 'field__error' : 'fine'}>
        {errors[key] ?? hint}
      </p>
    </div>
  );

  return (
    <form className="mandate" onSubmit={(event) => void save(event)} noValidate>
      <header className="mandate__head">
        <h1>{mandate.name}</h1>
        <p className="lede">
          Runs {DATE.format(new Date(mandate.startsAt))} to {DATE.format(new Date(mandate.endsAt))}. Requests above the approval threshold go to{' '}
          {mandate.approver.displayName}. Policy {mandate.policyVersion}.
        </p>
        {!canEdit && <p className="notice">You can read these rules. Only an admin can change them: switch to Meera, admin, to edit.</p>}
      </header>

      <fieldset disabled={!canEdit || saving}>
        <legend>Spending limits</legend>
        <div className="grid-fields">
          {money('budget', 'Budget', 'Everything bought under this mandate, including orders in progress.')}
          {money('perItemCap', 'Per-item cap', 'The most one line may cost: unit price times quantity.')}
          {money('approvalThreshold', 'Approval threshold', 'Carts at or above this go to the approver.')}
          <div className="field">
            <label htmlFor="maxQuantityPerLine">Most units per line</label>
            <input id="maxQuantityPerLine" inputMode="numeric" value={form.maxQuantityPerLine} onChange={(e) => set('maxQuantityPerLine', e.target.value)} aria-invalid={Boolean(errors.maxQuantityPerLine)} />
            <p className={errors.maxQuantityPerLine ? 'field__error' : 'fine'}>{errors.maxQuantityPerLine ?? 'Larger quantities are denied as implausible.'}</p>
          </div>
          <div className="field">
            <label htmlFor="status">Status</label>
            <select id="status" value={form.status} onChange={(e) => set('status', e.target.value as MandateForm['status'])}>
              <option value="ACTIVE">Active: requests are checked and paid</option>
              <option value="PAUSED">Paused: every request is denied</option>
              <option value="CLOSED">Closed</option>
            </select>
          </div>
        </div>
      </fieldset>

      <fieldset disabled={!canEdit || saving}>
        <legend>Categories</legend>
        <p className="fine">The catalog assigns each product a category. Anything not listed here as allowed is denied.</p>
        <table className="categories">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Allowed</th>
              <th scope="col">Cap ({mandate.currency}, optional)</th>
              <th scope="col">
                <span className="visually-hidden">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {form.categories.map((row, index) => (
              <tr key={index}>
                <td>
                  <input aria-label={`Category ${index + 1}`} value={row.category} onChange={(e) => setRow(index, { category: e.target.value })} aria-invalid={Boolean(errors.categories?.[index])} />
                  {errors.categories?.[index] && <p className="field__error">{errors.categories[index]}</p>}
                </td>
                <td>
                  <input type="checkbox" aria-label={`Allow ${row.category || `category ${index + 1}`}`} checked={row.allowed} onChange={(e) => setRow(index, { allowed: e.target.checked })} />
                </td>
                <td>
                  <input aria-label={`Cap for ${row.category || `category ${index + 1}`}`} inputMode="decimal" value={row.cap} onChange={(e) => setRow(index, { cap: e.target.value })} disabled={!row.allowed} placeholder="No cap" />
                </td>
                <td>
                  <button type="button" className="link" onClick={() => set('categories', form.categories.filter((_, i) => i !== index))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="button" onClick={() => set('categories', [...form.categories, { category: '', allowed: true, cap: '' }])}>
          Add a category
        </button>
      </fieldset>

      {canEdit && (
        <div className="actions">
          <button type="submit" className="button button--primary" disabled={saving}>
            {saving ? 'Saving' : 'Save mandate'}
          </button>
          <button type="button" className="button" onClick={() => { setForm(toForm(mandate)); setErrors({}); setNotice(null); }} disabled={saving}>
            Discard changes
          </button>
        </div>
      )}
      {notice && (
        <p className={notice.kind === 'ok' ? 'notice notice--ok' : 'error'} role={notice.kind === 'ok' ? 'status' : 'alert'}>
          {notice.text}
        </p>
      )}
    </form>
  );
}
