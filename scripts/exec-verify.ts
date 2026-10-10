/**
 * scripts/exec-verify.ts — KIỂM ĐỊNH GÓI P0 EXECUTION_OPS_BLUEPRINT v1.1 §5
 * (phiên #70): E-P0-1 đơn nguồn phí + guard đơn vị · E-P0-2 ExecutionPlan +
 * guard deadline (tick phiên REV-7) · E-P0-3 ReconciliationReport 6 phép
 * idempotent (kèm order-fee-ledger REV-8 + whitelist REV-12) · E-P0-4
 * CommittedCashView (+PENDING REV-1) · E-P0-5 KPI funnel.
 *
 * Nguyên tắc (Fixbug §5 — như p2-verify): mỗi kiểm THỰC ĐO DB THÂT + nguồn
 * file, không tin lời commentaire; cài dữ liệu test tự tạo rồi DỌN SẠCH sau
 * mỗi phần (order/trade/signal/position/cash/checkpoint/RiskAlert).
 *
 * Cách chạy: env -u DATABASE_URL bun scripts/exec-verify.ts
 */
import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs";
import {
  FEE_RATE,
  TAX_RATE,
  getExecFeeTaxConfig,
  pctToFractionGuarded,
} from "../src/lib/exec/constants";
import {
  buildExecutionPlan,
  planToNote,
  parseExecutionPlan,
  planDeadlineExceeded,
  inSessionElapsedTicks,
} from "../src/lib/exec/plan";
import {
  runReconciliation,
  resetReconcileCheckpoint,
  RECONCILE_CHECKPOINT_KEY,
  type ReconciliationReport,
} from "../src/lib/exec/reconciliation";
import { computeCommittedCashView } from "../src/lib/exec/committed";
import { computeExecKpi, quantile } from "../src/lib/exec/kpi";

const db = new PrismaClient();

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function readSrc(rel: string): string {
  return fs.readFileSync(`src/${rel}`, "utf-8");
}

/* ═══════════════ A · E-P0-1 + E-P0-2 — hợp đồng & đơn nguồn ═══════════════ */

async function verifyContracts() {
  console.log("\n── A · E-P0-1/E-P0-2 hợp đồng: đơn nguồn phí + guard đơn vị + plan ──");

  // A1 — 3 nguồn phí cùng import 1 module, hết hardcode rải rác
  const tickSrc = readSrc("app/api/market/tick/route.ts");
  const sigSrc = readSrc("lib/signal-execution.ts");
  const constSrc = readSrc("lib/exec/constants.ts");
  check(
    "A1a tick route import từ exec/constants (không còn `const FEE_RATE = 0.0015`)",
    !tickSrc.includes("const FEE_RATE = 0.0015") &&
      !tickSrc.includes("const TAX_RATE = 0.001;") &&
      tickSrc.includes('from "@/lib/exec/constants"')
  );
  check(
    "A1b signal-execution hết literal 0.0015 + import đơn nguồn",
    !sigSrc.includes("0.0015 *") && sigSrc.includes('from "@/lib/exec/constants"')
  );
  check(
    "A1c FEE_RATE/TAX_RATE chỉ định nghĩa 1 nơi (exec/constants.ts)",
    constSrc.includes("export const FEE_RATE") && constSrc.includes("export const TAX_RATE") &&
      !tickSrc.includes("export const FEE_RATE") && !sigSrc.includes("export const FEE_RATE")
  );

  // A3 — guard đơn vị percent↔fraction (REV-2 — điều kiện bắt buộc #2)
  check(
    "A3a pctToFractionGuarded(0.15) = 0.0015 (percent → fraction đúng 100×)",
    pctToFractionGuarded(0.15, "feePct") === 0.0015
  );
  let threw = false;
  try {
    pctToFractionGuarded(15, "feePct"); // 15% → 0.15 fraction > biên 0.01 → throw
  } catch {
    threw = true;
  }
  check("A3b guard ném khi fraction vượt biên 0.01 (phát hiện sai đơn vị lệch 100×)", threw);
  threw = false;
  try {
    pctToFractionGuarded(-1, "feePct");
  } catch {
    threw = true;
  }
  check("A3c guard ném khi percent âm/không hợp lệ", threw);
  const cfg = getExecFeeTaxConfig();
  check(
    "A3d getExecFeeTaxConfig đọc roster A11: feeRate 0.0015 · taxRate 0.001 · source=roster",
    cfg.feeRate === 0.0015 && cfg.taxSellRate === 0.001 && cfg.source === "roster",
    `feePct=${cfg.feePct} taxSellPct=${cfg.taxSellPct}`
  );
  check(
    "A3e FEE_RATE/TAX_RATE khớp biểu phí VNDIRECT 0,15%/0,1%",
    FEE_RATE === 0.0015 && TAX_RATE === 0.001
  );

  // A2 — hợp đồng ExecutionPlan (build → note → parse round-trip + deadline)
  const plan = buildExecutionPlan({
    orderId: "test-order-id",
    quantity: 1000,
    price: 25_000,
    sizing: "nav5pct",
    humanNote: "Từ phê duyệt tín hiệu MUA VIC",
  });
  const note = planToNote(plan);
  const parsed = parseExecutionPlan(note);
  check(
    "A2a build → note JSON → parse round-trip đầy đủ trường",
    parsed != null &&
      parsed.kind === "ExecutionPlan" &&
      parsed.style === "SINGLE" &&
      parsed.slices.length === 1 &&
      parsed.slices[0].quantity === 1000 &&
      parsed.deadlineTicks === 1440 &&
      parsed.sizing === "nav5pct" &&
      parsed.humanNote.includes("VIC")
  );
  check(
    "A2b parse note thường (chuỗi cũ) → null; note null → null",
    parseExecutionPlan("Từ phê duyệt tín hiệu MUA VIC") === null &&
      parseExecutionPlan(null) === null &&
      parseExecutionPlan("") === null
  );
  check(
    "A2c plan mặc định: slippage 0.5% từ config A10 + deadline 1440 tick",
    plan.slippageBudgetPct === 0.5 && plan.deadlineTicks === 1440
  );

  // A2d — deadline đếm tick TRONG PHIÊN (REV-7): 2026-10-09 là thứ Sáu
  const fri = (h: number, m = 0) => new Date(`2026-10-09T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+07:00`);
  const ticks = inSessionElapsedTicks(fri(9, 15), fri(15, 30));
  check(
    "A2d 09:15→15:30 thứ 6 = 4h phiên liên tục = 1440 tick (bỏ nghỉ trưa)",
    ticks === 1440,
    `ticks=${ticks}`
  );
  check(
    "A2e 09:15→14:00 = 3,25h = 1170 tick — chưa vượt deadline 1440",
    inSessionElapsedTicks(fri(9, 15), fri(14, 0)) === 1170 &&
      !planDeadlineExceeded({ ...plan, deadlineTicks: 1440 }, fri(9, 15), fri(14, 0))
  );
  check(
    "A2f vượt deadline đúng 15:30 (1440 tick) — guard bật",
    planDeadlineExceeded({ ...plan, deadlineTicks: 1440 }, fri(9, 15), fri(15, 30))
  );
  check(
    "A2g T7→T2 không đếm tick (0 tick phiên) + nghỉ trưa bị bỏ",
    inSessionElapsedTicks(
      new Date("2026-10-10T09:15:00+07:00"),
      new Date("2026-10-12T09:15:00+07:00")
    ) === 0 &&
      inSessionElapsedTicks(fri(11, 0), fri(13, 30)) === 360
  );
}

