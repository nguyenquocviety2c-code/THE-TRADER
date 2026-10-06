import { db } from "@/lib/db";
import { markSource } from "@/lib/sources";
import { vnDateIso } from "@/lib/market-session";

/**
 * S6 — Alternative data: dòng khối ngoại ròng (DATA_SOURCES.md §4.4).
 *
 * Nguồn ngoài (HOSE/HNX EOD, tổng hợp CafeF) chưa khả dụng trong môi trường
 * này → dùng mô phỏng DETERMINISTIC theo (mã, ngày) trên thanh khoản thật
 * từ DB, gắn nhãn mode="simulated" rõ ràng — tuân thủ nguyên tắc
 * "no fabrication": agent được báo rõ đây là dữ liệu mô phỏng.
 *
 * Mapping rủi ro: dòng ròng âm mạnh → RiskAlert WARNING
 * (metricKey "market.foreign_flow.net" — đúng theo tài liệu).
 *
 * F-109/F-211/F-212 (audit 19-b): quy mô dòng ròng ≈ 0.5–6% GTGD theo
 * thanh khoản (hệ số seeded theo mã), clamp 2–80 tỷ VND; ranh giới ngày và
 * asOf cố định theo ICT (15:00 của ngày tính) — deterministic trong ngày.
 */

export interface ForeignFlowItem {
  symbol: string;
  netValue: number; // VND (dương = mua ròng)
}

export interface FlowsSummary {
  mode: "live" | "simulated";
  asOf: string;
  totalNet: number;
  totalBuy: number;
  totalSell: number;
  topNet: ForeignFlowItem[]; // mua ròng lớn nhất
  topSell: ForeignFlowItem[]; // bán ròng lớn nhất
  note: string;
}

