/**
 * scripts/set-signal-status.ts — Migration một lần cho schema delta PHASE3_BLUEPRINT §4.1
 *
 * Quy tắc回 fill trường Signal.status (mới, default "ACTIVE"):
 *   (a) actedAt != null            → "ACTED"
 *   (b) còn lại + expiresAt < now  → "EXPIRED"
 *   (c) còn lại                    → giữ "ACTIVE"
 *
 * Chạy: bun run scripts/set-signal-status.ts  (chỉ UPDATE tại chỗ, không xóa dữ liệu)
 */
import { db } from "../src/lib/db";

async function main() {
  console.log("🔧 Set Signal.status — migration tại chỗ (PHASE3_BLUEPRINT §4.1)\n");

  // (a) Đã chuyển thành lệnh → ACTED
  const acted = await db.signal.updateMany({
    where: { actedAt: { not: null }, status: "ACTIVE" },
    data: { status: "ACTED" },
  });

  // (b) Hết hạn (chưa acted) → EXPIRED
  const expired = await db.signal.updateMany({
    where: { actedAt: null, expiresAt: { lt: new Date() }, status: "ACTIVE" },
    data: { status: "EXPIRED" },
  });

  // (c) Còn lại giữ ACTIVE (default của cột mới) — đếm để in báo cáo
  const active = await db.signal.count({ where: { status: "ACTIVE" } });
  const total = await db.signal.count();

  console.log(`  (a) ACTED  : ${acted.count} tín hiệu (đã có actedAt)`);
  console.log(`  (b) EXPIRED: ${expired.count} tín hiệu (chưa acted + hết hạn)`);
  console.log(`  (c) ACTIVE : ${active} tín hiệu (giữ nguyên)`);
  console.log(`  Tổng cộng  : ${total} tín hiệu`);

  console.log("\n✅ Migration hoàn tất.");
}

main()
  .catch((e) => {
    console.error("❌ Migration lỗi:", e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