/* ═══════════════ B · E-P0-3 — ReconciliationReport 6 phép ═══════════════ */

interface BContext {
  userId: string;
  accountId: string;
  instrumentId: string;
  sellInstrumentId: string | null;
  accountCashBefore: bigint;
  checkpointBefore: string | null;
}

async function plantFilledOrderTrade(
  ctx: BContext,
  opts: {
    side: "BUY" | "SELL";
    quantity: number;
    price: number;
    fee: bigint;
    tax: bigint;
    orderFee: bigint;
    withTrade: boolean;
    applyCash: boolean;
    applyPosition: boolean;
    sellFromQty: number;
  }
): Promise<{ orderId: string; cashDelta: bigint }> {
  const now = new Date();
  const notional = BigInt(opts.price * opts.quantity);
  const order = await db.order.create({
    data: {
      userId: ctx.userId,
      brokerAccountId: ctx.accountId,
      instrumentId: opts.side === "SELL" ? ctx.sellInstrumentId! : ctx.instrumentId,
      side: opts.side,
      type: "LIMIT",
      quantity: opts.quantity,
      price: opts.price,
      filledQuantity: opts.withTrade ? opts.quantity : 0,
      avgFillPrice: opts.withTrade ? opts.price : null,
      status: "FILLED",
      fee: opts.orderFee,
      submittedAt: now,
      filledAt: now,
      note: "exec-verify plant",
    },
  });
  if (opts.withTrade) {
    await db.trade.create({
      data: {
        orderId: order.id,
        instrumentId: order.instrumentId,
        side: opts.side,
        quantity: opts.quantity,
        price: opts.price,
        fee: opts.fee,
        tax: opts.tax,
        executedAt: now,
      },
    });
  }
  let cashDelta = BigInt(0);
  if (opts.applyCash) {
    cashDelta =
      opts.side === "BUY"
        ? -(notional + opts.fee)
        : notional - opts.fee - opts.tax;
    await db.brokerAccount.update({
      where: { id: ctx.accountId },
      data: { cashBalance: { decrement: -cashDelta } },
    });
  }
  if (opts.applyPosition) {
    const instrumentId = order.instrumentId;
    const existing = await db.position.findUnique({
      where: { brokerAccountId_instrumentId: { brokerAccountId: ctx.accountId, instrumentId } },
    });
    if (existing) {
      await db.position.update({
        where: { id: existing.id },
        data: { quantity: { increment: opts.side === "BUY" ? opts.quantity : -opts.quantity } },
      });
    } else {
      await db.position.create({
        data: {
          brokerAccountId: ctx.accountId,
          instrumentId,
          quantity: opts.side === "BUY" ? opts.quantity : -opts.quantity,
          avgPrice: opts.price,
          status: "OPEN",
        },
      });
    }
  }
  return { orderId: order.id, cashDelta };
}

