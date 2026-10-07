/**
 * src/lib/bayes/persist.ts — LƯU/NẠP Bộ tổng hợp Bayes vào bảng
 * MarketAssessment (schema phiên #34 — đã db:push sẵn).
 *
 * Mô hình cột riêng: pUp/pDown/pFlat/marketDirection/confidence/disagreement/
 * evidenceCount/source/cycleRunId/createdAt; phần còn lại của
 * MarketAssessmentView (prior/drivers/sectors/symbols/market/forecast5d/veto/
 * narrative/agentsConsidered) nằm trong cột detail (JSON string).
 */

import { db } from "@/lib/db";
import type { SynthesisInput, SynthesisOutput } from "@/lib/bayes/types";
import type { MarketAssessmentView } from "@/lib/types";

/** Các trường cột riêng — KHÔNG đưa vào detail JSON (tránh lặp dữ liệu). */
const COLUMN_FIELDS = new Set([
  "id",
  "createdAt",
  "source",
  "cycleRunId",
  "pUp",
  "pDown",
  "pFlat",
  "marketDirection",
  "confidence",
  "disagreement",
  "evidenceCount",
]);

/** Tách phần detail của view (mọi trường ngoài các cột riêng). */
function viewToDetail(view: SynthesisOutput): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(view)) {
    if (!COLUMN_FIELDS.has(k)) detail[k] = v;
  }
  return detail;
}

/** Ghép cột DB + detail JSON thành MarketAssessmentView hoàn chỉnh. */
function rowToView(
  row: {
    id: string;
    source: string;
    cycleRunId: string | null;
    pUp: number;
    pDown: number;
    pFlat: number;
    marketDirection: string;
    confidence: number;
    disagreement: number;
    evidenceCount: number;
    detail: string;
    createdAt: Date;
  }
): MarketAssessmentView {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.detail) as Record<string, unknown>;
  } catch {
    // detail hỏng (chuỗi rỗng cũ…) — vẫn trả khung với các cột đúng
    parsed = {};
  }
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    source: row.source === "manual" ? "manual" : "cycle",
    cycleRunId: row.cycleRunId,
    pUp: row.pUp,
    pDown: row.pDown,
    pFlat: row.pFlat,
    marketDirection:
      row.marketDirection === "BULLISH"
        ? "BULLISH"
        : row.marketDirection === "BEARISH"
          ? "BEARISH"
          : "NEUTRAL",
    confidence: row.confidence,
    disagreement: row.disagreement,
    evidenceCount: row.evidenceCount,
    prior: (parsed.prior as MarketAssessmentView["prior"]) ?? {
      pUp: row.pUp,
      pDown: row.pDown,
      pFlat: row.pFlat,
      baseRateNote: "",
    },
    drivers: (parsed.drivers as MarketAssessmentView["drivers"]) ?? [],
    sectors: (parsed.sectors as MarketAssessmentView["sectors"]) ?? [],
    symbols: (parsed.symbols as MarketAssessmentView["symbols"]) ?? [],
    market: (parsed.market as MarketAssessmentView["market"]) ?? {
      advancing: 0,
      declining: 0,
      unchanged: 0,
      regime: "",
      netForeignFlowVnd: null,
      newsSentimentScore: null,
      breadth: 0,
    },
    forecast5d: (parsed.forecast5d as MarketAssessmentView["forecast5d"]) ?? null,
    veto: (parsed.veto as MarketAssessmentView["veto"]) ?? { blocked: false, reason: null },
    narrative: (parsed.narrative as string) ?? "",
    agentsConsidered: (parsed.agentsConsidered as string[]) ?? [],
    // B5 — phân đoạn thị trường (row cũ trước #38 không có → mảng rỗng)
    segments: (parsed.segments as MarketAssessmentView["segments"]) ?? [],
    // B9 — cổng đồng thuận (row cũ trước #38 không có → null)
    consensus: (parsed.consensus as MarketAssessmentView["consensus"]) ?? null,
    // Phiên #51 — CRB: khối quant Ủy ban Kiểm soát Định lượng (row cũ → null)
    riskQuant: (parsed.riskQuant as MarketAssessmentView["riskQuant"]) ?? null,
  };
}

/** Tuỳ chọn lưu. */
export interface SaveAssessmentOptions {
  source: "cycle" | "manual";
  /** AgentRun id của Chủ tịch — gán sau khi chairman chạy xong (attachCycleRunId). */
  cycleRunId?: string | null;
}

