/**
 * The Trader — Market Engine (mini-service, port 3003)
 * ═══════════════════════════════════════════════════════════════
 * Realtime engine + scheduler cho Giai đoạn 2 (DATA_SOURCES.md roadmap):
 *
 *   1. WebSocket broadcast (socket.io):
 *      - "quotes"  → payload GET/POST /api/market/tick (S4)
 *      - "news"    → kết quả nạp RSS (S5)
 *      - "cycle"   → kết quả chu kỳ agent (nếu bật scheduler)
 *   2. Scheduler:
 *      - TICK_MS  (mặc định 10s)    : tick bảng giá mô phỏng
 *      - NEWS_MS  (mặc định 15 phút): crawler RSS 5 nguồn VN
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
const TICK_MS = Number(process.env.TICK_MS ?? 10_000);
const NEWS_MS = Number(process.env.NEWS_MS ?? 15 * 60_000);
const AGENT_CYCLE_MINUTES = Number(process.env.AGENT_CYCLE_MINUTES ?? 0);

const stats = {
  startedAt: new Date().toISOString(),
  lastTickAt: null as string | null,
  lastTickError: null as string | null,
  ticks: 0,
  lastNewsAt: null as string | null,
  lastNewsError: null as string | null,
  newsRuns: 0,
  lastCycleAt: null as string | null,
  cycles: 0,
  clients: 0,
};

const http = createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: "market-engine", port: PORT, ...stats }));
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

async function postJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${APP_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const error = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(error);
  }
  return body;
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

http.listen(PORT, () => {
  log("boot", `market-engine lắng nghe cổng ${PORT} → app ${APP_URL}`);
  log(
    "boot",
    `lịch: tick ${(TICK_MS / 1000).toFixed(0)}s · news ${(NEWS_MS / 60_000).toFixed(0)}phút · agent-cycle ${
      AGENT_CYCLE_MINUTES > 0 ? `${AGENT_CYCLE_MINUTES}phút` : "TẮT"
    }`
  );
  // Chạy ngay một vòng lúc khởi động để client có dữ liệu sớm
  void tickAndBroadcast();
  void ingestNewsAndBroadcast();
  setInterval(tickAndBroadcast, TICK_MS);
  setInterval(ingestNewsAndBroadcast, NEWS_MS);
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
