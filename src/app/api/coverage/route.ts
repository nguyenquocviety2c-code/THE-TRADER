import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/coverage (B14 — MARKET_EXPANSION_BLUEPRINT v1.1 §3.7) —
 * Ma trận độ phủ thị trường cho tab Đội Agent.
 *
 * Khung cố định 5 cột (STOCK · ETF · FUND · BOND · INDEX) × 3 hàng
 * (HOSE · HNX · UPCOM) = 15 ô LUÔN render (kể cả ô 0 sản phẩm — trung thực
 * T14.1, không bịa dữ liệu) + hàng quốc tế (US · HK) + dòng cơ bản (finfo).
 *
 * Nguồn dữ liệu THUẦN QUERY DB + DataSourceStatus — KHÔNG bảng mới (§3.7):
 *   [1] Instrument isActive (findMany gọn 90 dòng — group in-memory theo
 *       (market × type), thay cho groupBy vì cần map instrumentId để join)
 *   [2] Bar groupBy instrumentId — _count + _max(date)
 *   [3] Quote groupBy instrumentId — _max(tradedAt)
 *   [4] DataSourceStatus findMany + FinancialFundamental.count (hàng cơ bản)
 * → 5 query cố định, KHÔNG N+1, chạy Promise.all song song.
 *
 * Trạng thái mỗi ô (§1.2 — 3 màu trung thực):
 *   real          = có instrument active VÀ barCount > 0 (dữ liệu thật đang chảy)
 *   empty         = 0 instrument active ("0 sản phẩm niêm yết" — thị trường
 *                   không có sản phẩm, không phải hệ thống thiếu)
 *   pending-source = có sản phẩm thật nhưng chưa có nguồn xác minh (BOND HNX/
 *                   UPCOM — finfo chặn egress) HOẶC instrument đã seed nhưng
 *                   bar chưa đổ (US/HK chờ sync Yahoo — job 06:15 ICT).
 *
 * Hợp đồng types dưới đây là single source of truth cho UI
 * (coverage-matrix.tsx import type — erased lúc compile, không kéo server
 * code vào client bundle).
 */

/* ══════════ Hợp đồng API — import type từ coverage-matrix.tsx ══════════ */

export type CoverageStatus = "real" | "empty" | "pending-source";

export interface CoverageCell {
  /** HOSE | HNX | UPCOM | US | HK */
  market: string;
  /** STOCK | ETF | FUND | BOND | INDEX — ô quốc tế gộp loại: "MIXED" */
  type: string;
  status: CoverageStatus;
  /** số instrument active trong ô */
  instrumentCount: number;
  /** tổng bar EOD của các instrument active trong ô */
  barCount: number;
  /** phiên bar cuối (ISO) — null khi ô chưa có bar */
  lastBarDate: string | null;
  /** tuổi quote mới nhất của ô (phút) — null khi chưa có quote */
  quoteAgeMin: number | null;
  /** ghi chú trung thực (đầy đủ hiển thị trong tooltip T14.4) */
  note: string;
}

export interface FundamentalsRow {
  label: string;
  /** mode DataSourceStatus key "fundamentals" (real | pending | …) */
  mode: string;
  status: CoverageStatus;
  /** số dòng FinancialFundamental đã ingest */
  rowsCount: number;
  lastSuccessAt: string | null;
  note: string;
}

export interface CoverageResponse {
  /** 3 hàng × 5 cột — grid[hàng HOSE→HNX→UPCOM][cột STOCK→ETF→FUND→BOND→INDEX] */
  grid: CoverageCell[][];
  /** hàng quốc tế: [US, HK] — gộp mọi loại tài sản trên sàn đó */
  intlRow: CoverageCell[];
  fundamentalsRow: FundamentalsRow;
  generatedAt: string;
}

/* ══════════ Khung cố định ma trận (§1.2) ══════════ */

const GRID_MARKETS = ["HOSE", "HNX", "UPCOM"] as const;
const GRID_TYPES = ["STOCK", "ETF", "FUND", "BOND", "INDEX"] as const;
const INTL_MARKETS = ["US", "HK"] as const;

/** Nhãn tiếng Việt của loại tài sản cho note quốc tế. */
const TYPE_LABELS_VI: Record<string, string> = {
  STOCK: "cổ phiếu",
  ETF: "ETF",
  FUND: "quỹ",
  BOND: "trái phiếu",
  INDEX: "index",
};

