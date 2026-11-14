const KIS_REST_URL = "https://openapi.koreainvestment.com:9443";
const KIS_WS_URL = "ws://ops.koreainvestment.com:21000/tryitout";
const SUPABASE_PROJECT_URL = "https://cxgrrdxjrqxoayeknqkk.supabase.co";
const SITE_ORIGIN = "https://jjanggoo5950-code.github.io";
const US_EXCHANGES = new Set(["NAS", "NYS", "AMS"]);
const KRX_SYMBOLS = ["005930", "000660", "035420", "005380"];
const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
const FX_REFRESH_INTERVAL_MS = 60 * 1000;
const FX_SYMBOL = "USD/KRW";
const KIS_FX_CODE = "FX@KRWKFTC";
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

function isRegularMarketOpen(market, now = new Date()) {
  const timeZone = market === "KR" ? "Asia/Seoul" : "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (fields.weekday === "Sat" || fields.weekday === "Sun") return false;
  const minutes = Number(fields.hour) * 60 + Number(fields.minute);
  return market === "KR"
    ? minutes >= 9 * 60 && minutes < 15 * 60 + 30
    : minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

async function timedFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const corsHeaders = {
      "access-control-allow-origin": SITE_ORIGIN,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Accept",
      "cache-control": "no-store",
      "vary": "Origin",
    };

    if (["/quote", "/overview"].includes(url.pathname) && request.method === "OPTIONS") {
      if (origin !== SITE_ORIGIN) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/overview" && request.method === "GET") {
      const id = env.KIS_COLLECTOR.idFromName("krx-main");
      try {
        const response = await env.KIS_COLLECTOR.get(id).fetch("https://collector.internal/overview");
        return new Response(response.body, { status: response.status, headers: { ...corsHeaders, "content-type": "application/json", "retry-after": "20" } });
      } catch {
        return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: { ...corsHeaders, "retry-after": "20" } });
      }
    }
    if (url.pathname === "/quote" && request.method === "GET") {
      if (origin !== SITE_ORIGIN) {
        return Response.json({ error: "origin_not_allowed" }, { status: 403 });
      }
      const market = url.searchParams.get("market");
      const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
      const exchange = (url.searchParams.get("exchange") || "").trim().toUpperCase();
      const name = (url.searchParams.get("name") || "").trim().slice(0, 80);
      const validSymbol = market === "KR"
        ? /^[0-9A-Z]{6}$/.test(symbol)
        : market === "US" && /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol) && US_EXCHANGES.has(exchange);
      if (!validSymbol || !name) {
        return Response.json({ error: "invalid_symbol" }, { status: 400, headers: corsHeaders });
      }
      const id = env.KIS_COLLECTOR.idFromName("krx-main");
      const target = new URL("https://collector.internal/quote");
      target.search = new URLSearchParams({ market, symbol, exchange, name }).toString();
      const response = await env.KIS_COLLECTOR.get(id).fetch(target.toString(), {
        headers: { "x-caller-ip": request.headers.get("CF-Connecting-IP") || "" },
      });
      return new Response(response.body, {
        status: response.status,
        headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8", "retry-after": response.headers.get("retry-after") || "15" },
      });
    }

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
    this.lastFxAt = null;
    this.lastFxError = null;
    this.fxRefreshing = null;
    this.lastPublishedAt = new Map();
    this.quoteCache = new Map();
    this.pendingQuotes = new Map();
    this.requestWindows = new Map();
    this.restTail = Promise.resolve();
    this.restQueued = 0;
    this.nextRestAt = 0;
    this.circuitUntil = 0;
    this.restFailures = 0;
    this.publishTail = Promise.resolve();
    this.publishQueued = 0;
    this.publishedQuotes = new Map();
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/overview" && request.method === "GET") {
      try { return Response.json(await this.getOverview()); }
      catch { return Response.json({ error: "overview_unavailable" }, { status: 503 }); }
    }
    if (path === "/status" && request.method === "GET") {
      const savedSnapshotStatus = await this.ctx.storage.get("dailySnapshotStatus");
      const savedFxStatus = await this.ctx.storage.get("fxQuoteStatus");
      return Response.json({
        service: "KIS KRX quote collector",
        status: this.status,
        realtime_kr_symbols: KRX_SYMBOLS,
        daily_snapshot_symbols: SNAPSHOT_ASSETS.map((asset) => asset.symbol),
        fx_symbol: FX_SYMBOL,
        fx_source_version: "resilience-v1",
        queued_requests: this.restQueued,
        upstream_circuit_open: Date.now() < this.circuitUntil,
        last_fx_at: this.lastFxAt || savedFxStatus?.at || null,
        last_fx_error: this.lastFxError ?? savedFxStatus?.error ?? null,
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
        await this.refreshFxQuoteIfDue();
      } catch (error) {
        this.lastFxError = this.safeError(error);
      }

      try { await this.refreshHeldQuotes(); } catch (error) { this.lastError = this.safeError(error); }

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

    if (path === "/quote" && request.method === "GET") {
      const url = new URL(request.url);
      const market = url.searchParams.get("market");
      const symbol = url.searchParams.get("symbol") || "";
      const exchange = url.searchParams.get("exchange") || "";
      const name = url.searchParams.get("name") || "";
      try {
        if (!await this.allowQuoteRequest(request.headers.get("X-Caller-IP") || "unknown")) {
          return Response.json({ error: "quote_rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
        }
        const quote = await this.fetchOnDemandQuote({ market, symbol, exchange, name });
        return Response.json(quote, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return Response.json({ error: "quote_unavailable" }, { status: 503, headers: { "retry-after": "15" } });
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
      await this.refreshFxQuoteIfDue();
    } catch (error) {
      this.lastFxError = this.safeError(error);
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

    const approvalResponse = await this.fetchUpstream(`${KIS_REST_URL}/oauth2/Approval`, {
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

    this.reconnectAttempts = 0;
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
    if (now - (this.lastPublishedAt.get(quote.symbol) || 0) < 5000) return;
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

  refreshFxQuoteIfDue() {
    if (!this.fxRefreshing) this.fxRefreshing = (async () => {
      const now = Date.now();
      const last = Number(await this.ctx.storage.get("fxQuoteAttemptAt") || 0);
      if (now-last >= FX_REFRESH_INTERVAL_MS) await this.refreshFxQuote(now);
    })().finally(() => { this.fxRefreshing = null; });
    return this.fxRefreshing;
  }

  refreshHeldQuotes() {
    if (!this.heldRefreshing) this.heldRefreshing = (async () => {
      const now = Date.now();
      if (now - Number(await this.ctx.storage.get("heldAttemptAt") || 0) < 55000) return;
      await this.ctx.storage.put("heldAttemptAt", now);
      const after = await this.ctx.storage.get("heldCursor") || "";
      const response = await timedFetch(`${SUPABASE_PROJECT_URL}/rest/v1/rpc/get_campus_quote_targets`, {
        method:"POST", headers:{apikey:this.env.SUPABASE_SECRET_KEY,"content-type":"application/json"}, body:JSON.stringify({p_after:after}),
      });
      if (!response.ok) throw new Error("held_quote_targets_unavailable");
      const targets = await response.json();
      if (!Array.isArray(targets)) throw new Error("held_quote_targets_invalid");
      for (const asset of targets) {
        // The quote source records the original exchange chosen from the KIS catalog.
        asset.exchange = /KIS_(NAS|NYS|AMS)_/.exec(asset.source)?.[1] || "NAS";
        try { await this.fetchOnDemandQuote(asset); } catch { /* continue to the next holding */ }
        await this.ctx.storage.put("heldCursor", asset.symbol);
      }
      if (targets.length < 20) await this.ctx.storage.put("heldCursor", "");
    })().finally(() => { this.heldRefreshing = null; });
    return this.heldRefreshing;
  }

  async refreshFxQuote(now) {
    await this.ctx.storage.put("fxQuoteAttemptAt", now);
    try {
      const accessToken = await this.getRestAccessToken();
      const requestFx = async (path, trId, params) => {
        const url = new URL(KIS_REST_URL + path);
        url.search = new URLSearchParams(params).toString();
        const response = await this.fetchUpstream(url, {
          headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${accessToken}`,
            appkey: this.env.KIS_APP_KEY,
            appsecret: this.env.KIS_APP_SECRET,
            custtype: "P",
            tr_id: trId,
          },
        });
        if (!response.ok) {
          const responseText = await response.text();
          let detail = "";
          try {
            const errorBody = JSON.parse(responseText);
            detail = String(errorBody.msg_cd || errorBody.error_code || errorBody.msg1 || "");
          } catch {
            detail = responseText.replace(/\s+/g, " ").slice(0, 80);
          }
          throw new Error(`kis_fx_http_${response.status}_${detail || "upstream_error"}`);
        }
        const body = await response.json();
        if (String(body.rt_cd) !== "0") {
          throw new Error(`kis_fx_${body.msg_cd || body.rt_cd || "error"}`);
        }
        return body;
      };
      const parseFxBody = (body) => {
        const output = Array.isArray(body.output1) ? (body.output1[0] || {}) : (body.output1 || body.output || {});
        const rows = Array.isArray(body.output2) ? body.output2 : body.output2 ? [body.output2] : [];
        const latest = rows.slice().sort((a, b) => {
          const stampA = String(a.stck_bsop_date || "") + String(a.stck_cntg_hour || "");
          const stampB = String(b.stck_bsop_date || "") + String(b.stck_cntg_hour || "");
          return stampB.localeCompare(stampA);
        })[0] || {};
        const price = [output, latest].flatMap((row) => [
          row.ovrs_nmix_prpr,
          row.fx_rate,
          row.fxrt,
          row.prpr,
          row.rate,
          row.stck_prpr,
          row.ovrs_nmix_prdy_clpr,
        ]).map((value) => Number(String(value ?? "").replaceAll(",", "").trim()))
          .find((value) => Number.isFinite(value) && value > 0);
        return { output, latest, price };
      };

      const kstNow = new Date(now + 9 * 60 * 60 * 1000);
      const endDay = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()));
      if (endDay.getUTCDay() === 0) endDay.setUTCDate(endDay.getUTCDate() - 2);
      else if (endDay.getUTCDay() === 6) endDay.setUTCDate(endDay.getUTCDate() - 1);
      const endDate = endDay.toISOString().slice(0, 10).replaceAll("-", "");
      const startDate = new Date(endDay.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll("-", "");
      let body = null, parsed = null, freshness = "real_time", marketCode = null;
      const attempts = [];

      for (const fxMarketCode of ["X"]) {
        try {
          body = await requestFx(
            "/uapi/overseas-price/v1/quotations/inquire-time-indexchartprice",
            "FHKST03030200",
            {
              FID_COND_MRKT_DIV_CODE: fxMarketCode,
              FID_INPUT_ISCD: KIS_FX_CODE,
              FID_HOUR_CLS_CODE: "0",
              FID_PW_DATA_INCU_YN: "Y",
            }
          );
          parsed = parseFxBody(body);
        } catch (error) {
          parsed = null;
          attempts.push(fxMarketCode + "_intraday_" + this.safeError(error));
        }
        if (parsed?.price) {
          marketCode = fxMarketCode;
          break;
        }
        if (!attempts.some((attempt) => attempt.startsWith(fxMarketCode + "_intraday_"))) {
          attempts.push(fxMarketCode + "_intraday_empty");
        }

        await new Promise((resolve) => setTimeout(resolve, 1_200));
        try {
          body = await requestFx(
            "/uapi/overseas-price/v1/quotations/inquire-daily-chartprice",
            "FHKST03030100",
            {
              FID_COND_MRKT_DIV_CODE: fxMarketCode,
              FID_INPUT_ISCD: KIS_FX_CODE,
              FID_INPUT_DATE_1: startDate,
              FID_INPUT_DATE_2: endDate,
              FID_PERIOD_DIV_CODE: "D",
            }
          );
          parsed = parseFxBody(body);
        } catch (error) {
          parsed = null;
          attempts.push(fxMarketCode + "_daily_" + this.safeError(error));
        }
        if (parsed?.price) {
          freshness = "end_of_day";
          marketCode = fxMarketCode;
          break;
        }
        if (!attempts.some((attempt) => attempt.startsWith(fxMarketCode + "_daily_"))) {
          attempts.push(fxMarketCode + "_daily_empty");
        }
      }

      if (!parsed?.price) {
        const diagnostic = {
          out_price: parsed?.output?.ovrs_nmix_prpr ?? null,
          row_price: parsed?.latest?.ovrs_nmix_prpr ?? null,
          out_close: parsed?.output?.ovrs_nmix_prdy_clpr ?? null,
          row_close: parsed?.latest?.ovrs_nmix_prdy_clpr ?? null,
          msg_cd: body?.msg_cd ?? null,
          attempts,
        };
        throw new Error("kis_fx_price_missing_" + JSON.stringify(diagnostic));
      }

      const { output, latest, price } = parsed;
      const date = String(latest.stck_bsop_date || output.stck_bsop_date || "").replace(/\D/g, "");
      const time = String(latest.stck_cntg_hour || output.stck_cntg_hour || "").replace(/\D/g, "").padStart(6, "0");
      let asOf = new Date(now).toISOString();
      if (/^\d{8}$/.test(date)) {
        const timePart = freshness === "end_of_day" ? "00:00:00" : /^\d{6}$/.test(time)
          ? `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`
          : "23:59:59";
        const localStamp = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${timePart}+09:00`;
        const parsedDate = new Date(localStamp);
        if (Number.isFinite(parsedDate.getTime())) asOf = parsedDate.toISOString();
      }
      const ageMs = Math.max(0, now - Date.parse(asOf));
      const change = Number(output.prdy_ctrt ?? output.ovrs_nmix_prdy_ctrt ?? latest.prdy_ctrt ?? 0);
      const quote = {
        symbol: FX_SYMBOL,
        market: "FX",
        name: FX_SYMBOL,
        price,
        currency: "KRW",
        change_pct: Number.isFinite(change) ? Number(change.toFixed(4)) : 0,
        source: "KIS_FX_REST",
        freshness: freshness === "end_of_day" ? freshness : ageMs <= 120_000 ? "real_time" : "delayed",
        is_tradable: ageMs <= 7 * 24 * 60 * 60 * 1000,
        as_of: asOf,
        updated_at: new Date(now).toISOString(),
      };
      if (!quote.is_tradable) throw new Error("kis_fx_quote_too_old");
      if (!await this.publishQuote(quote)) throw new Error("fx_quote_storage_failed");

      this.lastFxAt = quote.updated_at;
      this.lastFxError = null;
      await this.ctx.storage.put("fxQuoteStatus", { at: this.lastFxAt, error: null });
    } catch (error) {
      this.lastFxError = this.safeError(error);
      await this.ctx.storage.put("fxQuoteStatus", {
        at: this.lastFxAt,
        error: this.lastFxError,
      });
      throw error;
    }
  }

  getRestAccessToken() {
    if (!this.tokenRequest) this.tokenRequest = this.loadRestAccessToken().finally(() => { this.tokenRequest = null; });
    return this.tokenRequest;
  }

  async loadRestAccessToken() {
    const cached = await this.ctx.storage.get("kisRestAccessToken");
    if (cached?.value && Number(cached.expiresAt) > Date.now() + 60_000) return cached.value;

    const response = await this.fetchUpstream(`${KIS_REST_URL}/oauth2/tokenP`, {
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

    const response = await this.fetchUpstream(url, { headers });
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
    const dateIso = `${latest.date.slice(0, 4)}-${latest.date.slice(4, 6)}-${latest.date.slice(6, 8)}${asset.market === "KR" ? "T06:30:00.000Z" : "T00:00:00.000Z"}`;

    return {
      symbol: asset.symbol,
      market: asset.market,
      name: asset.name,
      price: latest.price,
      currency: asset.currency,
      change_pct: Number(changePct.toFixed(4)),
      source: asset.market === "KR" ? "KIS_KRX_DAILY" : `KIS_${asset.exchange}_DAILY`,
      freshness: "end_of_day",
      is_tradable: false,
      as_of: dateIso,
      updated_at: new Date().toISOString(),
    };
  }

  async allowQuoteRequest(ip) {
    const now = Date.now();
    // A school can share an IP. This is only a generous abuse limit, not an account limit.
    for (const [key, value] of this.requestWindows) if (now - value.at >= 60000) this.requestWindows.delete(key);
    const value = this.requestWindows.get(ip) || { at: now, count: 0 };
    if (value.count >= 600 || this.requestWindows.size > 10000) return false;
    value.count++;
    this.requestWindows.set(ip, value);
    return true;
  }

  async getOverview() {
    const age = Date.now() - (this.overviewAt || 0);
    if (this.overview && age < 20000) return this.overview;
    if (this.overviewRequest) return this.overviewRequest;
    this.overviewRequest = (async () => {
      try {
        const response = await timedFetch(`${SUPABASE_PROJECT_URL}/rest/v1/rpc/get_campus_league_overview`, {
          method: "POST", headers: { apikey: this.env.SUPABASE_SECRET_KEY, "content-type": "application/json" }, body: "{}",
        });
        if (!response.ok) throw new Error("overview_unavailable");
        const data = await response.json();
        if (!Array.isArray(data.quotes) || !Array.isArray(data.schools)) throw new Error("invalid_overview");
        this.overviewAt = Date.now();
        this.overview = { ...data, fetched_at: new Date(this.overviewAt).toISOString(), stale: false };
        return this.overview;
      } catch (error) {
        if (this.overview && age < 120000) return { ...this.overview, stale: true };
        throw error;
      } finally { this.overviewRequest = null; }
    })();
    return this.overviewRequest;
  }

  async fetchUpstream(url, options = {}) {
    if (!String(url).startsWith(KIS_REST_URL)) return timedFetch(url, options);
    if (Date.now() < this.circuitUntil || this.restQueued >= 16) throw new Error("upstream_busy");
    this.restQueued++;
    const deadline = Date.now() + 20000;
    const task = this.restTail.then(async () => {
      if (Date.now() < this.circuitUntil) throw new Error("upstream_cooling_down");
      for (let attempt = 0; attempt < 2; attempt++) {
        if (Date.now() > deadline) throw new Error("upstream_queue_timeout");
        await new Promise(resolve => setTimeout(resolve, Math.max(0, this.nextRestAt - Date.now())));
        this.nextRestAt = Date.now() + 1200;
        try {
          const response = await timedFetch(url, options);
          const body = await response.clone().json().catch(() => ({}));
          const transient = response.status === 429 || response.status >= 500 || body.msg_cd === "EGW00201";
          if (transient) throw new Error("upstream_temporarily_unavailable");
          this.restFailures = 0;
          return response;
        } catch (error) {
          this.restFailures++;
          if (this.restFailures >= 3) this.circuitUntil = Date.now() + 30000;
          if (attempt || Date.now() < this.circuitUntil) throw error;
          this.nextRestAt = Date.now() + 1500 + Math.random() * 500;
        }
      }
    });
    this.restTail = task.catch(() => {});
    try { return await task; } finally { this.restQueued--; }
  }

  async fetchOnDemandQuote(asset) {
    const key = asset.market + ":" + asset.exchange + ":" + asset.symbol;
    const cached = this.quoteCache.get(key);
    const ttl = isRegularMarketOpen(asset.market) ? 15000 : 15 * 60000;
    if (cached && Date.now() - cached.fetchedAt < ttl) return cached.quote;
    if (this.pendingQuotes.has(key)) return this.pendingQuotes.get(key);
    const task = (async () => {
      try {
        const quote = await this.loadOnDemandQuote(asset);
        if (!await this.publishQuote(quote)) throw new Error("quote_storage_failed");
        this.quoteCache.set(key, { fetchedAt: Date.now(), quote });
        if (this.quoteCache.size > 1000) this.quoteCache.delete(this.quoteCache.keys().next().value);
        return quote;
      } catch (error) {
        // Never refresh the timestamp or enable orders using a failed lookup.
        if (cached) return { ...cached.quote, is_tradable: false, stale: true };
        throw error;
      } finally { this.pendingQuotes.delete(key); }
    })();
    this.pendingQuotes.set(key, task);
    return task;
  }

  async loadOnDemandQuote({ market, symbol, exchange, name }) {

    const asset = {
      symbol,
      market,
      name,
      currency: market === "KR" ? "KRW" : "USD",
      exchange: market === "KR" ? "NAS" : exchange,
    };
    const accessToken = await this.getRestAccessToken();
    let quote;

    if (!isRegularMarketOpen(market)) {
      quote = await this.fetchDailySnapshot(accessToken, asset);
    } else {
      const headers = {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${accessToken}`,
        appkey: this.env.KIS_APP_KEY,
        appsecret: this.env.KIS_APP_SECRET,
        custtype: "P",
      };
      let url;
      if (market === "KR") {
        url = new URL(`${KIS_REST_URL}/uapi/domestic-stock/v1/quotations/inquire-price`);
        url.search = new URLSearchParams({
          FID_COND_MRKT_DIV_CODE: "UN",
          FID_INPUT_ISCD: symbol,
        }).toString();
        headers.tr_id = "FHKST01010100";
      } else {
        url = new URL(`${KIS_REST_URL}/uapi/overseas-price/v1/quotations/price`);
        url.search = new URLSearchParams({ AUTH: "", EXCD: exchange, SYMB: symbol }).toString();
        headers.tr_id = "HHDFS00000300";
      }

      const response = await this.fetchUpstream(url, { headers });
      if (!response.ok) throw new Error(`kis_${market.toLowerCase()}_quote_http_${response.status}`);
      const body = await response.json();
      if (String(body.rt_cd) !== "0") {
        throw new Error(`kis_${market.toLowerCase()}_quote_${body.msg_cd || body.rt_cd || "error"}`);
      }
      const output = body.output || body.output1 || {};
      const price = Number(market === "KR" ? output.stck_prpr : output.last);
      const change = Number(market === "KR" ? output.prdy_ctrt : output.rate);
      if (!Number.isFinite(price) || price <= 0) throw new Error("kis_quote_price_missing");
      const now = new Date().toISOString();
      quote = {
        symbol,
        market,
        name,
        price,
        currency: asset.currency,
        change_pct: Number.isFinite(change) ? Number(change.toFixed(4)) : 0,
        source: market === "KR" ? "KIS_KR_REST" : `KIS_${exchange}_REST`,
        freshness: "real_time",
        is_tradable: true,
        as_of: now,
        updated_at: now,
      };
    }

    return quote;
  }

  publishQuote(quote) {
    if (this.publishQueued >= 32) return Promise.resolve(false);
    this.publishQueued++;
    const task = this.publishTail.then(() => this.writeQuote(quote)).finally(() => { this.publishQueued--; });
    this.publishTail = task.catch(() => {});
    return task;
  }

  async writeQuote(quote) {
    const stamp = Date.parse(quote.as_of);
    if (!Number.isFinite(quote.price) || quote.price <= 0 || !Number.isFinite(stamp) || stamp > Date.now() + 60000) return false;
    const previous = this.publishedQuotes.get(quote.symbol);
    if (previous && stamp < previous) return true;
    if (quote.freshness === "end_of_day" && quote.market !== "FX" && isRegularMarketOpen(quote.market)) return true;
    const response = await this.fetchUpstream(`${SUPABASE_PROJECT_URL}/rest/v1/market_quotes?on_conflict=symbol`, {
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
    this.publishedQuotes.set(quote.symbol, stamp);
    if (this.publishedQuotes.size > 2000) this.publishedQuotes.delete(this.publishedQuotes.keys().next().value);
    return true;
  }

  async scheduleReconnect() {
    const delay = Math.min(60000, 5000 * 2 ** Math.min(this.reconnectAttempts || 0, 4)) + Math.random() * 1000;
    this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
    try { await this.ctx.storage.setAlarm(Date.now() + delay); } catch { /* another retry is already scheduled */ }
  }

  safeError(error) {
    const message = String(error?.message || "collector_error");
    // Do not return response bodies, request headers, or credential values in logs/status.
    return message.slice(0, 280);
  }
}

