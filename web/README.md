# Massy Purchasing — web frontend

Phase 0 authenticated shell (React 18 + TypeScript + Vite + Tailwind CSS v4).

## Commands

```
npm install       # install dependencies
npm run dev       # dev server on http://localhost:5173 (proxies /api -> http://localhost:3001)
npm run build     # typecheck + production build to web/dist
npm run typecheck # tsc --noEmit
```

## Notes

- Auth: the shell probes `GET /api/me`; 401 shows the login page whose
  "Sign in with Microsoft" button links to `/api/auth/login` (Entra ID OIDC,
  server-side).
- Acceptable-use banner (A.5.10): blocks all content until acknowledged via
  `POST /api/me/acknowledge-banner`.
- CSRF: token from `GET /api/csrf` is sent as `x-csrf-token` on every non-GET
  request (see `src/api/client.ts`).
- PWA: `public/manifest.webmanifest` makes the app installable via
  Edge → "Install this site as an app". No service worker in Phase 0.