async function unplant(
  ctx: BContext,
  planted: { orderId: string; cashDelta: bigint; side: "BUY" | "SELL"; quantity: number; instrumentId: string; appliedPosition: boolean; hadPositionBefore: boolean }
): Promise<void> {
  await db.order.delete({ where: { id: planted.orderId } }).catch(() => undefined); // Trade cascade
  if (planted.cashDelta !== BigInt(0)) {
    await db.brokerAccount.update({
      where: { id: ctx.accountId },
      data: { cashBalance: { decrement: planted.cashDelta } },
    });
  }
  if (planted.appliedPosition) {
    const existing = await db.position.findUnique({
      where: {
        brokerAccountId_instrumentId: {
          brokerAccountId: ctx.accountId,
          instrumentId: planted.instrumentId,
        },
      },
    });
    const delta = planted.side === "BUY" ? -planted.quantity : planted.quantity;
    if (existing) {
      const back = existing.quantity + delta;
      if (back === 0 && !planted.hadPositionBefore) {
        await db.position.delete({ where: { id: existing.id } });
      } else {
        await db.position.update({ where: { id: existing.id }, data: { quantity: back } });
      }
    }
  }
}

function failedNames(r: ReconciliationReport): string[] {
  return r.expectations.filter((e) => !e.ok).map((e) => e.name);
}