interface CellAgg {
  count: number;
  barCount: number;
  lastBarDate: Date | null;
  newestQuoteAt: Date | null;
}

const EMPTY_AGG: CellAgg = {
  count: 0,
  barCount: 0,
  lastBarDate: null,
  newestQuoteAt: null,
};

function cellKey(market: string, type: string): string {
  return `${market}:${type}`;
}

/** Note "0 sản phẩm niêm yết" cụ thể theo ô (§1.2 — không bịa, không mơ hồ). */
const EMPTY_NOTES: Record<string, string> = {
  "HOSE:FUND": "HOSE không có quỹ đóng niêm yết — watcher re-probe Chủ nhật 04:00 ICT",
  "HNX:ETF": "HNX chưa có ETF niêm yết — watcher re-probe Chủ nhật 04:00 ICT",
  "HNX:FUND": "Quỹ đóng HNX đã tất toán/chuyển đổi — watcher re-probe Chủ nhật 04:00 ICT",
  "UPCOM:ETF": "UPCOM chưa có ETF niêm yết",
  "UPCOM:FUND": "UPCOM chưa có quỹ niêm yết",
  "HOSE:BOND": "Trái phiếu không giao dịch tại HOSE",
};

const BOND_PENDING_NOTE =
  "Trái phiếu có thật nhưng chưa có nguồn công khai xác minh được (finfo chặn egress)";

/** Quy tắc 3 trạng thái (§1.2) — bond HNX/UPCOM đặc biệt: 0 mã vẫn 🟡 chờ nguồn. */
function resolveStatus(market: string, type: string, a: CellAgg): CoverageStatus {
  if (a.count > 0 && a.barCount > 0) return "real";
  if (a.count > 0) return "pending-source"; // instrument đã seed, bar chưa đổ (US/HK)
  if ((market === "HNX" || market === "UPCOM") && type === "BOND") {
    return "pending-source"; // sản phẩm có thật, chưa có nguồn
  }
  return "empty";
}

function resolveNote(market: string, type: string, a: CellAgg): string {
  const status = resolveStatus(market, type, a);
  if (status === "real") {
    return market === "US" || market === "HK"
      ? "Bar EOD thật Yahoo Finance — job 06:15 ICT"
      : "Bar EOD thật dchart VNDIRECT — sync 15:45 ICT hằng ngày";
  }
  if (status === "pending-source") {
    if (type === "BOND") return BOND_PENDING_NOTE;
    // US/HK đã seed instrument nhưng chưa có bar
    return "Chờ sync Yahoo — job 06:15 ICT";
  }
  return EMPTY_NOTES[cellKey(market, type)] ?? "0 sản phẩm niêm yết";
}

function buildCell(
  market: string,
  type: string,
  agg: Map<string, CellAgg>,
  now: number
): CoverageCell {
  const a = agg.get(cellKey(market, type)) ?? EMPTY_AGG;
  return {
    market,
    type,
    status: resolveStatus(market, type, a),
    instrumentCount: a.count,
    barCount: a.barCount,
    lastBarDate: a.lastBarDate ? a.lastBarDate.toISOString() : null,
    quoteAgeMin: a.newestQuoteAt
      ? Math.max(0, Math.floor((now - a.newestQuoteAt.getTime()) / 60_000))
      : null,
    note: resolveNote(market, type, a),
  };
}

/** Ô quốc tế = gộp mọi loại trên 1 sàn (STOCK + ETF + INDEX + …) thành 1 ô. */
function buildIntlCell(
  market: string,
  agg: Map<string, CellAgg>,
  now: number
): CoverageCell {
  let merged: CellAgg = { ...EMPTY_AGG };
  const parts: string[] = [];
  for (const t of GRID_TYPES) {
    const a = agg.get(cellKey(market, t));
    if (!a || a.count === 0) continue;
    merged = {
      count: merged.count + a.count,
      barCount: merged.barCount + a.barCount,
      lastBarDate:
        !merged.lastBarDate || (a.lastBarDate && a.lastBarDate > merged.lastBarDate)
          ? a.lastBarDate
          : merged.lastBarDate,
      newestQuoteAt:
        !merged.newestQuoteAt ||
        (a.newestQuoteAt && a.newestQuoteAt > merged.newestQuoteAt)
          ? a.newestQuoteAt
          : merged.newestQuoteAt,
    };
    parts.push(`${a.count} ${TYPE_LABELS_VI[t] ?? t}`);
  }
  const composition =
    parts.length > 0 ? `${merged.count} mã (${parts.join(" · ")})` : "0 mã";
  const cell = buildCell(
    market,
    "MIXED",
    new Map([[cellKey(market, "MIXED"), merged]]),
    now
  );
  // Note quốc tế = note chuẩn kèm cơ cấu loại tài sản của sàn
  cell.note =
    merged.barCount > 0
      ? `${composition} — ${cell.note}`
      : `${composition} — chờ sync Yahoo — job 06:15 ICT`;
  return cell;
}

