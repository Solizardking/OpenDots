import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
  fetchOptions: { credentials: 'same-origin' },
});
