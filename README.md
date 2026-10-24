# Crazy777 demo backend

This is a TypeScript/Express/Socket.IO integration backend for the Unity client. It is deliberately **play-credit only**: balances are labeled `DEMO`, cannot be redeemed, and there is no payment, cash-out, or real-money wager endpoint. It is not a deployment-ready gambling or payments system.

## Setup

1. Create a Supabase project. In its SQL editor, run `schema.sql`, then `start.sql`. Re-run `schema.sql` after backend schema/game-rule updates to apply the idempotent bet/free-spin migrations.
2. Copy `.env.example` to `.env`; enter the project URL, anon key and service-role key. Keep `.env` out of source control and never put the service-role key in Unity or a browser.
3. Install and start:

   ```powershell
   npm install
   npm run dev
   ```

4. Create a demo account with `POST http://localhost:5000/api/auth/signup` using JSON such as `{"email":"player@example.test","password":"a-long-demo-password","username":"Player"}`. If Supabase email confirmation is enabled, confirm the account and log in at `/api/auth/login`.
5. In Unity Editor, set `SocketIOManager.testToken` to the returned Supabase `accessToken`. The editor socket URL is already `http://localhost:5000`. WebGL obtains the token and socket URL from its host page.
6. To build and run the backend tests: `npm run build` and `npm test`.

For local test users, open `http://localhost:5000/admin`, enter `DEV_ADMIN_KEY`, and create a player. Copy the one-time access token shown into Unity's `SocketIOManager.testToken`; select a player in the list to adjust that player's demo credits or enable/disable the account. Keep the admin page local and never configure this development admin key in a production deployment.

Supabase Auth creates the profile and the initial 100.00 DEMO-credit wallet through the trigger in `schema.sql`. Disable email confirmation only for a controlled local demo if that is useful; do not weaken production authentication.

Express and Socket.IO accept requests from any origin and reflect the requesting origin to support credentialed browser requests. CORS is not authentication or API access control: keep protected routes authenticated, and restrict origins before deploying publicly if client origins are known.

## Routes

- `POST /api/auth/signup` and `POST /api/auth/login`: Supabase Auth user creation/session.
- `GET /api/profile`: authenticated profile and non-redeemable demo-credit totals.
- `GET /api/health`: health check.
- `GET /admin`: development-only single-page admin panel. It can create test players, issue a Supabase access token for Unity, list the first 100 auth accounts, enable/disable accounts, and adjust demo credits. Admin API calls require `x-dev-admin-key`; each credit adjustment is recorded.
- Socket.IO: auth `{ "token": "<Supabase access token>", "gameId": "SL-CRZ" }`; the server emits typed JSON objects rather than JSON-encoded strings on `message`, to match the Unity client's `On<Root>` subscription. Message shapes are described in `PARSE-SHEET.txt`.

Production starts with demo spins disabled. To run a free-to-play demo in a production environment, explicitly set `DEMO_CREDITS_ENABLED=true`; this still enables **only** non-redeemable demo credits and does not enable purchases or real-money play.

## Atomic balance and result processing

PostgreSQL `play_demo_spin` acquires an advisory lock for the user's request ID, locks that player's wallet row, checks funds, updates the balance, records the spin and writes ledger entries within one database transaction. A repeated UUID returns the original spin. Amounts are integer hundredths, not JavaScript floating-point wallet math. The Unity client now creates a UUID per spin and sends the selected bet index and free-spin flag.

The demo publishes 15 per-line bet amounts from 0.20 through 3.00 DEMO credits in 0.20 increments (0.60 to 9.00 per paid spin across three lines). A higher bet ladder increases the credit amount at risk; it does not itself make the game profitable or change its return percentage. Only the first three symbols in the middle row affect rewards. Any all-nonzero trio receives a base reward: a matching triple uses its symbol multiplier (3/2/1/1/1 for IDs 1-5), while a non-matching trio returns 0.25 times the per-line bet. A zero in any of those three positions awards nothing. In both cases, the fourth middle-row symbol applies its bonus: IDs 6/7/8 multiply the base reward by 10/5/2; ID 9 adds 2 times the per-line bet; ID 10 adds 1 times the per-line bet. ID 11 awards free spins only for a matching triple. Free-spin awards are 15/10/5/3/1 for triples of IDs 1/2/3/4/5 respectively (so 2,2,2 awards 10). Free spins deduct no wager, can pay rewards, and can retrigger on the same RESPIN rule. These are demo rules, not certified game math; no 90% RTP or operator-profit guarantee is made for this expanded ruleset. Outcomes do not adapt to player history, and the backend does not implement behavioral targeting or loss-chasing mechanics.

Before any real-money product is considered, it requires independent legal/licensing review, jurisdiction-specific compliance, certified RNG/game math, responsible-play protections, auditable operations, and a separately designed payment system. This code does not provide those capabilities.