export async function GET() {
  try {
    const now = Date.now();
    // 5 query cố định, song song — KHÔNG N+1 (§3.7)
    const [instruments, barGroups, quoteGroups, sourceRows, fundamentalsCount] =
      await Promise.all([
        db.instrument.findMany({
          where: { isActive: true },
          select: { id: true, market: true, type: true },
        }),
        db.bar.groupBy({
          by: ["instrumentId"],
          _count: { _all: true },
          _max: { date: true },
        }),
        db.quote.groupBy({
          by: ["instrumentId"],
          _max: { tradedAt: true },
        }),
        db.dataSourceStatus.findMany(),
        db.financialFundamental.count(),
      ]);

    const barByInst = new Map(
      barGroups.map((g) => [g.instrumentId, { count: g._count._all, last: g._max.date }])
    );
    const quoteByInst = new Map(
      quoteGroups.map((g) => [g.instrumentId, g._max.tradedAt])
    );

    // Gộp in-memory theo (market × type) — chỉ tính instrument active
    const agg = new Map<string, CellAgg>();
    for (const inst of instruments) {
      const k = cellKey(inst.market, inst.type);
      let a = agg.get(k);
      if (!a) {
        a = { ...EMPTY_AGG };
        agg.set(k, a);
      }
      a.count++;
      const b = barByInst.get(inst.id);
      if (b) {
        a.barCount += b.count;
        if (b.last && (!a.lastBarDate || b.last > a.lastBarDate)) a.lastBarDate = b.last;
      }
      const q = quoteByInst.get(inst.id);
      if (q && (!a.newestQuoteAt || q > a.newestQuoteAt)) a.newestQuoteAt = q;
    }

    // 15 ô lưới nội địa — LUÔN đủ kể cả ô 0 sản phẩm (T14.1)
    const grid: CoverageCell[][] = GRID_MARKETS.map((m) =>
      GRID_TYPES.map((t) => buildCell(m, t, agg, now))
    );

    // Hàng quốc tế (US · HK) — gộp loại, trạng thái theo barCount
    const intlRow: CoverageCell[] = INTL_MARKETS.map((m) => buildIntlCell(m, agg, now));

    // Dòng cơ bản (finfo) — đọc DataSourceStatus key "fundamentals"
    const fundSource = sourceRows.find((s) => s.key === "fundamentals");
    const fundMode = fundSource?.mode ?? "pending";
    const fundamentalsRow: FundamentalsRow = {
      label: fundSource?.label ?? "Dữ liệu tài chính cơ bản (finfo)",
      mode: fundMode,
      status: fundMode === "real" ? "real" : "pending-source",
      rowsCount: fundamentalsCount,
      lastSuccessAt: fundSource?.lastSuccessAt
        ? fundSource.lastSuccessAt.toISOString()
        : null,
      note:
        fundMode === "real"
          ? `Báo cáo tài chính finfo VNDIRECT — ingest tuần · ${fundamentalsCount} dòng`
          : "pipeline pending-egress — finfo chặn egress từ sandbox, tự sáng khi deploy máy chủ có egress",
    };

    return NextResponse.json(
      toPlain({
        grid,
        intlRow,
        fundamentalsRow,
        generatedAt: new Date().toISOString(),
      } satisfies CoverageResponse)
    );
  } catch (err) {
    console.error("[api/coverage] GET failed:", err);
    return NextResponse.json(
      { error: "Không đọc được ma trận độ phủ thị trường." },
      { status: 500 }
    );
  }
}
