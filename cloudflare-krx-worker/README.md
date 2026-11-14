# Cloudflare KIS KRX collector

This Worker keeps KIS credentials on Cloudflare, subscribes to four KRX trade streams, and upserts quotes to the Campus League Supabase `market_quotes` table. It also retrieves daily bars for four KRX and four NASDAQ sample stocks every 15 minutes, so the site has the most recent completed daily price when a market is closed. The GitHub Pages site reads those rows through Supabase Realtime.

## Deploy from the existing GitHub repository

1. Push this folder to `jjanggoo5950-code/universe` at `cloudflare-krx-worker/`.
2. In Cloudflare, open **Workers & Pages → Create → Worker → Connect to Git** and select `jjanggoo5950-code/universe`.
3. Set the Worker name to `campus-league-krx-feed` and the **Root directory** to `cloudflare-krx-worker`. Leave the deploy command as `npx wrangler deploy`.
4. Finish the first deployment. In the Worker, open **Settings → Variables and Secrets → Add → Secret**. Add each of these names and paste its value directly into Cloudflare:
   - `KIS_APP_KEY` — KIS Developers app key
   - `KIS_APP_SECRET` — KIS Developers app secret
   - `SUPABASE_SECRET_KEY` — the Supabase `sb_secret_...` key
5. Save the secrets. Cloudflare will create a new Worker version. The cron trigger runs once per minute and starts or checks the collector. The Worker health page is `/health`.
6. In Cloudflare Workers Builds, confirm the first build after adding secrets succeeds. Then open `https://<worker-subdomain>.workers.dev/health`; it should report `connected` after a KRX tick arrives.

The Supabase project URL is deliberately part of the source because it is not a credential. No KIS or Supabase secret belongs in GitHub, `index.html`, or chat. Use the Supabase secret API key, not its publishable key, for this server-side writer.

## Required Supabase setup

Run `campus_league_setup.sql` in the Supabase SQL Editor first. It creates `market_quotes`, enables row level security, and adds the table to Supabase Realtime. The collector cannot publish until that table exists.

The real-time WebSocket subscribes to Samsung Electronics, SK hynix, NAVER, and Hyundai Motor (`005930`, `000660`, `035420`, `005380`). Daily snapshots include those KRX stocks and Apple, NVIDIA, Microsoft, and Tesla (`AAPL`, `NVDA`, `MSFT`, `TSLA`). Daily prices are marked `end_of_day` and are never tradable; only fresh KRX WebSocket ticks can enable Korean stock orders. USD/KRW remains a separate feed, and U.S. quotes are daily bars rather than real-time quotes.

## Notes

- `/health` exposes only service state and timestamps, never credentials.
- KIS WebSocket responses use the documented `H0STCNT0` trade stream. The collector reconnects after dropped connections and limits database writes to about one per symbol per second.
- The `/health` response includes the latest WebSocket tick and daily-snapshot refresh results. Daily quote dates come from KIS daily bars, rather than the time the Worker fetched them.
- Validate that the KIS account's API terms permit displaying the feed publicly before opening the league to visitors.

