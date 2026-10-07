/**
 * prisma/expand-universe.ts — SEED UNIVERSE ĐA SÀN (B3 — MARKET_EXPANSION_BLUEPRINT v1.1)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Idempotent upsert theo `symbol` (unique TOÀN CỤC — mã đã tồn tại thì bỏ qua,
 * ví dụ SHB đã có từ #33). Mỗi mã VN được PROBE dchart TRƯỚC khi tạo — mã
 * trống → bỏ + log (không tạo instrument chết). Danh sách Appendix A là điểm
 * khởi đầu đã verified 2026-10-07; ứng viên bổ sung (UPCOM) cũng probe từng mã.
 *
 * Chạy (chuẩn):   env -u DATABASE_URL bun prisma/expand-universe.ts
 * Chạy (--intl):  env -u DATABASE_URL bun prisma/expand-universe.ts --intl
 *   --intl tạo Instrument US/HK (B12) — bar do intl-sync (Yahoo) đổ sau đó,
 *   KHÔNG probe dchart (dchart không có dữ liệu quốc tế).
 *
 * Sau seed → chạy deep backfill (B4): POST /api/market/eod-sync {force:"deep"}
 * hoặc env -u DATABASE_URL bun -e '…deepBackfillEod()'.
 */
import { PrismaClient } from "@prisma/client";
import { fetchDchartHistory } from "../src/lib/eod-sync";

const db = new PrismaClient();

interface Candidate {
  symbol: string;
  market: "HOSE" | "HNX" | "UPCOM" | "US" | "HK";
  type: "STOCK" | "ETF" | "INDEX";
  name: string;
  sector: string | null;
  currency: string;
}

/* ── Appendix A — HNX 21 mã ĐÃ VERIFIED probe 2026-10-07 (BAS/BIT trống bỏ) ── */
const HNX_STOCKS: Candidate[] = [
  { symbol: "PVS", market: "HNX", type: "STOCK", name: "Tổng CTCP Dịch vụ Kỹ thuật Dầu khí VN", sector: "Dầu khí", currency: "VND" },
  { symbol: "PVI", market: "HNX", type: "STOCK", name: "Tổng CTCP Bảo hiểm Dầu khí VN", sector: "Bảo hiểm", currency: "VND" },
  { symbol: "IDI", market: "HNX", type: "STOCK", name: "CTCP Đầu tư & Phát triển Công nghệ Viễn thông", sector: "Công nghệ", currency: "VND" },
  { symbol: "MCH", market: "HNX", type: "STOCK", name: "CTCP Mía đường Việt Trật", sector: "Tiêu dùng", currency: "VND" },
  { symbol: "NTP", market: "HNX", type: "STOCK", name: "Tổng CTCP Thép Việt Nam", sector: "Vật liệu", currency: "VND" },
  { symbol: "CEO", market: "HNX", type: "STOCK", name: "CTCP Tập đoàn C.E.O", sector: "Bất động sản", currency: "VND" },
  { symbol: "KLB", market: "HNX", type: "STOCK", name: "CTCP Thủy lợi Bắc Hưng Hải", sector: "Hạ tầng", currency: "VND" },
  { symbol: "NDN", market: "HNX", type: "STOCK", name: "CTCP Dược phẩm Nam Định", sector: "Y tế", currency: "VND" },
  { symbol: "BVS", market: "HNX", type: "STOCK", name: "CTCP Chứng khoán Bảo Việt", sector: "Chứng khoán", currency: "VND" },
  { symbol: "PET", market: "HNX", type: "STOCK", name: "LD Dịch vụ Sân bay Petrolimex", sector: "Năng lượng", currency: "VND" },
  // Danh sách còn lại (verified có dữ liệu dchart) — tên đầy đủ chưa xác minh 100%:
  ...["VCS", "TV2", "PGC", "SAM", "APC", "DMC", "PIT", "SBS", "CSM", "BSH"].map(
    (s): Candidate => ({ symbol: s, market: "HNX", type: "STOCK", name: `${s} (HNX)`, sector: "Khác", currency: "VND" })
  ),
];