async function verifyReconciliation() {
  console.log("\n── B · E-P0-3 ReconciliationReport 6 phép idempotent ──");

  const user = await db.user.findFirst({ where: { isActive: true }, select: { id: true } });
  const account = await db.brokerAccount.findFirst({ where: { deletedAt: null }, select: { id: true, cashBalance: true } });
  const instrument = await db.instrument.findFirst({
    where: { isActive: true, type: "STOCK" },
    select: { id: true, symbol: true },
    orderBy: { symbol: "asc" },
  });
  if (!user || !account || !instrument) {
    check("B0 có user/account/instrument để cài dữ liệu test", false);
    return;
  }
  const ctx: BContext = {
    userId: user.id,
    accountId: account.id,
    instrumentId: instrument.id,
    sellInstrumentId: null,
    accountCashBefore: account.cashBalance,
    checkpointBefore: null,
  };
  const sellPos = await db.position.findFirst({
    where: { brokerAccountId: ctx.accountId, status: "OPEN", quantity: { gte: 200 } },
    select: { instrumentId: true, quantity: true },
  });
  ctx.sellInstrumentId = sellPos?.instrumentId ?? null;

  const cpRow = await db.appSetting.findUnique({ where: { key: RECONCILE_CHECKPOINT_KEY } });
  ctx.checkpointBefore = cpRow?.value ?? null;

  const plantedAlertIds: string[] = [];
  /** Sync — chạy reconciliation 1 lần để checkpoint bám trạng thái HIỆN TẠI.
   *  Sau mỗi unplant, write đảo ngược (ngoài fill-engine) rơi vào window của
   *  sync này → MISMATCH CÓ CHỦ ĐÍCH theo whitelist semantics REV-12 — không
   *  assert kết quả sync, chỉ dùng để re-baseline cho scenario kế tiếp. */
  const sync = () => runReconciliation();
  try {
    // B0 — reset checkpoint → baseline lần đầu
    await resetReconcileCheckpoint();
    const baseline = await runReconciliation();
    check(
      "B0 chưa có checkpoint → baseline=true, không đối chiếu mù cả lịch sử",
      baseline.baseline === true && baseline.verdict === "BALANCED" && baseline.expectations.length === 0
    );

    const Q = 300;
    const P = 20_000;
    const notional = Q * P;
    const correctFee = BigInt(Math.round(FEE_RATE * notional));

    // ── B1 — fee-recompute: BUY, fee sai +1000, còn lại nhất quán ──
    const wrongFee = correctFee + BigInt(1000);
    const b1 = await plantFilledOrderTrade(ctx, {
      side: "BUY", quantity: Q, price: P, fee: wrongFee, tax: BigInt(0),
      orderFee: wrongFee, withTrade: true, applyCash: true, applyPosition: true, sellFromQty: 0,
    });
    const posB1 = await db.position.findUnique({
      where: { brokerAccountId_instrumentId: { brokerAccountId: ctx.accountId, instrumentId: ctx.instrumentId } },
    });
    const r1 = await runReconciliation();
    check(
      "B1 trade fee sai 1 dòng → fee-recompute fail ĐÚNG 1 phép + verdict MISMATCH",
      failedNames(r1).length === 1 && failedNames(r1)[0] === "fee-recompute" && r1.verdict === "MISMATCH",
      `failed=[${failedNames(r1).join(",")}] diff=${r1.expectations.find((e) => e.name === "fee-recompute")?.diff}`
    );

    // B6 — MISMATCH → RiskAlert EXEC_RECONCILE_MISMATCH (từ r1)
    const alert = await db.riskAlert.findFirst({
      where: { code: "EXEC_RECONCILE_MISMATCH", acknowledgedAt: null },
      orderBy: { createdAt: "desc" },
    });
    check(
      "B6 MISMATCH → RiskAlert EXEC_RECONCILE_MISMATCH (không tự lành §6.3)",
      alert != null && alert.message.includes("fee-recompute")
    );
    if (alert) plantedAlertIds.push(alert.id);

    // B5 — idempotent: chạy lại NGAY (plant còn nguyên) → window mới không
    // chứa trade cũ (executedAt < checkpoint) → 0 giao dịch → BALANCED —
    // cùng 1 Trade KHÔNG bao giờ bị đếm 2 lần (giải G6)
    const alertsBefore = await db.riskAlert.count({ where: { code: "EXEC_RECONCILE_MISMATCH" } });
    const r1b = await runReconciliation();
    const alertsAfter = await db.riskAlert.count({ where: { code: "EXEC_RECONCILE_MISMATCH" } });
    check(
      "B5 chạy 2 lần liên tiếp → window không trùng → 0 giao dịch mới → BALANCED (không đếm trùng)",
      r1b.baseline === false && r1b.tradesCount === 0 && r1b.verdict === "BALANCED" && alertsAfter === alertsBefore,
      `trades=${r1b.tradesCount}`
    );
    await unplant(ctx, {
      orderId: b1.orderId, cashDelta: b1.cashDelta, side: "BUY", quantity: Q,
      instrumentId: ctx.instrumentId, appliedPosition: true, hadPositionBefore: posB1 != null && posB1.quantity !== Q,
    });
    await sync(); // hấp thụ reversal — re-baseline cho scenario sau

    // ── B2 — tax-recompute: SELL có vị thế, tax sai +500 ──
    if (ctx.sellInstrumentId && sellPos) {
      const sellQ = 200;
      const sellNotional = sellQ * P;
      const sellFee = BigInt(Math.round(FEE_RATE * sellNotional));
      const wrongTax = BigInt(Math.round(TAX_RATE * sellNotional)) + BigInt(500);
      const b2 = await plantFilledOrderTrade(ctx, {
        side: "SELL", quantity: sellQ, price: P, fee: sellFee, tax: wrongTax,
        orderFee: sellFee, withTrade: true, applyCash: true, applyPosition: true, sellFromQty: sellQ,
      });
      const alerts2Before = await db.riskAlert.count({ where: { code: "EXEC_RECONCILE_MISMATCH" } });
      const r2 = await runReconciliation();
      const alerts2After = await db.riskAlert.count({ where: { code: "EXEC_RECONCILE_MISMATCH" } });
      check(
        "B2 trade SELL thuế sai → tax-recompute fail đúng 1 phép + alert dedupe (không thêm alert mới)",
        failedNames(r2).length === 1 && failedNames(r2)[0] === "tax-recompute" && alerts2After === alerts2Before,
        `failed=[${failedNames(r2).join(",")}] alerts ${alerts2Before}→${alerts2After}`
      );
      await unplant(ctx, {
        orderId: b2.orderId, cashDelta: b2.cashDelta, side: "SELL", quantity: sellQ,
        instrumentId: ctx.sellInstrumentId, appliedPosition: true, hadPositionBefore: true,
      });
      await sync();
    } else {
      check("B2 (cần vị thế OPEN ≥200 cp — bỏ qua khi DB không có)", true, "skipped: không có vị thế thích hợp");
    }

    // ── B3 — order-coverage: Order FILLED KHÔNG có Trade ──
    const b3 = await plantFilledOrderTrade(ctx, {
      side: "BUY", quantity: Q, price: P, fee: BigInt(0), tax: BigInt(0),
      orderFee: BigInt(0), withTrade: false, applyCash: false, applyPosition: false, sellFromQty: 0,
    });
    const r3 = await runReconciliation();
    check(
      "B3 Order FILLED thiếu Trade → order-coverage fail đúng 1 phép",
      failedNames(r3).length === 1 && failedNames(r3)[0] === "order-coverage",
      `failed=[${failedNames(r3).join(",")}]`
    );
    await unplant(ctx, {
      orderId: b3.orderId, cashDelta: BigInt(0), side: "BUY", quantity: Q,
      instrumentId: ctx.instrumentId, appliedPosition: false, hadPositionBefore: false,
    });
    await sync();

    // ── B4 — cash-delta: trade nhất quán nhưng KHÔNG ghi cash (whitelist REV-12) ──
    const b4 = await plantFilledOrderTrade(ctx, {
      side: "BUY", quantity: Q, price: P, fee: correctFee, tax: BigInt(0),
      orderFee: correctFee, withTrade: true, applyCash: false, applyPosition: true, sellFromQty: 0,
    });
    const posB4 = await db.position.findUnique({
      where: { brokerAccountId_instrumentId: { brokerAccountId: ctx.accountId, instrumentId: ctx.instrumentId } },
    });
    const r4 = await runReconciliation();
    check(
      "B4 write cash ngoài fill-engine (không ghi) → cash-delta fail đúng 1 phép — semantics whitelist",
      failedNames(r4).length === 1 && failedNames(r4)[0] === "cash-delta",
      `failed=[${failedNames(r4).join(",")}]`
    );
    await unplant(ctx, {
      orderId: b4.orderId, cashDelta: BigInt(0), side: "BUY", quantity: Q,
      instrumentId: ctx.instrumentId, appliedPosition: true, hadPositionBefore: posB4 != null && posB4.quantity !== Q,
    });
    await sync();

    // ── B7 — order-fee-ledger (REV-8): Order.fee ≠ Σ Trade.fee ──
    const b7 = await plantFilledOrderTrade(ctx, {
      side: "BUY", quantity: Q, price: P, fee: correctFee, tax: BigInt(0),
      orderFee: correctFee + BigInt(999), withTrade: true, applyCash: true, applyPosition: true, sellFromQty: 0,
    });
    const posB7 = await db.position.findUnique({
      where: { brokerAccountId_instrumentId: { brokerAccountId: ctx.accountId, instrumentId: ctx.instrumentId } },
    });
    const r7 = await runReconciliation();
    check(
      "B7 Order.fee ≠ Σ Trade.fee (2 sổ phí) → order-fee-ledger fail đúng 1 phép (REV-8)",
      failedNames(r7).length === 1 && failedNames(r7)[0] === "order-fee-ledger",
      `failed=[${failedNames(r7).join(",")}]`
    );
    await unplant(ctx, {
      orderId: b7.orderId, cashDelta: b7.cashDelta, side: "BUY", quantity: Q,
      instrumentId: ctx.instrumentId, appliedPosition: true, hadPositionBefore: posB7 != null && posB7.quantity !== Q,
    });
    await sync();

    // B8 — sau sync cuối: window rỗng → BALANCED 6/6 phép
    const r8 = await runReconciliation();
    check(
      "B8 dọn hết dữ liệu cài → BALANCED 6/6 phép",
      r8.verdict === "BALANCED" && r8.expectations.length === 6 && r8.expectations.every((e) => e.ok),
      `trades=${r8.tradesCount}`
    );
  } finally {
    // Dọn: alert test + checkpoint về trạng thái gốc
    if (plantedAlertIds.length > 0) {
      await db.riskAlert.deleteMany({ where: { id: { in: plantedAlertIds } } });
    } else {
      await db.riskAlert.deleteMany({
        where: { code: "EXEC_RECONCILE_MISMATCH", createdAt: { gte: new Date(Date.now() - 3_600_000) } },
      });
    }
    if (ctx.checkpointBefore) {
      await db.appSetting.upsert({
        where: { key: RECONCILE_CHECKPOINT_KEY },
        create: { key: RECONCILE_CHECKPOINT_KEY, value: ctx.checkpointBefore },
        update: { value: ctx.checkpointBefore },
      });
    } else {
      await resetReconcileCheckpoint();
    }
    // Kiểm tra tiền mặt nguyên vẹn sau toàn bộ phần B
    const after = await db.brokerAccount.findUnique({
      where: { id: ctx.accountId },
      select: { cashBalance: true },
    });
    check(
      "B9 dọn sạch: tiền mặt account về đúng mức trước khi test",
      after != null && after.cashBalance === ctx.accountCashBefore,
      `${ctx.accountCashBefore} → ${after?.cashBalance}`
    );
  }
}

