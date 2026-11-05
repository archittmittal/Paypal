import { useEffect, useState } from 'react';
import { DEMO_PEOPLE } from './config';
import { MandateScreen } from './screens/MandateScreen';
import { PurchaseScreen } from './screens/PurchaseScreen';
import { RequestScreen } from './screens/RequestScreen';

export interface Route {
  path: string;
  label: string;
}

export const ROUTES: Route[] = [
  { path: '#/request', label: 'New request' },
  { path: '#/mandate', label: 'Mandate' },
];

const PURCHASE_ROUTE = /^#\/purchases\/([0-9a-f-]{36})$/;

/** Hash routes keep the static build host-agnostic: no server rewrites needed. */
export function resolvePath(hash: string): string {
  if (ROUTES.some((route) => route.path === hash) || PURCHASE_ROUTE.test(hash)) return hash;
  return '#/request';
}

const currentPath = () => resolvePath(window.location.hash);

export function App() {
  const [path, setPath] = useState(currentPath);
  const [actorId, setActorId] = useState(DEMO_PEOPLE[0]?.id ?? '');

  useEffect(() => {
    const onHash = () => setPath(currentPath());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <a className="brand" href="#/request">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r="11" />
            <path d="M11 16.5l3.4 3.4L21 13" />
          </svg>
          Mandate
        </a>
        <ul>
          {ROUTES.map((route) => (
            <li key={route.path}>
              <a href={route.path} aria-current={route.path === path ? 'page' : undefined}>
                {route.label}
              </a>
            </li>
          ))}
        </ul>
        <label className="actor">
          <span>Acting as</span>
          <select value={actorId} onChange={(event) => setActorId(event.target.value)}>
            {DEMO_PEOPLE.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}, {person.role}
              </option>
            ))}
          </select>
          <span className="fine">Demo people. Sign-in comes later.</span>
        </label>
      </nav>
      <main className="page">
        {path === '#/request' && <RequestScreen requesterId={actorId} />}
        {path === '#/mandate' && <MandateScreen actorId={actorId} />}
        {PURCHASE_ROUTE.test(path) && <PurchaseScreen purchaseId={PURCHASE_ROUTE.exec(path)?.[1] ?? ''} />}
      </main>
    </div>
  );
}
