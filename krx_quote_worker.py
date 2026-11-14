"""Stream KRX trade ticks from KIS and publish quote snapshots to Supabase.

Keep KIS_APP_KEY, KIS_APP_SECRET, and SUPABASE_SECRET_KEY in the worker's
environment. Never put them in index.html, GitHub, or a browser.

Run this as a long-lived backend process, not on GitHub Pages:
    python krx_quote_worker.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone

import aiohttp
import websockets


logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("campus-league-krx")

KIS_REST_URL = os.getenv("KIS_REST_URL", "https://openapi.koreainvestment.com:9443")
KIS_WS_URL = os.getenv("KIS_WS_URL", "ws://ops.koreainvestment.com:21000/tryitout")
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://cxgrrdxjrqxoayeknqkk.supabase.co").rstrip("/")
KIS_APP_KEY = os.getenv("KIS_APP_KEY", "")
KIS_APP_SECRET = os.getenv("KIS_APP_SECRET", "")
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY", "")
KRX_SYMBOLS = [
    value.strip()
    for value in os.getenv("KRX_SYMBOLS", "005930,000660,035420,005380").split(",")
    if value.strip()
]
STOCK_NAMES = {
    "005930": "삼성전자",
    "000660": "SK하이닉스",
    "035420": "NAVER",
    "005380": "현대차",
}
TR_ID = "H0STCNT0"


def require_configuration() -> None:
    missing = [
        name
        for name, value in (
            ("KIS_APP_KEY", KIS_APP_KEY),
            ("KIS_APP_SECRET", KIS_APP_SECRET),
            ("SUPABASE_SECRET_KEY", SUPABASE_SECRET_KEY),
        )
        if not value
    ]
    if missing:
        raise SystemExit("Missing required environment variables: " + ", ".join(missing))
    if not KRX_SYMBOLS:
        raise SystemExit("KRX_SYMBOLS must include at least one listed stock code.")


async def get_approval_key(session: aiohttp.ClientSession) -> str:
    url = KIS_REST_URL + "/oauth2/Approval"
    payload = {
        "grant_type": "client_credentials",
        "appkey": KIS_APP_KEY,
        "secretkey": KIS_APP_SECRET,
    }
    async with session.post(
        url,
        json=payload,
        headers={"content-type": "application/json; charset=utf-8"},
    ) as response:
        if response.status != 200:
            logger.error("KIS WebSocket approval failed (HTTP %s).", response.status)
            raise RuntimeError("KIS did not issue a WebSocket approval key.")
        body = await response.json()
    approval_key = body.get("approval_key")
    if not approval_key:
        raise RuntimeError("KIS response did not include an approval key.")
    return approval_key


def parse_tick(raw: str) -> dict | None:
    """Decode a KIS H0STCNT0 pipe/caret tick using the official field order."""
    parts = raw.split("|", 3)
    if len(parts) != 4 or parts[1] != TR_ID:
        return None
    for record in parts[3].split("|"):
        fields = record.split("^")
        if len(fields) < 6:
            continue
        symbol = fields[0].strip()
        if symbol not in KRX_SYMBOLS:
            continue
        try:
            price = float(fields[2])
            change_pct = float(fields[5])
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        now = datetime.now(timezone.utc).isoformat()
        return {
            "symbol": symbol,
            "market": "KR",
            "name": STOCK_NAMES.get(symbol, symbol),
            "price": price,
            "currency": "KRW",
            "change_pct": change_pct,
            "source": "KIS_KRX_WEBSOCKET",
            "freshness": "real_time",
            "is_tradable": True,
            "as_of": now,
            "updated_at": now,
        }
    return None


async def publish_quotes(session: aiohttp.ClientSession, quotes: list[dict]) -> None:
    if not quotes:
        return
    url = SUPABASE_URL + "/rest/v1/market_quotes?on_conflict=symbol"
    headers = {
        "apikey": SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    async with session.post(url, json=quotes, headers=headers) as response:
        if response.status >= 300:
            logger.error("Supabase quote write failed (HTTP %s).", response.status)
            await response.read()
            return
    logger.info("Published %s KRX quote(s).", len(quotes))


async def stream_once(session: aiohttp.ClientSession) -> None:
    approval_key = await get_approval_key(session)
    latest: dict[str, dict] = {}
    last_publish = time.monotonic()
    async with websockets.connect(KIS_WS_URL, ping_interval=None, close_timeout=5) as socket:
        for symbol in KRX_SYMBOLS:
            request = {
                "header": {
                    "approval_key": approval_key,
                    "content-type": "utf-8",
                    "tr_type": "1",
                    "custtype": "P",
                },
                "body": {"input": {"tr_id": TR_ID, "tr_key": symbol}},
            }
            await socket.send(json.dumps(request))
            await asyncio.sleep(0.15)
        logger.info("Subscribed to KRX WebSocket for %s symbol(s).", len(KRX_SYMBOLS))

        async for raw in socket:
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="replace")
            if raw.startswith("{"):
                try:
                    response = json.loads(raw)
                    if response.get("header", {}).get("tr_id") == "PINGPONG":
                        await socket.pong(raw.encode("utf-8"))
                except (json.JSONDecodeError, TypeError):
                    logger.warning("Received an unreadable KIS control message.")
                continue

            quote = parse_tick(raw)
            if quote:
                latest[quote["symbol"]] = quote
            if latest and time.monotonic() - last_publish >= 1.0:
                await publish_quotes(session, list(latest.values()))
                latest.clear()
                last_publish = time.monotonic()


async def main() -> None:
    require_configuration()
    timeout = aiohttp.ClientTimeout(total=12)
    backoff = 2
    async with aiohttp.ClientSession(timeout=timeout) as session:
        while True:
            try:
                await stream_once(session)
                backoff = 2
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.error("KRX feed stopped (%s); reconnecting in %s seconds.", type(error).__name__, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    asyncio.run(main())