/* ═══════════════ C · E-P0-4 — CommittedCashView (+PENDING REV-1) ═══════════════ */

async function verifyCommitted() {
  console.log("\n── C · E-P0-4 CommittedCashView (ACTIVE + PENDING REV-1) ──");

  const account = await db.brokerAccount.findFirst({
    where: { deletedAt: null },
    select: { id: true, cashBalance: true, equity: true, marginUsed: true },
  });
  const instrument = await db.instrument.findFirst({
    where: { isActive: true, type: "STOCK" },
    select: { id: true },
    orderBy: { symbol: "asc" },
  });
  const agent = await db.agent.findFirst({ select: { id: true }, orderBy: { code: "asc" } });
  if (!account || !instrument || !agent) {
    check("C0 có account/instrument/agent để cài test", false);
    return;
  }
  const equity = Number(account.cashBalance) + 100_000_000; // equity đầu vào mô phỏng
  const input = {
    cash: Number(account.cashBalance),
    equity,
    marginUsed: Number(account.marginUsed),
    buyingPowerFactor: 0.5,
    marginRoomMinVnd: 500_000_000,
  };

  const base = await computeCommittedCashView(input);
  const plantedSignalIds: string[] = [];
  const plantedOrderIds: string[] = [];
  const user = await db.user.findFirst({ where: { isActive: true }, select: { id: true } });
  if (!user) {
    check("C0 có user active", false);
    return;
  }
  try {
    // C1 — 2 tín hiệu ACTIVE BUY → committedBuy tăng đúng 2 × equity × 5%
    for (let i = 0; i < 2; i++) {
      const s = await db.signal.create({
        data: {
          instrumentId: instrument.id,
          direction: "BUY",
          confidence: "MEDIUM",
          score: 70,
          rationale: "exec-verify committed test",
          agentId: agent.id,
          status: "ACTIVE",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      plantedSignalIds.push(s.id);
    }
    const withTwo = await computeCommittedCashView(input);
    const expected2 = 2 * equity * 0.05;
    check(
      "C1 2 tín hiệu ACTIVE → committedBuy tăng đúng 2 × nav5pct (≈5% NAV mỗi tín hiệu)",
      Math.abs(withTwo.committedBuyNotional - base.committedBuyNotional - expected2) < 1 &&
        withTwo.activeSignals === base.activeSignals + 2,
      `Δ=${Math.round(withTwo.committedBuyNotional - base.committedBuyNotional)} ≈ ${Math.round(expected2)}`
    );

    // C1b — tín hiệu EXPIRED → rời tập cam kết
    await db.signal.updateMany({
      where: { id: { in: plantedSignalIds } },
      data: { status: "EXPIRED" },
    });
    const afterExpire = await computeCommittedCashView(input);
    check(
      "C1b tín hiệu EXPIRED → committed giảm lại đúng mức ban đầu",
      Math.abs(afterExpire.committedBuyNotional - base.committedBuyNotional) < 1
    );

    // C2/C3 — REV-1: APPROVE thay tín hiệu bằng lệnh PENDING → không tụt mù
    // Giá đặt WAY-UNDER-MARKET (10% giá hiện tại) để fill engine thật KHÔNG
    // thể khớp trong lúc script chạy (BUY khớp khi last ≤ giá đặt).
    const quote = await db.quote.findFirst({
      where: { instrumentId: instrument.id },
      orderBy: { tradedAt: "desc" },
      select: { last: true },
    });
    const lastPx = quote?.last ?? 20_000;
    const price = Math.max(100, Math.round((lastPx * 0.1) / 100) * 100);
    await db.signal.updateMany({
      where: { id: { in: [plantedSignalIds[0]] } },
      data: { status: "ACTIVE" },
    });
    const beforeApprove = await computeCommittedCashView(input);
    // Giả lập APPROVE: tín hiệu → ACTED + lệnh PENDING notional ≈ equity×5%
    const qty = Math.max(100, Math.floor((equity * 0.05) / price / 100) * 100);
    await db.signal.update({
      where: { id: plantedSignalIds[0] },
      data: { status: "ACTED", actedAt: new Date() },
    });
    const order = await db.order.create({
      data: {
        userId: user.id,
        brokerAccountId: account.id,
        signalId: plantedSignalIds[0],
        instrumentId: instrument.id,
        side: "BUY",
        type: "LIMIT",
        quantity: qty,
        price,
        fee: BigInt(Math.round(FEE_RATE * price * qty)),
        status: "PENDING",
        note: "exec-verify committed pending test",
      },
    });
    plantedOrderIds.push(order.id);
    const afterApprove = await computeCommittedCashView(input);
    // Tín hiệu rời tập (−nav5pct) nhưng lệnh PENDING vào (+qty×price×(1+fee))
    // → chênh lệch chỉ do làm tròn lot 100 + phí ≈ nhỏ
    const lotRounding = 100 * price * (1 + FEE_RATE);
    const delta = afterApprove.committedBuyNotional - beforeApprove.committedBuyNotional;
    check(
      "C2 REV-1: APPROVE → tín hiệu rời ACTIVE nhưng lệnh PENDING vào tập cam kết — không tụt mù",
      Math.abs(delta) <= lotRounding && afterApprove.pendingOrders === base.pendingOrders + 1,
      `Δ=${Math.round(delta)} (dung sai làm tròn lot+phí ${Math.round(lotRounding)})`
    );
    check(
      "C3 committedBuyingPower = buyingPower − committedBuy (nhất quán công thức)",
      Math.abs(afterApprove.committedBuyingPower - (afterApprove.buyingPower - afterApprove.committedBuyNotional)) < 1
    );

    // C4 — lệnh khớp một phần: filledQuantity trừ đúng phần đã khớp
    await db.order.update({
      where: { id: order.id },
      data: { status: "PARTIALLY_FILLED", filledQuantity: 100, avgFillPrice: price },
    });
    const afterPartial = await computeCommittedCashView(input);
    const remainingNotional = (qty - 100) * price * (1 + FEE_RATE);
    check(
      "C4 PARTIALLY_FILLED → cam kết còn lại = (quantity − filled) × price (đúng phần chưa khớp)",
      Math.abs(
        afterPartial.committedBuyNotional - (afterApprove.committedBuyNotional - 100 * price * (1 + FEE_RATE))
      ) < 1,
      `remaining ≈ ${Math.round(remainingNotional)}`
    );
  } finally {
    await db.order.deleteMany({ where: { id: { in: plantedOrderIds } } });
    await db.signal.deleteMany({ where: { id: { in: plantedSignalIds } } });
  }
}

/* ═══════════════ D · E-P0-5 — KPI funnel ═══════════════ */

async function verifyKpi() {
  console.log("\n── D · E-P0-5 KPI funnel nhóm executive ──");

  const instrument = await db.instrument.findFirst({
    where: { isActive: true, type: "STOCK" },
    select: { id: true },
    orderBy: { symbol: "asc" },
  });
  const user = await db.user.findFirst({ where: { isActive: true }, select: { id: true } });
  const account = await db.brokerAccount.findFirst({ where: { deletedAt: null }, select: { id: true } });
  if (!instrument || !user || !account) {
    check("D0 có dữ liệu nền để test KPI", false);
    return;
  }

  const before = await computeExecKpi(30);

  const signalIds: string[] = [];
  const orderIds: string[] = [];
  try {
    // Cài: 2 ACTED + 1 EXPIRED + 1 ACTIVE (đều BUY) + 1 lệnh FILLED + 1 PENDING
    const mk = async (status: "ACTED" | "EXPIRED" | "ACTIVE", actedAt: Date | null) =>
      db.signal.create({
        data: {
          instrumentId: instrument.id,
          direction: "BUY",
          confidence: "MEDIUM",
          score: 60,
          rationale: "exec-verify kpi test",
          status,
          actedAt,
          expiresAt: status === "ACTIVE" ? new Date(Date.now() + 86_400_000) : new Date(),
        },
      });
    signalIds.push((await mk("ACTED", new Date())).id);
    signalIds.push((await mk("ACTED", new Date())).id);
    signalIds.push((await mk("EXPIRED", null)).id);
    signalIds.push((await mk("ACTIVE", null)).id);

    const filledOrder = await db.order.create({
      data: {
        userId: user.id,
        brokerAccountId: account.id,
        signalId: signalIds[0],
        instrumentId: instrument.id,
        side: "BUY",
        type: "LIMIT",
        quantity: 200,
        price: 20_000,
        filledQuantity: 200,
        avgFillPrice: 20_000,
        status: "FILLED",
        fee: BigInt(Math.round(FEE_RATE * 20_000 * 200)),
        filledAt: new Date(),
        note: "exec-verify kpi filled",
      },
    });
    orderIds.push(filledOrder.id);
    const pendingOrder = await db.order.create({
      data: {
        userId: user.id,
        brokerAccountId: account.id,
        instrumentId: instrument.id,
        side: "BUY",
        type: "LIMIT",
        quantity: 100,
        price: 100, // way-under-market — fill engine thật không thể khớp trong lúc test
        status: "PENDING",
        note: "exec-verify kpi pending",
      },
    });
    orderIds.push(pendingOrder.id);

    const after = await computeExecKpi(30);

    // D1 — "tính đúng bằng tay": so DELTA với công thức tay
    const expSignals = before.funnel.signals + 4;
    const expApproved = before.funnel.approved + 2;
    const expOrders = before.funnel.ordersCreated + 2;
    const expFilled = before.funnel.ordersFilled + 1;
    check(
      "D1a funnel đúng bằng tay: +4 tín hiệu · +2 duyệt · +2 lệnh · +1 khớp",
      after.funnel.signals === expSignals &&
        after.funnel.approved === expApproved &&
        after.funnel.ordersCreated === expOrders &&
        after.funnel.ordersFilled === expFilled,
      `${after.funnel.signals}/${expSignals} · ${after.funnel.approved}/${expApproved} · ${after.funnel.ordersCreated}/${expOrders} · ${after.funnel.ordersFilled}/${expFilled}`
    );
    check(
      "D1b approvePct đúng công thức approved/signals",
      after.approvePct === Math.round((expApproved / expSignals) * 1000) / 10,
      `${after.approvePct}%`
    );
    check(
      "D1c churnPct đúng công thức expired/signals",
      after.churnPct === Math.round(((before.funnel.expired + 1) / expSignals) * 1000) / 10,
      `expired ${before.funnel.expired}+1 / ${expSignals} = ${after.churnPct}%`
    );
    const prevFilled = before.funnel.ordersFilled;
    const prevAov = before.aovVnd ?? 0;
    const expAov = Math.round((prevAov * prevFilled + 4_000_000) / (prevFilled + 1));
    check(
      "D1d AOV đúng bằng tay (bình quân có trọng số lệnh mới 4tr ₫)",
      after.aovVnd != null && Math.abs(after.aovVnd - expAov) < 2,
      `aov=${after.aovVnd} ≈ ${expAov}`
    );
    check(
      "D1e slippage có thêm mẫu (khớp đúng giá đặt → 0% lệch)",
      after.slippage != null && after.slippage.n >= (before.slippage?.n ?? 0) + 1
    );

    // D2 — không KPI âm
    check(
      "D2 mọi số funnel ≥ 0 và phần trăm ∈ [0,100] hoặc null",
      after.funnel.signals >= 0 &&
        after.funnel.approved >= 0 &&
        after.funnel.ordersCreated >= 0 &&
        after.funnel.ordersFilled >= 0 &&
        after.funnel.holdCount >= 0 &&
        after.rejected >= 0 &&
        (after.approvePct == null || (after.approvePct >= 0 && after.approvePct <= 100)) &&
        (after.fillPct == null || (after.fillPct >= 0 && after.fillPct <= 100)) &&
        (after.churnPct == null || (after.churnPct >= 0 && after.churnPct <= 100))
    );
  } finally {
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
    await db.signal.deleteMany({ where: { id: { in: signalIds } } });
  }

  // D3 — quantile tuyến tính kiểu Pandas
  check(
    "D3 quantile([1,2,3,4], 0.5)=2,5 · 0.25=1,75 (nội suy tuyến tính)",
    quantile([1, 2, 3, 4], 0.5) === 2.5 && quantile([1, 2, 3, 4], 0.25) === 1.75
  );
}

/* ═══════════════ E · An toàn bất khả xâm phạm (§6.1/§6.2) ═══════════════ */

async function verifySafety() {
  console.log("\n── E · An toàn: chu kỳ không tự đặt lệnh · plan chỉ sau APPROVE ──");

  // E1 — chạy reconciliation + committed KHÔNG tạo Order nào
  const countBefore = await db.order.count();
  await runReconciliation();
  await computeCommittedCashView({
    cash: 1_000_000_000,
    equity: 2_000_000_000,
    marginUsed: 0,
    buyingPowerFactor: 0.5,
    marginRoomMinVnd: 500_000_000,
  });
  const countAfter = await db.order.count();
  check(
    "E1 runReconciliation + computeCommittedCashView không tạo Order (chu kỳ vô hại)",
    countAfter === countBefore,
    `${countBefore} → ${countAfter}`
  );

  // E1b — nguồn chu kỳ agents/run KHÔNG chứa order.create (bất khả xâm phạm §6.1)
  const runRoute = readSrc("app/api/agents/run/route.ts");
  check(
    "E1b agents/run route không có db.order.create (chu kỳ không tự đặt lệnh)",
    !runRoute.includes("order.create")
  );

  // E2 — buildExecutionPlan chỉ được gọi từ đường đã duyệt (signal-execution)
  const callers: string[] = [];
  for (const rel of [
    "lib/signal-execution.ts",
    "app/api/market/tick/route.ts",
    "app/api/agents/run/route.ts",
    "lib/agent-service-runs.ts",
    "lib/exec/reconciliation.ts",
    "lib/exec/committed.ts",
  ]) {
    if (readSrc(rel).includes("buildExecutionPlan(")) callers.push(rel);
  }
  check(
    "E2 buildExecutionPlan chỉ gọi trong signal-execution.ts (SAU APPROVE/convert) — không nơi khác",
    callers.length === 1 && callers[0] === "lib/signal-execution.ts",
    `callers=[${callers.join(",")}]`
  );

  // E3 — đổi biểu phí 1 chỗ: chỉ exec/constants.ts định nghĩa + mọi nơi import
  const tickSrc = readSrc("app/api/market/tick/route.ts");
  const reconSrc = readSrc("lib/exec/reconciliation.ts");
  const committedSrc = readSrc("lib/exec/committed.ts");
  check(
    "E3 fill engine + reconciliation + committed cùng import FEE_RATE/TAX_RATE đơn nguồn",
    tickSrc.includes('from "@/lib/exec/constants"') &&
      reconSrc.includes('from "@/lib/exec/constants"') &&
      committedSrc.includes('from "@/lib/exec/constants"')
  );
}

/* ═══════════════ Chạy toàn bộ ═══════════════ */

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  exec-verify — EXECUTION_OPS_BLUEPRINT v1.1 · P0 (phiên #70) ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  await verifyContracts();
  await verifyReconciliation();
  await verifyCommitted();
  await verifyKpi();
  await verifySafety();
  console.log(`\n→ KẾT QUẢ: ${pass} pass · ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("exec-verify crash:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