/* ── UPCOM: 3 mã verified + ứng viên probe thêm (Appendix A) ── */
const UPCOM_STOCKS: Candidate[] = [
  { symbol: "QNP", market: "UPCOM", type: "STOCK", name: "CTCP Cảng Hạ Long", sector: "Cảng & Logistics", currency: "VND" },
  { symbol: "CLL", market: "UPCOM", type: "STOCK", name: "CTCP Cơ Điện Lạnh", sector: "Công nghiệp", currency: "VND" },
  { symbol: "BVB", market: "UPCOM", type: "STOCK", name: "Ngân hàng TMCP Bảo Việt", sector: "Ngân hàng", currency: "VND" },
  { symbol: "ACV", market: "UPCOM", type: "STOCK", name: "Tổng CTCP Sân bay Việt Nam", sector: "Hàng không", currency: "VND" },
  ...["VCA", "VFS", "C92", "SME", "PVX", "KLF", "CRE", "IDC", "S99", "KTT", "V11", "TUE", "PXM"].map(
    (s): Candidate => ({ symbol: s, market: "UPCOM", type: "STOCK", name: `${s} (UPCOM)`, sector: "Khác", currency: "VND" })
  ),
];

/* ── ETF HOSE — 5/5 verified probe (FUEMAFVN30, FUEKIP30, FUEHAT30, FUEBBB, FUEVIF trống bỏ) ── */
const HOSE_ETFS: Candidate[] = [
  { symbol: "E1VFVN30", market: "HOSE", type: "ETF", name: "DCVFM VN30 ETF", sector: "ETF", currency: "VND" },
  { symbol: "FUEVFVND", market: "HOSE", type: "ETF", name: "DCVFM VNDiamond ETF", sector: "ETF", currency: "VND" },
  { symbol: "FUESSVFL", market: "HOSE", type: "ETF", name: "SSIAM VNFIN LEAD ETF", sector: "ETF", currency: "VND" },
  { symbol: "FUEVN100", market: "HOSE", type: "ETF", name: "SSIAM VN100 ETF", sector: "ETF", currency: "VND" },
  { symbol: "FUEIP100", market: "HOSE", type: "ETF", name: "SSIAM IP100 ETF", sector: "ETF", currency: "VND" },
];

/* ── INDEX 8 mã verified probe (symbol dchart: "HNX"/"UPCOM" — KHÔPHN HNXINDEX/UPCOMINDEX) ── */
const INDEXES: Candidate[] = [
  { symbol: "VNINDEX", market: "HOSE", type: "INDEX", name: "VN-Index", sector: "Chỉ số", currency: "VND" },
  { symbol: "VN30", market: "HOSE", type: "INDEX", name: "VN30 Index", sector: "Chỉ số", currency: "VND" },
  { symbol: "VNMID", market: "HOSE", type: "INDEX", name: "VNMID Index", sector: "Chỉ số", currency: "VND" },
  { symbol: "VNSML", market: "HOSE", type: "INDEX", name: "VNSML Index", sector: "Chỉ số", currency: "VND" },
  { symbol: "VNALL", market: "HOSE", type: "INDEX", name: "VNALL Index", sector: "Chỉ số", currency: "VND" },
  { symbol: "HNX", market: "HNX", type: "INDEX", name: "HNX-Index", sector: "Chỉ số", currency: "VND" },
  { symbol: "HNX30", market: "HNX", type: "INDEX", name: "HNX30 Index", sector: "Chỉ số", currency: "VND" },
  { symbol: "UPCOM", market: "UPCOM", type: "INDEX", name: "UPCOM-Index", sector: "Chỉ số", currency: "VND" },
];

