/**
 * The Trader — Market Engine (mini-service, port 3003)
 * ═══════════════════════════════════════════════════════════════
 * Realtime engine + scheduler cho Giai đoạn 2 (DATA_SOURCES.md roadmap):
 *
 *   1. WebSocket broadcast (socket.io):
 *      - "quotes"  → payload GET/POST /api/market/tick (S4)
 *      - "news"    → kết quả nạp RSS (S5)
 *      - "eod"     → kết quả đồng bộ EOD THẬT VNDIRECT dchart (mới)
 *      - "cycle"   → kết quả chu kỳ agent (nếu bật scheduler)
 *   2. Scheduler:
 *      - TICK_MS  (mặc định 10s)     : tick bảng giá mô phỏng quanh ref THẬT
 *      - NEWS_MS  (mặc định 15 phút) : crawler RSS 5 nguồn VN
 *      - EOD_SYNC_AT (mặc định 15:45 ICT, hằng ngày, sau giờ chốt phiên):
 *        POST /api/market/eod-sync — kéo bar EOD thật từ dchart VNDIRECT,
 *        neo Quote về mức đóng cửa thật (chỉ chạy MỘT lần/ngày; chạy thêm một
 *        lần lúc boot để môi trường mới tự có dữ liệu thật sớm).
 *      - AGENT_CYCLE_MINUTES (0=off): chu kỳ phân tích đa agent tự động
 *
 * Frontend kết nối QUA GATEWAY với query XTransformPort=3003:
 *   io("/", { query: { XTransformPort: "3003" } })
 * Service này gọi thẳng http://localhost:3000 (server-to-server).
 */

import { createServer } from "node:http";
import { Server } from "socket.io";

const PORT = 3003;
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

/** Validate env số — chống setInterval(NaN) dồn cục API (AUD-CODE #20). */
function envMs(name: string, fallback: number, minMs: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw >= minMs ? raw : fallback;
}
const TICK_MS = envMs("TICK_MS", 10_000, 1_000);
const NEWS_MS = envMs("NEWS_MS", 15 * 60_000, 30_000);
const AGENT_CYCLE_MINUTES = envMs("AGENT_CYCLE_MINUTES", 0, 1) / 60_000;
/** Giờ ICT bắt đầu đồng bộ EOD hằng ngày (15:45 — sau giờ chốt 15:00). */
const EOD_SYNC_AT = process.env.EOD_SYNC_AT ?? "15:45";
const EOD_SYNC_DISABLED = process.env.EOD_SYNC_DISABLED === "1";

/** "HH:MM" ICT → phút kể từ nửa đêm ICT (UTC+7). */
function parseHhMm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
const EOD_SYNC_MINUTES = parseHhMm(EOD_SYNC_AT) ?? parseHhMm("15:45")!;

function ictNow(): { date: string; minutes: number } {
  const now = new Date(Date.now() + 7 * 3_600_000); // ICT = UTC+7
  return {
    date: now.toISOString().slice(0, 10),
    minutes: now.getUTCHours() * 60 + now.getUTCMinutes(),
  };
}

const stats = {
  startedAt: new Date().toISOString(),
  lastTickAt: null as string | null,
  lastTickError: null as string | null,
  ticks: 0,
  lastNewsAt: null as string | null,
  lastNewsError: null as string | null,
  newsRuns: 0,
  lastEodSyncAt: null as string | null,
  lastEodSyncDate: null as string | null,
  lastEodSyncError: null as string | null,
  eodSyncRuns: 0,
  lastCycleAt: null as string | null,
  cycles: 0,
  clients: 0,
};

const http = createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "market-engine",
        port: PORT,
        eodSyncAt: EOD_SYNC_AT,
        ...stats,
      })
    );
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const io = new Server(http, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
  stats.clients = io.engine.clientsCount;
  socket.emit("welcome", { ok: true, service: "market-engine", ts: Date.now() });
  socket.on("disconnect", () => {
    stats.clients = io.engine.clientsCount;
  });
});

function log(scope: string, msg: string) {
  console.log(`[${new Date().toISOString()}] [${scope}] ${msg}`);
}

async function postJson(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${APP_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const error = typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
    throw new Error(error);
  }
  return parsed;
}

/** AUD-CODE #20: mutex in-process — tick mới chờ tick cũ xong (chống lost-update). */
let tickChain: Promise<void> = Promise.resolve();
function enqueueTick(): Promise<void> {
  const run = tickChain.then(tickAndBroadcast).catch(() => undefined);
  tickChain = run;
  return run;
}

