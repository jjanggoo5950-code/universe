const KIS_REST_URL = "https://openapi.koreainvestment.com:9443";
const KIS_WS_URL = "ws://ops.koreainvestment.com:21000/tryitout";
const SUPABASE_PROJECT_URL = "https://cxgrrdxjrqxoayeknqkk.supabase.co";
const KRX_SYMBOLS = ["005930", "000660", "035420", "005380"];
const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
const SNAPSHOT_ASSETS = [
  { symbol: "005930", market: "KR", name: "삼성전자", currency: "KRW" },
  { symbol: "000660", market: "KR", name: "SK하이닉스", currency: "KRW" },
  { symbol: "035420", market: "KR", name: "NAVER", currency: "KRW" },
  { symbol: "005380", market: "KR", name: "현대차", currency: "KRW" },
  { symbol: "AAPL", market: "US", name: "Apple", currency: "USD", exchange: "NAS" },
  { symbol: "NVDA", market: "US", name: "NVIDIA", currency: "USD", exchange: "NAS" },
  { symbol: "MSFT", market: "US", name: "Microsoft", currency: "USD", exchange: "NAS" },
  { symbol: "TSLA", market: "US", name: "Tesla", currency: "USD", exchange: "NAS" },
];
const STOCK_NAMES = Object.fromEntries(SNAPSHOT_ASSETS.map((asset) => [asset.symbol, asset.name]));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/health" || request.method !== "GET") {
      return new Response("Not found", { status: 404 });
    }

    const id = env.KIS_COLLECTOR.idFromName("krx-main");
    const response = await env.KIS_COLLECTOR.get(id).fetch("https://collector.internal/status");
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  },

  async scheduled(_controller, env, ctx) {
    const id = env.KIS_COLLECTOR.idFromName("krx-main");
    ctx.waitUntil(
      env.KIS_COLLECTOR.get(id)
        .fetch("https://collector.internal/ensure", { method: "POST" })
        .then(async (response) => {
          if (!response.ok) console.error("KIS collector ensure failed", response.status);
        })
        .catch((error) => console.error("KIS collector ensure failed", error?.name || "Error")),
    );
  },
};

