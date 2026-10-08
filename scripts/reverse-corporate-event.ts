/**
 * scripts/reverse-corporate-event.ts — CÔNG CỤ ĐẢO NGƯỢC auto-adjust
 * CorporateEvent (lớp an toàn chốt 8-3b — DATA_PLATFORM_BLUEPRINT v1.3 P1-1).
 *
 * Dùng khi heuristic tự điều chỉnh SAI (gap không phải corporate event thật):
 *   bun scripts/reverse-corporate-event.ts <corporateEventId | symbol>
 *
 * Hoạt động (gọi reverseCorporateEvent trong src/lib/corporate-events.ts):
 *   1. Đọc CorporateEvent row (status AUTO_ADJUSTED/SUSPECTED);
 *   2. Tìm AuditLog "CORPORATE_EVENT_AUTO_ADJUSTED" chứa pre-values từng bar;
 *   3. Restore OHLCV + value về giá trị TRƯỚC điều chỉnh;
 *   4. Đổi status row → REVERSED (scan sau KHÔNG tự adjust lại — quyết định
 *      người giữ) + AuditLog CORPORATE_EVENT_REVERSED.
 *
 * Xem danh sách event: GET /api/market/corporate-events?limit=50
 */
import { reverseCorporateEvent } from "../src/lib/corporate-events";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.log("Cách dùng: bun scripts/reverse-corporate-event.ts <corporateEventId | symbol>");
    console.log("Danh sách event gần nhất:");
    const events = await db.corporateEvent.findMany({
      orderBy: { date: "desc" },
      take: 15,
      include: { instrument: { select: { symbol: true } } },
    });
    for (const e of events) {
      console.log(
        `  ${e.id} · ${e.instrument.symbol} · ${e.date.toISOString().slice(0, 10)} · ${e.kind} · f=${e.ratio} · ${e.status} · ${e.source}`
      );
    }
    process.exit(0);
  }

  // arg là symbol → tìm event AUTO_ADJUSTED mới nhất của mã đó
  let eventId = arg;
  if (!/^[a-z0-9]{20,}$/i.test(arg)) {
    const inst = await db.instrument.findUnique({ where: { symbol: arg.toUpperCase() } });
    if (!inst) {
      console.error(`Không tìm thấy instrument symbol "${arg}"`);
      process.exit(1);
    }
    const ev = await db.corporateEvent.findFirst({
      where: { instrumentId: inst.id, status: "AUTO_ADJUSTED" },
      orderBy: { date: "desc" },
    });
    if (!ev) {
      console.error(`Không có event AUTO_ADJUSTED nào cho ${arg.toUpperCase()}`);
      process.exit(1);
    }
    eventId = ev.id;
    console.log(`Tìm thấy event ${ev.id} (${arg.toUpperCase()} · ${ev.date.toISOString().slice(0, 10)} · ${ev.kind})`);
  }

  const result = await reverseCorporateEvent(eventId);
  if (result.ok) {
    console.log(
      `✅ ĐÃ ĐẢO NGƯỢC: ${result.symbol} · event ${result.eventDate} · ${result.barsRestored} bar restore từ AuditLog · status → REVERSED (scan không tự adjust lại)`
    );
  } else {
    console.error(`❌ Không đảo ngược được: ${result.error}`);
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
