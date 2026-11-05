import { useEffect, useState } from 'react';
import { DEMO_PEOPLE } from './config';
import { RequestScreen } from './screens/RequestScreen';

export interface Route {
  path: string;
  label: string;
}

export const ROUTES: Route[] = [{ path: '#/request', label: 'New request' }];

function currentPath(): string {
  return ROUTES.some((route) => route.path === window.location.hash) ? window.location.hash : '#/request';
}

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
      <main className="page">{path === '#/request' && <RequestScreen requesterId={actorId} />}</main>
    </div>
  );
}