/* ── B12 — quốc tế Yahoo (Appendix A đề xuất mặc định, user đổi được) ── */
const INTL: Candidate[] = [
  { symbol: "AAPL", market: "US", type: "STOCK", name: "Apple Inc.", sector: "Công nghệ", currency: "USD" },
  { symbol: "MSFT", market: "US", type: "STOCK", name: "Microsoft Corp.", sector: "Công nghệ", currency: "USD" },
  { symbol: "NVDA", market: "US", type: "STOCK", name: "NVIDIA Corp.", sector: "Công nghệ", currency: "USD" },
  { symbol: "GOOGL", market: "US", type: "STOCK", name: "Alphabet Inc. (Class A)", sector: "Công nghệ", currency: "USD" },
  { symbol: "AMZN", market: "US", type: "STOCK", name: "Amazon.com Inc.", sector: "Bán lẻ", currency: "USD" },
  { symbol: "META", market: "US", type: "STOCK", name: "Meta Platforms Inc.", sector: "Công nghệ", currency: "USD" },
  { symbol: "TSLA", market: "US", type: "STOCK", name: "Tesla Inc.", sector: "Ô tô", currency: "USD" },
  { symbol: "JPM", market: "US", type: "STOCK", name: "JPMorgan Chase & Co.", sector: "Ngân hàng", currency: "USD" },
  { symbol: "^GSPC", market: "US", type: "INDEX", name: "S&P 500 Index", sector: "Chỉ số", currency: "USD" },
  { symbol: "^IXIC", market: "US", type: "INDEX", name: "Nasdaq Composite Index", sector: "Chỉ số", currency: "USD" },
  { symbol: "0700.HK", market: "HK", type: "STOCK", name: "Tencent Holdings Ltd.", sector: "Công nghệ", currency: "HKD" },
  { symbol: "0005.HK", market: "HK", type: "STOCK", name: "HSBC Holdings plc", sector: "Ngân hàng", currency: "HKD" },
  { symbol: "3888.HK", market: "HK", type: "STOCK", name: "Kingsoft Cloud Holdings", sector: "Công nghệ", currency: "HKD" },
  { symbol: "^HSI", market: "HK", type: "INDEX", name: "Hang Seng Index", sector: "Chỉ số", currency: "HKD" },
];

/** Probe dchart 60 ngày — mã có dữ liệu (có bar hợp lệ) mới được tạo. */
async function probeHasData(symbol: string): Promise<boolean> {
  try {
    const toSec = Math.floor(Date.now() / 1000) + 86_400;
    const res = await fetchDchartHistory({
      symbol,
      fromUnixSec: toSec - 60 * 86_400,
      toUnixSec: toSec,
      timeoutMs: 15_000,
    });
    if (res.empty) return false;
    return res.bars.c.some((c) => Number.isFinite(c) && c > 0);
  } catch {
    return false; // lỗi mạng/cấu hình → coi như chưa xác minh, KHÔNG tạo
  }
}

async function main() {
  const intl = process.argv.includes("--intl");
  const candidates = intl
    ? INTL
    : [...HNX_STOCKS, ...UPCOM_STOCKS, ...HOSE_ETFS, ...INDEXES];

  const existing = new Set(
    (await db.instrument.findMany({ select: { symbol: true } })).map((i) => i.symbol)
  );

  let created = 0;
  let skippedExisting = 0;
  const skippedEmpty: string[] = [];

  for (const c of candidates) {
    if (existing.has(c.symbol)) {
      skippedExisting++;
      continue;
    }
    // Probe-trước-khi-tạo (chỉ mã VN — dchart; quốc tế do Yahoo xác minh lúc sync)
    if (!intl && !(await probeHasData(c.symbol))) {
      skippedEmpty.push(c.symbol);
      console.log(`  ⚪ BỎ ${c.symbol} (${c.market}) — probe dchart trống`);
      continue;
    }
    await db.instrument.create({
      data: {
        symbol: c.symbol,
        name: c.name,
        market: c.market,
        type: c.type,
        sector: c.sector,
        currency: c.currency,
        isActive: true,
      },
    });
    existing.add(c.symbol);
    created++;
    console.log(`  ✅ TẠO ${c.symbol} — ${c.market}/${c.type}${intl ? " (chờ intl-sync đổ bar)" : ""}`);
  }

  console.log(
    `\nTổng kết: tạo ${created} · đã tồn tại ${skippedExisting} · probe trống ${skippedEmpty.length}${skippedEmpty.length ? ` (${skippedEmpty.join(", ")})` : ""}`
  );

  // T3.1 — đếm theo (market × type) sau seed
  const byMT = await db.instrument.groupBy({ by: ["market", "type"], _count: true });
  console.log("Phân bố universe:");
  for (const r of byMT) console.log(`  ${r.market}/${r.type}: ${r._count}`);
}

main()
  .catch((err) => {
    console.error("Seed THẤT BẠI:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
