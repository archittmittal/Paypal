import { MandateApi } from './api';

const env = import.meta.env;

export const API_URL: string = typeof env.VITE_API_URL === 'string' && env.VITE_API_URL !== '' ? env.VITE_API_URL : 'http://127.0.0.1:3000';
export const MANDATE_ID: string =
  typeof env.VITE_MANDATE_ID === 'string' && env.VITE_MANDATE_ID !== '' ? env.VITE_MANDATE_ID : '00000000-0000-4000-8000-000000000021';

export type Role = 'requester' | 'approver' | 'admin';

/**
 * The seeded demo people (apps/api/src/db/seed.ts). There is no sign-in yet (VERIFY/#10 follow-up): the UI
 * says who is acting, the API checks that person's organization and role.
 */
export const DEMO_PEOPLE: readonly { id: string; name: string; role: Role }[] = [
  { id: '00000000-0000-4000-8000-000000000011', name: 'Riya', role: 'requester' },
  { id: '00000000-0000-4000-8000-000000000012', name: 'Arjun', role: 'approver' },
  { id: '00000000-0000-4000-8000-000000000013', name: 'Meera', role: 'admin' },
];

export const api = new MandateApi(API_URL);
