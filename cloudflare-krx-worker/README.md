# Cloudflare KIS KRX collector

This Worker keeps KIS credentials on Cloudflare and upserts quotes to the Campus League market_quotes table. It streams four baseline KRX stocks, refreshes daily bars for four Korean and four U.S. sample stocks, and refreshes the USD/KRW rate once per minute through KIS FX index data. The public GET /quote endpoint fetches a selected listed stock on demand, so the site can search the stock catalog without requesting thousands of prices at once. During regular sessions it uses KIS current-price endpoints; outside sessions it retains the latest available quote and shows its timestamp. The site reads stored quotes through Supabase Realtime.

## Deploy from the existing GitHub repository

1. Push this folder to `kkaaoo1/universe` at `cloudflare-krx-worker/`.
2. In Cloudflare, open **Workers & Pages → Create → Worker → Connect to Git** and select `kkaaoo1/universe`.
3. Set the Worker name to `campus-league-krx-feed` and the **Root directory** to `cloudflare-krx-worker`. Leave the deploy command as `npx wrangler deploy`.
4. Finish the first deployment. In the Worker, open **Settings → Variables and Secrets → Add → Secret**. Add each of these names and paste its value directly into Cloudflare:
   - `KIS_APP_KEY` — KIS Developers app key
   - `KIS_APP_SECRET` — KIS Developers app secret
   - `SUPABASE_SECRET_KEY` — the Supabase `sb_secret_...` key
5. Save the secrets. Cloudflare will create a new Worker version. The cron trigger runs once per minute and starts or checks the collector. `/health` reports collector status, stock snapshots, and the latest FX refresh, and `/quote?market=KR&symbol=005930&exchange=&name=Samsung` fetches a selected quote. The quote endpoint is limited to 30 requests per IP per minute.
6. In Cloudflare Workers Builds, confirm the first build after adding secrets succeeds. Then open `https://<worker-subdomain>.workers.dev/health`; it should report `connected` after a KRX tick arrives.

The Supabase project URL is deliberately part of the source because it is not a credential. No KIS or Supabase secret belongs in GitHub, `index.html`, or chat. Use the Supabase secret API key, not its publishable key, for this server-side writer.

## Required Supabase setup

Run `campus_league_setup.sql` in the Supabase SQL Editor first. It creates `market_quotes`, enables row level security, and adds the table to Supabase Realtime. The collector cannot publish until that table exists.

The real-time WebSocket subscribes to Samsung Electronics, SK hynix, NAVER, and Hyundai Motor (`005930`, `000660`, `035420`, `005380`). Daily snapshots include those KRX stocks and Apple, NVIDIA, Microsoft, and Tesla (`AAPL`, `NVDA`, `MSFT`, `TSLA`). Other listed stocks are fetched only when a visitor selects them from search. KIS current-price responses are quote data only; no KIS buy or sell endpoints are called. The site uses Supabase's `execute_campus_order` RPC for simulated orders. Daily prices are marked `end_of_day`, are non-tradable, and remain available for price display after market close. USD/KRW is published by this Worker as a separate FX quote.

## Notes

- `/health` exposes only service state and timestamps, never credentials.
- KIS WebSocket responses use the documented `H0STCNT0` trade stream. The collector reconnects after dropped connections and limits database writes to about one per symbol per second.
- The `/health` response includes the latest WebSocket tick and daily-snapshot refresh results. Daily quote dates come from KIS daily bars, rather than the time the Worker fetched them.
- Validate that the KIS account's API terms permit displaying the feed publicly before opening the league to visitors.


운영/장애 처리와 검증: [docs/OPERATIONS.md](../docs/OPERATIONS.md).