/**
 * Lưu kết quả tổng hợp: tạo dòng MarketAssessment với cột riêng + detail JSON.
 * Trả về view hoàn chỉnh (id/createdAt thật từ DB).
 */
export async function saveMarketAssessment(
  input: SynthesisInput,
  view: SynthesisOutput,
  options: SaveAssessmentOptions
): Promise<MarketAssessmentView> {
  const detail = viewToDetail(view);
  // B7/B8 — persist phiếu bầu 6 cử tri (code/direction/confidence) vào detail:
  // bandit settle + scorecard đọc được KẼ CẢ KHI phiếu rơi ngoài drivers top-12
  // (parseVotes ưu tiên detail.agentVotes trước detail.drivers).
  detail.agentVotes = input.agentVotes.map((v) => ({
    code: v.code,
    direction: v.direction,
    confidence: Number(v.confidence.toFixed(4)),
  }));
  // Phiên #51 — CRB §7: khối quant Ủy ban Kiểm soát Định lượng vào detail
  // (additive — row cũ không có trường này, UI xử lý null).
  if (input.riskQuant) {
    detail.riskQuant = input.riskQuant;
  }
  const row = await db.marketAssessment.create({
    data: {
      source: options.source,
      cycleRunId: options.cycleRunId ?? null,
      pUp: view.pUp,
      pDown: view.pDown,
      pFlat: view.pFlat,
      marketDirection: view.marketDirection,
      confidence: view.confidence,
      disagreement: view.disagreement,
      evidenceCount: view.evidenceCount,
      detail: JSON.stringify(detail),
    },
  });
  return {
    ...view,
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    source: row.source === "manual" ? "manual" : "cycle",
    cycleRunId: row.cycleRunId,
  };
}

/** Gắn AgentRun id của Chủ tịch vào assessment đã lưu (gọi sau wave E). */
export async function attachCycleRunId(
  assessmentId: string,
  cycleRunId: string
): Promise<void> {
  await db.marketAssessment.update({
    where: { id: assessmentId },
    data: { cycleRunId },
  });
}

/**
 * Phiên #51 — CRB-9: cập nhật kellyHint vào detail.riskQuant của assessment
 * SAU khi Chủ tịch ra tín hiệu (Kelly cần target/stop — không biết trước).
 * Đọc-sửa-ghi detail JSON; lỗi im lặng (Kelly chỉ tham mưu).
 */
export async function attachRiskQuantKelly(
  assessmentId: string | null | undefined,
  kellyHint: number | null
): Promise<void> {
  if (!assessmentId) return;
  try {
    const row = await db.marketAssessment.findUnique({
      where: { id: assessmentId },
      select: { detail: true },
    });
    if (!row) return;
    const detail = JSON.parse(row.detail) as Record<string, unknown>;
    const rq = detail.riskQuant as { kellyHint?: number | null } | undefined;
    if (!rq) return;
    rq.kellyHint = kellyHint;
    await db.marketAssessment.update({
      where: { id: assessmentId },
      data: { detail: JSON.stringify(detail) },
    });
  } catch {
    // detail hỏng/parse lỗi — bỏ qua (kellyHint đã có trong RiskQuantSnapshot)
  }
}

/** Bản assessment mới nhất (parse detail) — null khi chưa có bản nào. */
export async function loadLatestAssessment(): Promise<MarketAssessmentView | null> {
  const row = await db.marketAssessment.findFirst({
    orderBy: { createdAt: "desc" },
  });
  return row ? rowToView(row) : null;
}

/** Dòng lịch sử tóm tắt (cho AssessmentResponse.history). */
export interface AssessmentHistoryRow {
  createdAt: string;
  pUp: number;
  pDown: number;
  pFlat: number;
  marketDirection: string;
  confidence: number;
}

/** Lịch sử N bản gần nhất (mặc định 30, tối đa 100). */
export async function loadAssessmentHistory(limit = 30): Promise<AssessmentHistoryRow[]> {
  const rows = await db.marketAssessment.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(100, Math.max(1, limit)),
    select: {
      createdAt: true,
      pUp: true,
      pDown: true,
      pFlat: true,
      marketDirection: true,
      confidence: true,
    },
  });
  return rows.map((r) => ({
    createdAt: r.createdAt.toISOString(),
    pUp: r.pUp,
    pDown: r.pDown,
    pFlat: r.pFlat,
    marketDirection: r.marketDirection,
    confidence: r.confidence,
  }));
}