export class KisCollector {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.socket = null;
    this.connecting = null;
    this.status = "starting";
    this.lastTickAt = null;
    this.lastError = null;
      this.lastSnapshotAt = null;
      this.lastSnapshotError = null;
      this.snapshotsRefreshing = null;
    this.lastPublishedAt = new Map();
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/status" && request.method === "GET") {
      const savedSnapshotStatus = await this.ctx.storage.get("dailySnapshotStatus");
      return Response.json({
        service: "KIS KRX quote collector",
        status: this.status,
        realtime_kr_symbols: KRX_SYMBOLS,
        daily_snapshot_symbols: SNAPSHOT_ASSETS.map((asset) => asset.symbol),
        last_tick_at: this.lastTickAt,
        last_error: this.lastError,
        last_snapshot_at: this.lastSnapshotAt || savedSnapshotStatus?.at || null,
        last_snapshot_error: this.lastSnapshotError ?? savedSnapshotStatus?.error ?? null,
      });
    }

    // This route is reached only through the Worker binding, never from a public route.
    if (path === "/ensure" && request.method === "POST") {
      try {
        await this.refreshDailySnapshotsIfDue();
      } catch (error) {
        this.lastSnapshotError = this.safeError(error);
        await this.ctx.storage.put("dailySnapshotStatus", {
          at: new Date().toISOString(),
          error: this.lastSnapshotError,
        });
      }

      try {
        await this.ensureConnected();
        return Response.json({
          status: this.status,
          last_snapshot_at: this.lastSnapshotAt,
          last_snapshot_error: this.lastSnapshotError,
        });
      } catch (error) {
        this.status = "error";
        this.lastError = this.safeError(error);
        await this.scheduleReconnect();
        return Response.json({
          status: this.status,
          error: this.lastError,
          last_snapshot_at: this.lastSnapshotAt,
          last_snapshot_error: this.lastSnapshotError,
        }, { status: 503 });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    try {
      await this.refreshDailySnapshotsIfDue();
    } catch (error) {
      this.lastSnapshotError = this.safeError(error);
      await this.ctx.storage.put("dailySnapshotStatus", {
        at: new Date().toISOString(),
        error: this.lastSnapshotError,
      });
    }

    try {
      await this.ensureConnected();
    } catch (error) {
      this.status = "error";
      this.lastError = this.safeError(error);
      await this.scheduleReconnect();
    }
  }

  async ensureConnected() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.connecting) return this.connecting;

    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async connect() {
    this.requireSecrets();
    this.status = "connecting";
    this.lastError = null;

    const approvalResponse = await fetch(`${KIS_REST_URL}/oauth2/Approval`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: this.env.KIS_APP_KEY,
        secretkey: this.env.KIS_APP_SECRET,
      }),
    });
    if (!approvalResponse.ok) throw new Error(`kis_approval_http_${approvalResponse.status}`);
    const approvalBody = await approvalResponse.json();
    if (typeof approvalBody.approval_key !== "string" || !approvalBody.approval_key) {
      throw new Error("kis_approval_key_missing");
    }

    const socket = new WebSocket(KIS_WS_URL);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data).catch((error) => {
        this.lastError = this.safeError(error);
      });
    });
    socket.addEventListener("close", () => {
      this.socket = null;
      this.status = "disconnected";
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      this.lastError = "kis_websocket_error";
      try { socket.close(); } catch { /* already closed */ }
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("kis_websocket_open_timeout")), 15_000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("kis_websocket_open_failed")); }, { once: true });
    });

    for (const symbol of KRX_SYMBOLS) {
      socket.send(JSON.stringify({
        header: {
          approval_key: approvalBody.approval_key,
          "content-type": "utf-8",
          tr_type: "1",
          custtype: "P",
        },
        body: { input: { tr_id: "H0STCNT0", tr_key: symbol } },
      }));
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    this.status = "connected";
    this.lastError = null;
  }

  requireSecrets() {
    const missing = ["KIS_APP_KEY", "KIS_APP_SECRET", "SUPABASE_SECRET_KEY"]
      .filter((name) => !this.env[name]);
    if (missing.length) throw new Error(`missing_worker_secret_${missing.join("_")}`);
  }

  async handleMessage(data) {
    const raw = typeof data === "string" ? data : new TextDecoder().decode(data);
    if (raw.startsWith("{")) {
      let control;
      try { control = JSON.parse(raw); } catch { return; }
      if (control?.header?.tr_id === "PINGPONG" && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(raw);
      }
      return;
    }

    const quote = this.parseTick(raw);
    if (!quote) return;
    this.lastTickAt = quote.as_of;

    const now = Date.now();
    if (now - (this.lastPublishedAt.get(quote.symbol) || 0) < 950) return;
    this.lastPublishedAt.set(quote.symbol, now);
    await this.publishQuote(quote);
  }

  parseTick(raw) {
    const parts = raw.split("|", 4);
    if (parts.length < 4 || parts[1] !== "H0STCNT0") return null;
    const fields = parts[3].split("^");
    if (fields.length < 6) return null;

    const symbol = fields[0]?.trim();
    if (!KRX_SYMBOLS.includes(symbol)) return null;
    const price = Number(fields[2]);
    const changePct = Number(fields[5]);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(changePct)) return null;

    const now = new Date().toISOString();
    return {
      symbol,
      market: "KR",
      name: STOCK_NAMES[symbol],
      price,
      currency: "KRW",
      change_pct: changePct,
      source: "KIS_KRX_WEBSOCKET",
      freshness: "real_time",
      is_tradable: true,
      as_of: now,
      updated_at: now,
    };
  }

  async refreshDailySnapshotsIfDue() {
    if (this.snapshotsRefreshing) return this.snapshotsRefreshing;
    const now = Date.now();
    const lastAttempt = Number(await this.ctx.storage.get("dailySnapshotAttemptAt") || 0);
    const savedStatus = await this.ctx.storage.get("dailySnapshotStatus");
    const retryInterval = savedStatus?.error ? 2 * 60 * 1000 : SNAPSHOT_INTERVAL_MS;
    if (now - lastAttempt < retryInterval) return;

    this.snapshotsRefreshing = this.refreshDailySnapshots(now);
    try {
      await this.snapshotsRefreshing;
    } finally {
      this.snapshotsRefreshing = null;
    }
  }

  async refreshDailySnapshots(now) {
    // Save the attempt time before network calls to avoid duplicate KIS requests
    // if another scheduled invocation reaches this Durable Object concurrently.
    await this.ctx.storage.put("dailySnapshotAttemptAt", now);
    const errors = [];
    try {
      const accessToken = await this.getRestAccessToken();
      for (const asset of SNAPSHOT_ASSETS) {
        if (asset.market === "KR" && now - (this.lastPublishedAt.get(asset.symbol) || 0) < 3 * 60 * 1000) {
          continue;
        }
        try {
          const quote = await this.fetchDailySnapshot(accessToken, asset);
          if (!quote) throw new Error("quote_not_returned");
          const published = await this.publishQuote(quote);
          if (!published) errors.push(`${asset.symbol}:supabase_write_failed`);
        } catch (error) {
          errors.push(`${asset.symbol}:${this.safeError(error)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    } catch (error) {
      errors.push(this.safeError(error));
    }

    this.lastSnapshotAt = new Date().toISOString();
    this.lastSnapshotError = errors.length ? errors.slice(0, 8).join("; ").slice(0, 500) : null;
    await this.ctx.storage.put("dailySnapshotStatus", {
      at: this.lastSnapshotAt,
      error: this.lastSnapshotError,
    });
  }

  async getRestAccessToken() {
    const cached = await this.ctx.storage.get("kisRestAccessToken");
    if (cached?.value && Number(cached.expiresAt) > Date.now() + 60_000) return cached.value;

    const response = await fetch(`${KIS_REST_URL}/oauth2/tokenP`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: this.env.KIS_APP_KEY,
        appsecret: this.env.KIS_APP_SECRET,
      }),
    });
    if (!response.ok) throw new Error(`kis_rest_token_http_${response.status}`);
    const body = await response.json();
    if (!body.access_token) throw new Error(`kis_rest_token_${body.error_code || "missing"}`);
    const expiresIn = Math.max(300, Number(body.expires_in) || 86_400);
    const tokenData = { value: body.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    await this.ctx.storage.put("kisRestAccessToken", tokenData);
    return tokenData.value;
  }

  async fetchDailySnapshot(accessToken, asset) {
    const headers = {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${accessToken}`,
      appkey: this.env.KIS_APP_KEY,
      appsecret: this.env.KIS_APP_SECRET,
      custtype: "P",
    };
    const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    let url;
    if (asset.market === "KR") {
      const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll("-", "");
      url = new URL(`${KIS_REST_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`);
      url.search = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: asset.symbol,
        FID_INPUT_DATE_1: start,
        FID_INPUT_DATE_2: today,
        FID_PERIOD_DIV_CODE: "D",
        FID_ORG_ADJ_PRC: "1",
      }).toString();
      headers.tr_id = "FHKST03010100";
    } else {
      url = new URL(`${KIS_REST_URL}/uapi/overseas-price/v1/quotations/dailyprice`);
      url.search = new URLSearchParams({
        AUTH: "",
        EXCD: asset.exchange,
        SYMB: asset.symbol,
        GUBN: "0",
        BYMD: today,
        MODP: "0",
      }).toString();
      headers.tr_id = "HHDFS76240000";
    }

    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`kis_${asset.market.toLowerCase()}_daily_http_${response.status}`);
    const body = await response.json();
    if (String(body.rt_cd) !== "0") throw new Error(`kis_${asset.market.toLowerCase()}_daily_${body.msg_cd || body.rt_cd || "error"}`);

    const rows = Array.isArray(body.output2) ? body.output2 : body.output2 ? [body.output2] : [];
    const dailyBars = rows.map((row) => ({
      row,
      date: String(asset.market === "KR" ? row.stck_bsop_date : row.xymd || ""),
      price: Number(asset.market === "KR" ? row.stck_clpr : row.clos),
    })).filter((bar) => /^\d{8}$/.test(bar.date) && Number.isFinite(bar.price) && bar.price > 0)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (!dailyBars.length) throw new Error(`kis_${asset.market.toLowerCase()}_daily_empty`);

    const latest = dailyBars[0];
    const previous = dailyBars.find((bar) => bar.date < latest.date);
    const changePct = previous?.price
      ? ((latest.price - previous.price) / previous.price) * 100
      : Number(asset.market === "KR" ? latest.row.prdy_ctrt : latest.row.rate) || 0;
    const dateIso = `${latest.date.slice(0, 4)}-${latest.date.slice(4, 6)}-${latest.date.slice(6, 8)}T12:00:00.000Z`;

    return {
      symbol: asset.symbol,
      market: asset.market,
      name: asset.name,
      price: latest.price,
      currency: asset.currency,
      change_pct: Number(changePct.toFixed(4)),
      source: asset.market === "KR" ? "KIS_KRX_DAILY" : "KIS_NASDAQ_DAILY",
      freshness: "end_of_day",
      is_tradable: false,
      as_of: dateIso,
      updated_at: new Date().toISOString(),
    };
  }

  async publishQuote(quote) {
    const response = await fetch(`${SUPABASE_PROJECT_URL}/rest/v1/market_quotes?on_conflict=symbol`, {
      method: "POST",
      headers: {
        apikey: this.env.SUPABASE_SECRET_KEY,
        "content-type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify([quote]),
    });
    if (!response.ok) {
      this.lastError = `supabase_write_http_${response.status}`;
      return false;
    }
    this.lastError = null;
    return true;
  }

  async scheduleReconnect() {
    try { await this.ctx.storage.setAlarm(Date.now() + 5_000); } catch { /* another retry is already scheduled */ }
  }

  safeError(error) {
    const message = String(error?.message || "collector_error");
    // Do not return response bodies, request headers, or credential values in logs/status.
    return message.slice(0, 120);
  }
}

