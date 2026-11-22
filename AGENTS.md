# SITCON Game

- This repo contains the TypeScript/Fastify API (`backend/gateway/`) and Next.js admin dashboard (`frontend/`). The Flutter app and its Dart offline engine belong in `2027-game-app`; do not copy them here.
- Run `npm run dev` from the root for a local-only stack. Use `npm run typecheck && npm test` in `backend/gateway/` for backend changes and `npm run build && npm test` in `frontend/` for dashboard changes.
- Preserve mobile API wire formats, device-session behavior, role checks, and the PostgreSQL state format. Update migrations and add compatibility coverage when changing stored data.
- Keep the API and dashboard as separate Dockerfile Applications. Protect deployed admin routes with credentials and HTTPS; never commit credentials, private endpoints, or local database files.