async function tickAndBroadcast(): Promise<void> {
  try {
    const data = await postJson("/api/market/tick");
    stats.lastTickAt = new Date().toISOString();
    stats.ticks++;
    stats.lastTickError = null;
    io.emit("quotes", data);
  } catch (err) {
    stats.lastTickError = err instanceof Error ? err.message : String(err);
    log("tick", `LỖI: ${stats.lastTickError}`);
  }
}

async function ingestNewsAndBroadcast(): Promise<void> {
  try {
    const data = await postJson("/api/news");
    stats.lastNewsAt = new Date().toISOString();
    stats.newsRuns++;
    stats.lastNewsError = null;
    io.emit("news", data);
    log("news", `nạp xong: +${data.added ?? 0} tin (${data.mode ?? "?"})`);
  } catch (err) {
    // 429 rate-limit là bình thường khi scheduler dồn lịch — không báo động
    stats.lastNewsError = err instanceof Error ? err.message : String(err);
    log("news", `bỏ qua: ${stats.lastNewsError}`);
  }
}

/** Đồng bộ EOD thật: kéo bar dchart → neo Quote → broadcast "eod". */
async function syncEodAndBroadcast(): Promise<void> {
  try {
    const data = await postJson("/api/market/eod-sync", { days: 10 });
    stats.lastEodSyncAt = new Date().toISOString();
    stats.eodSyncRuns++;
    stats.lastEodSyncError = null;
    const ict = ictNow();
    stats.lastEodSyncDate = ict.date;
    io.emit("eod", data);
    log(
      "eod",
      `đồng bộ EOD thật xong: ${data.symbolsOk ? (data.symbolsOk as unknown[]).length : "?"} mã · ${data.barsUpserted ?? 0} bar · phiên cuối ${data.lastTradeDate ?? "?"}`
    );
  } catch (err) {
    stats.lastEodSyncError = err instanceof Error ? err.message : String(err);
    log("eod", `LỖI: ${stats.lastEodSyncError}`);
  }
}

async function runAgentCycleAndBroadcast(): Promise<void> {
  try {
    const data = await postJson("/api/agents/run");
    stats.lastCycleAt = new Date().toISOString();
    stats.cycles++;
    io.emit("cycle", data);
    log("cycle", `chu kỳ agent hoàn tất (${data.durationMs ?? "?"}ms)`);
  } catch (err) {
    log("cycle", `LỖI: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Kiểm tra hằng phút: đã qua 15:45 ICT hôm nay và chưa sync ngày này → sync. */
function eodSyncDue(): boolean {
  if (EOD_SYNC_DISABLED) return false;
  const ict = ictNow();
  return ict.minutes >= EOD_SYNC_MINUTES && stats.lastEodSyncDate !== ict.date;
}

http.listen(PORT, () => {
  log("boot", `market-engine lắng nghe cổng ${PORT} → app ${APP_URL}`);
  log(
    "boot",
    `lịch: tick ${(TICK_MS / 1000).toFixed(0)}s · news ${(NEWS_MS / 60_000).toFixed(0)}phút · eod-sync ${EOD_SYNC_AT} ICT${EOD_SYNC_DISABLED ? " (TẮT)" : ""} · agent-cycle ${
      AGENT_CYCLE_MINUTES > 0 ? `${AGENT_CYCLE_MINUTES.toFixed(0)}phút` : "TẮT"
    }`
  );
  // Chạy ngay một vòng lúc khởi động để client có dữ liệu sớm —
  // EOD sync lúc boot giúp môi trường mới tự có giá thật (lookback 10 ngày)
  enqueueTick();
  void ingestNewsAndBroadcast();
  void syncEodAndBroadcast();
  setInterval(enqueueTick, TICK_MS);
  setInterval(ingestNewsAndBroadcast, NEWS_MS);
  setInterval(() => {
    if (eodSyncDue()) void syncEodAndBroadcast();
  }, 60_000);
  if (AGENT_CYCLE_MINUTES > 0) {
    setInterval(runAgentCycleAndBroadcast, AGENT_CYCLE_MINUTES * 60_000);
  }
});

process.on("SIGINT", () => {
  log("boot", "tắt market-engine…");
  io.close();
  http.close();
  process.exit(0);
});
