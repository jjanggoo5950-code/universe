const KIS_REST_URL = "https://openapi.koreainvestment.com:9443";
const KIS_WS_URL = "ws://ops.koreainvestment.com:21000/tryitout";
const SUPABASE_PROJECT_URL = "https://cxgrrdxjrqxoayeknqkk.supabase.co";
const KRX_SYMBOLS = ["005930", "000660", "035420", "005380"];
const STOCK_NAMES = {
  "005930": "삼성전자",
  "000660": "SK하이닉스",
  "035420": "NAVER",
  "005380": "현대차",
};

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
    this.lastPublishedAt = new Map();
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/status" && request.method === "GET") {
      return Response.json({
        service: "KIS KRX quote collector",
        status: this.status,
        symbols: KRX_SYMBOLS,
        last_tick_at: this.lastTickAt,
        last_error: this.lastError,
      });
    }

    // This route is reached only through the Worker binding, never from a public route.
    if (path === "/ensure" && request.method === "POST") {
      try {
        await this.ensureConnected();
        return Response.json({ status: this.status });
      } catch (error) {
        this.status = "error";
        this.lastError = this.safeError(error);
        await this.scheduleReconnect();
        return Response.json({ status: this.status, error: this.lastError }, { status: 503 });
      }
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
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
    const parts = raw.split("|", 3);
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
      return;
    }
    this.lastError = null;
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