/** FNV-1a hash → PRNG deterministic theo (symbol, ngày). */
function seededUnit(symbol: string, dateIso: string): number {
  let h = 2166136261;
  const s = `${symbol}|${dateIso}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000; // [0, 1)
}

/** Best-effort nạp từ nguồn ngoài — hiện sẽ fail trong sandbox → fallback. */
async function tryExternalFlows(): Promise<FlowsSummary | null> {
  try {
    const res = await fetch("https://cafef.vn/thi-truong-chung-khoan.rss", {
      method: "GET",
      headers: { "User-Agent": "TheTraderBot/1.0" },
      signal: AbortSignal.timeout(5_000),
    });
    // Nguồn EOD chuyên dụng chưa mở → không parse từ RSS thường.
    if (!res.ok) return null;
    return null;
  } catch {
    return null;
  }
}

export async function getForeignFlows(): Promise<FlowsSummary> {
  const external = await tryExternalFlows();
  if (external) {
    await markSource("foreign-flows", { mode: "live", success: true, meta: { provider: "external" } });
    return external;
  }

  // ── Mô phỏng deterministic từ thanh khoản thật ──────────────────
  const instruments = await db.instrument.findMany({
    where: { isActive: true },
    select: {
      symbol: true,
      quotes: {
        orderBy: { tradedAt: "desc" },
        take: 1,
        select: { last: true, volume: true },
      },
    },
  });

  // F-212 (audit 19-b): ranh giới ngày theo ICT (15:00 ICT lùi về 0h cùng ngày),
  // không theo UTC — cùng 1 phiên cho ra cùng dateIso dù chạy trước/sau nửa đêm UTC
  const dateIso = vnDateIso(new Date());
  const items: ForeignFlowItem[] = [];
  let totalBuy = 0;
  let totalSell = 0;

  for (const inst of instruments) {
    const q = inst.quotes[0];
    if (!q || q.last <= 0) continue;
    const turnover = q.volume * q.last; // giá trị giao dịch phiên
    // F-109 (audit 19-b): hệ số 0.5%–6% theo thanh khoản (doc §4.4), seeded theo (mã, ngày)
    const pct = 0.005 + seededUnit(inst.symbol, dateIso) * 0.055; // 0.5%–6% theo thanh khoản (doc §4.4)
    // Quy mô dòng ròng ≈ pct × thanh khoản, giới hạn 2–80 tỷ VND
    const scale = Math.min(8e10, Math.max(2e9, turnover * pct));
    const unit = seededUnit(inst.symbol, dateIso) * 2 - 1; // [-1, 1)
    const net = Math.round(unit * scale);
    if (net >= 0) totalBuy += net;
    else totalSell += -net;
    items.push({ symbol: inst.symbol, netValue: net });
  }

  const totalNet = totalBuy - totalSell;
  const sortedAsc = [...items].sort((a, b) => b.netValue - a.netValue);
  const summary: FlowsSummary = {
    mode: "simulated",
    // F-211 (audit 19-b): asOf cố định = mốc đóng phiên 15:00 ICT của ngày tính —
    // hai lần gọi cùng ngày cho cùng asOf (deterministic tuyệt đối)
    asOf: `${dateIso}T08:00:00.000Z`, // 15:00 ICT (UTC+7)
    totalNet,
    totalBuy,
    totalSell,
    topNet: sortedAsc.slice(0, 5),
    topSell: sortedAsc.slice(-5).reverse(),
    note: "Mô phỏng deterministic theo thanh khoản thật — nguồn EOD khối ngoại chưa kết nối",
  };

  await markSource("foreign-flows", {
    mode: "simulated",
    success: true,
    meta: {
      totalNet,
      dateIso,
      provider: "internal-simulator",
    },
  });

  // S6 mapping: dòng âm mạnh → RiskAlert (dedupe 1 alert/ngày)
  if (totalNet < -3e11) {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const dup = await db.riskAlert.findFirst({
      where: { code: "FOREIGN_FLOW_OUTFLOW", createdAt: { gte: since } },
      select: { id: true },
    });
    if (!dup) {
      const alert = await db.riskAlert.create({
        data: {
          severity: "WARNING",
          code: "FOREIGN_FLOW_OUTFLOW",
          message: `Khối ngoại bán ròng mạnh ~${Math.round(-totalNet / 1e9)} tỷ ₫ (mô phỏng) — cân nhắc rủi ro áp lực cung khi duy trì/ mở vị thế mới.`,
          metricKey: "market.foreign_flow.net",
          metricValue: Math.round(totalNet / 1e9),
          threshold: -300,
        },
      });
      // F-206 (audit 19-b): phủ audit runtime cho mọi RiskAlert được tạo
      await db.auditLog
        .create({
          data: {
            action: "RISK_ALERT_RAISED",
            entity: "RiskAlert",
            entityId: alert.id,
            after: JSON.stringify({ code: alert.code, metricValue: alert.metricValue, threshold: alert.threshold }),
          },
        })
        .catch(() => undefined);
    }
  }

  return summary;
}

/** Block ngắn gọn để nhúng vào prompt agent (S6 context). */
export function flowsPromptBlock(flows: FlowsSummary): string {
  const ty = (v: number) => `${(v / 1e9).toFixed(1)} tỷ ₫`;
  const topBuy = flows.topNet.map((f) => `${f.symbol} +${(f.netValue / 1e9).toFixed(1)}t`).join(", ");
  const topSell = flows.topSell.map((f) => `${f.symbol} ${(f.netValue / 1e9).toFixed(1)}t`).join(", ");
  return [
    `DÒNG KHỐI NGOẠI RÒNG (S6 · ${flows.mode === "live" ? "nguồn ngoài" : "MÔ PHỎNG deterministic"}):`,
    `- Tổng mua ròng/bán ròng: ${flows.totalNet >= 0 ? "+" : ""}${ty(flows.totalNet)} (mua ${ty(flows.totalBuy)} / bán ${ty(flows.totalSell)})`,
    `- Mua ròng lớn nhất: ${topBuy || "—"}`,
    `- Bán ròng lớn nhất: ${topSell || "—"}`,
    flows.mode === "simulated" ? "- (Lưu ý: số liệu mô phỏng — khai báo rõ trong phân tích)" : "",
  ]
    .filter(Boolean)
    .join("\n");
}
