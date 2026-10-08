/**
 * Kiểm định fixbug #52-F1 — computeCorrelation ghép PHIÊN CHUNG theo NGÀY.
 *
 * Kịch bản: 2 chuỗi return 100 phiên, mỗi chuỗi thiếu ~5 phiên KHÁC NHAU
 * (mô phỏng đình quyền) → tập ngày chỉ giao nhau 89 phiên.
 *  - Hướng dẫn (manual): Pearson tính tay trên 60 phiên CHUNG gần nhất.
 *  - computeCorrelation (sau vá): phải khớp hướng dẫn sai số < 1e-12.
 *  - Hành vi CŨ (bug): ghép 60-mươi phần tử cuối theo INDEX → giá trị khác
 *    (return các ngày khác nhau bị ghép cặp) — in ra để đối chiếu.
 *  - Pairs dropping: chuỗi C chỉ giao 30 phiên với A → cặp (A,C) bị bỏ.
 */
import {
  computeCorrelation,
  pearson,
  type DatedReturn,
} from "../src/lib/risk/concentration";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// ── Dữ liệu deterministic ───────────────────────────────────────────────
let seed = 42;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const N = 100;
const dates = Array.from({ length: N }, (_, i) =>
  new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
);
// rb = 0,8·ra + nhiễu → tương quan cao; giá trị A/B cố định theo chuỗi gốc
const ra = Array.from({ length: N }, () => (rnd() - 0.5) * 0.04);
const rb = ra.map((v) => 0.8 * v + (rnd() - 0.5) * 0.01);

// A thiếu {10,25,40,55,70}, B thiếu {15,30,45,60,75,85} — lệch nhau hoàn toàn
const dropA = new Set([10, 25, 40, 55, 70]);
const dropB = new Set([15, 30, 45, 60, 75, 85]);
const A: DatedReturn[] = dates
  .map((date, i) => ({ date, ret: ra[i] }))
  .filter((_, i) => !dropA.has(i));
const B: DatedReturn[] = dates
  .map((date, i) => ({ date, ret: rb[i] }))
  .filter((_, i) => !dropB.has(i));

// ── Hướng dẫn: Pearson tay trên 60 phiên CHUNG gần nhất ────────────────
const mapA = new Map(A.map((x) => [x.date, x.ret]));
const commonAll = B.filter((x) => mapA.has(x.date)); // theo thứ tự B (tăng dần)
const tail = commonAll.slice(-60);
const aVals = tail.map((x) => mapA.get(x.date)!);
const expected = pearson(
  Float64Array.from(aVals),
  Float64Array.from(tail.map((x) => x.ret))
);
console.log(`Số phiên chung A∩B        : ${commonAll.length}`);
console.log(`Pearson hướng dẫn (60 chung): ${expected.toFixed(10)}`);

// ── computeCorrelation sau vá ───────────────────────────────────────────
const res = computeCorrelation([A, B]);
console.log(`computeCorrelation avgCorr : ${res.avgCorr.toFixed(10)} (n=${res.n}, dropped=${res.pairsDropped})`);
if (Math.abs(res.avgCorr - expected) > 1e-12) {
  fail(`avgCorr ${res.avgCorr} ≠ hướng dẫn ${expected}`);
}

// ── Hành vi CŨ (bug — ghép index) để đối chiếu ─────────────────────────
const oldWinA = Float64Array.from(A.slice(-60).map((x) => x.ret));
const oldWinB = Float64Array.from(B.slice(-60).map((x) => x.ret));
const oldVal = pearson(oldWinA, oldWinB);
console.log(`Hành vi CŨ (ghép index)    : ${oldVal.toFixed(10)} — lệch ${Math.abs(oldVal - expected).toFixed(6)} so với đúng`);
if (Math.abs(oldVal - expected) < 1e-9) {
  fail("Dữ liệu kiểm định không phân biệt được bug cũ — kịch bản yếu");
}

// ── Pairs dropping: C chỉ giao A 29 phiên, giao B 27 phiên ─────────────
const C: DatedReturn[] = dates
  .slice(60, 90)
  .map((date, i) => ({ date, ret: ra[60 + i] * 0.5 }));
const res3 = computeCorrelation([A, B, C]);
// (A,C): A thiếu {70} trong [60,89] → 29 phiên chung < 40 → bỏ
// (B,C): B thiếu {60,75,85} trong [60,89] → 27 phiên chung < 40 → bỏ
console.log(`3 chuỗi (C ngắn): avgCorr=${res3.avgCorr.toFixed(6)} dropped=${res3.pairsDropped}/3 cặp`);
if (res3.pairsDropped !== 2) {
  fail(`Muốn 2 cặp bị bỏ (A,C)+(B,C) vì < 40 phiên chung, nhận ${res3.pairsDropped}`);
}
if (Math.abs(res3.avgCorr - expected) > 1e-12) {
  fail(`avgCorr 3 chuỗi phải vẫn = cặp (A,B): ${res3.avgCorr} ≠ ${expected}`);
}

console.log("\nPASS — F1: computeCorrelation ghép PHIÊN CHUNG theo NGÀY chính xác.");
