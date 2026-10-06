/**
 * Migration một lần (Task 21-a — fix F-103): reset phiên giả lập cho toàn bộ
 * quote VN30 sau khi bổ sung EOD rollover + ngân sách khối lượng ngày.
 *
 * Bối cảnh: trước khi có rollover, simulator tick 24/7 làm khối lượng tích
 * luỹ vô hạn (SHB từng 307 triệu cp/phiên, tổng giá trị 391.188 tỷ ₫ —
 * phiếm thực tế). Script này áp dụng "phiên mới" cho mọi mã NGAY BÂY GIỜ:
 *   refPrice = last · dải ±7% mới · volume = 0 · OHLC = last · change = 0
 * — đúng trạng thái mà rollover nửa đêm ICT sẽ tạo ra. KHÔNG ghi Bar cho
 * "phiên vừa đóng" vì khối lượng tích luỹ ấy trải qua nhiều ngày giả lập,
 * không phải một phiên thật (nguyên tắc no-fabrication).
 *
 * Chạy: bun run scripts/fix-eod-reset.ts  (engine nên dừng khi chạy
 * để tránh cửa sổ đua read→write giữa tick và migration này)
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function round100(v: number): number {
  return Math.max(100, Math.round(v / 100) * 100);
}

async function main() {
  const now = new Date();
  const instruments = await db.instrument.findMany({
    where: { isActive: true },
    select: {
      id: true,
      symbol: true,
      quotes: { orderBy: { tradedAt: "desc" }, take: 1, select: { id: true, last: true } },
    },
  });

  let reset = 0;
  let skipped = 0;
  for (const inst of instruments) {
    const q = inst.quotes[0];
    if (!q || q.last <= 0) {
      skipped++;
      continue;
    }
    const ref = q.last;
    await db.quote.update({
      where: { id: q.id },
      data: {
        refPrice: ref,
        ceilingPrice: round100(ref * 1.07),
        floorPrice: round100(ref * 0.93),
        open: ref,
        high: ref,
        low: ref,
        change: 0,
        changePct: 0,
        volume: 0,
        tradedAt: now, // cùng ngày ICT → không kích hoạt rollover ghi Bar
      },
    });
    reset++;
  }

  // Đối chiếu bất biến sau reset
  const bad = await db.quote.count({
    where: { volume: { gt: 0 } },
  });

  console.log(`Reset ${reset} quote (bỏ qua ${skipped}) · volume>0 còn lại: ${bad}`);
  console.log("Mọi mã: refPrice=last, volume=0, dải ±7% mới, change=0.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
