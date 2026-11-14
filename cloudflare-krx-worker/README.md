# Cloudflare KIS KRX collector

This Worker keeps KIS credentials on Cloudflare, subscribes to four KRX trade streams, and upserts real-time quote snapshots to the Campus League Supabase `market_quotes` table. The GitHub Pages site reads those rows through Supabase Realtime.

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

The first version subscribes to Samsung Electronics, SK hynix, NAVER, and Hyundai Motor (`005930`, `000660`, `035420`, `005380`). It only writes KRX prices. U.S. equity and USD/KRW feeds are separate integrations and remain unavailable until configured.

## Notes

- `/health` exposes only service state and timestamps, never credentials.
- KIS WebSocket responses use the documented `H0STCNT0` trade stream. The collector reconnects after dropped connections and limits database writes to about one per symbol per second.
- Validate that the KIS account's API terms permit displaying the feed publicly before opening the league to visitors.

