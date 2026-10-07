/**
 * src/lib/risk/tail.ts — CRB-2 · HS-VaR/CVaR + CRB-3 · MONTE CARLO BOOTSTRAP
 * (CONTROL_RISK_QUANT_BLUEPRINT v1.1 §3 — phiên #51).
 *
 * CRB-2 Historical Simulation (chốt user #50 Q1 — empirical, KHÔNG giả định
 * chuẩn vì return VN đuôi FAT):
 *   r_p,t = Σᵢ wᵢ·rᵢ,t   (wᵢ = MVᵢ/NAV, cửa sổ 250 phiên; mã thiếu lịch sử
 *                          → thay return rổ cùng ngành, ghi proxy — làm ở engine)
 *   VaR95(1 phiên)  = −percentile(r_p, 5%) × NAV
 *   CVaR95(1 phiên) = −mean(r_p : r_p ≤ percentile5) × NAV
 *   VaR95(5 phiên)  = VaR95(1) × √5      (quy tắc căn bậc hai thời gian — CLT §8)
 * Percentile = order statistic gốc (sort Float64Array, không nội suy) —
 * deterministic.
 *
 * CRB-3 Monte Carlo bootstrap stress test:
 *   N_PATHS = 5.000 · HORIZON = 5 bước · RNG mulberry32(seed 777) deterministic
 *   mỗi path: 5 lần rút CÓ HOÀN TRẢ từ phân phối kinh nghiệm r_p (250 phiên)
 *   P&L_path = Π(1+r̃ⱼ) − 1
 *   P(chạm DD 15%) = |{path : DD_hiện_tại + lỗ_path > 15%}| / N_PATHS
 *
 * Thuần TypeScript, Float64Array, RNG mulberry32 viết tay — 0 dependency.
 */

/** Số path Monte Carlo (ràng buộc ngân sách §10: cắt 2.000 nếu chu kỳ chậm). */
export const MC_PATHS = 5_000;
/** Horizon MC (phiên) — khớp horizon VaR 5 phiên. */
export const MC_HORIZON = 5;
/** Seed RNG MC — deterministic, tái lập byte-identical (nghiệm thu CRB-3.1). */
export const MC_SEED = 777;
/** Cửa sổ Historical Simulation (phiên). */
export const HS_WINDOW = 250;

/** mulberry32 — RNG 32-bit deterministic (chuẩn codebase, xem ml/rl.ts). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Kết quả CRB-2. */
export interface TailResult {
  /** HS-VaR95 5 phiên (% NAV — số dương = mức lỗ). */
  var95Pct: number;
  /** HS-CVaR95 5 phiên (% NAV — luôn ≥ VaR, bất đẳng thức bắt buộc). */
  cvar95Pct: number;
  /** HS-VaR95 5 phiên (VND). */
  var95Vnd: number;
  /** HS-CVaR95 5 phiên (VND). */
  cvar95Vnd: number;
  /** VaR95 1 phiên (% NAV) — để đối chiếu. */
  var95OneDayPct: number;
  /** Số phiên trong cửa sổ HS thực dùng. */
  sessions: number;
}

/**
 * CRB-2 — HS-VaR/CVaR trên cửa sổ 250 phiên gần nhất của chuỗi return danh
 * mục r_p (dạng thập phân). NAV ≤ 0 → phần VND = 0 (caller ghi proxyMode).
 */
export function hsVarCvar(returns: Float64Array, nav: number): TailResult {
  const win = returns.subarray(Math.max(0, returns.length - HS_WINDOW));
  const n = win.length;
  if (n < 10) {
    // Không đủ nền tảng thống kê — không bịa số (§0.4), trả 0 + sessions
    // để engine quyết định proxy mode.
    return {
      var95Pct: 0,
      cvar95Pct: 0,
      var95Vnd: 0,
      cvar95Vnd: 0,
      var95OneDayPct: 0,
      sessions: n,
    };
  }
  const sorted = Float64Array.from(win).sort();
  // Order statistic gốc (không nội suy): index floor(5%·n) clamp [0, n−1]
  const idx = Math.min(n - 1, Math.max(0, Math.floor(0.05 * n)));
  const p5 = sorted[idx];
  // CVaR = −mean(tail từ 0..idx) — mọi phần tử ≤ percentile5
  let tailSum = 0;
  for (let i = 0; i <= idx; i++) tailSum += sorted[i];
  const cvar1 = -tailSum / (idx + 1);
  const var1 = -p5;

  const sqrt5 = Math.sqrt(5);
  const var5 = var1 * sqrt5;
  // Bất đẳng thức bắt buộc VaR ≤ CVaR mọi trường hợp (nghiệm thu CRB-2.3)
  const cvar5 = Math.max(var5, cvar1 * sqrt5);

  return {
    var95Pct: var5 * 100,
    cvar95Pct: cvar5 * 100,
    var95Vnd: Math.max(0, Math.round(var5 * nav)),
    cvar95Vnd: Math.max(0, Math.round(cvar5 * nav)),
    var95OneDayPct: var1 * 100,
    sessions: n,
  };
}

/** Kết quả CRB-3. */
export interface McResult {
  /** Lỗ percentile 5% của phân phối P&L 5 bước (% NAV — số dương). */
  mcLoss5Pct: number;
  /** P(lỗ > 2% NAV). */
  pLoss2: number;
  /** P(lỗ > 5% NAV). */
  pLoss5: number;
  /** P(chạm DD 15%) = |{path : ddNow + lỗ_path > 0,15}| / N_PATHS. */
  pDd: number;
  /** P&L path tệ nhất quan sát được (% NAV — số âm). */
  worstPathPct: number;
  /** MC-VaR 5% (% NAV) — đối chiếu chéo HS-VaR (sai lệch > 20% → log ở engine). */
  mcVarPct: number;
  paths: number;
}

/**
 * CRB-3 — Monte Carlo bootstrap stress test trên phân phối kinh nghiệm r_p.
 * Cùng seed → byte-identical giữa 2 lần chạy (nghiệm thu CRB-3.1).
 * ddNow: drawdown hiện tại (thập phân 0..1 — thiếu dữ liệu → 0).
 */
export function monteCarloStress(
  returns: Float64Array,
  options: { nav: number; ddNow: number; nPaths?: number; horizon?: number; seed?: number }
): McResult {
  const win = returns.subarray(Math.max(0, returns.length - HS_WINDOW));
  const n = win.length;
  const nPaths = options.nPaths ?? MC_PATHS;
  const horizon = options.horizon ?? MC_HORIZON;
  const seed = options.seed ?? MC_SEED;
  const ddNow = Math.max(0, Math.min(1, options.ddNow));
  if (n < 10 || options.nav <= 0) {
    return {
      mcLoss5Pct: 0,
      pLoss2: 0,
      pLoss5: 0,
      pDd: 0,
      worstPathPct: 0,
      mcVarPct: 0,
      paths: 0,
    };
  }

  const rng = mulberry32(seed);
  // Rút nguyên vị (bootstrap): floor(rng()·n) trên Float64Array gốc (không sort)
  const pl = new Float64Array(nPaths);
  let ddHits = 0;
  for (let p = 0; p < nPaths; p++) {
    let cum = 1;
    for (let h = 0; h < horizon; h++) {
      const idx = Math.min(n - 1, Math.floor(rng() * n));
      cum *= 1 + win[idx];
    }
    const pnl = cum - 1;
    pl[p] = pnl;
    if (ddNow - pnl > 0.15) ddHits++;
  }
  const sorted = Float64Array.from(pl).sort();
  const q = Math.min(nPaths - 1, Math.max(0, Math.floor(0.05 * nPaths)));
  const mcVar = -sorted[q];

  let over2 = 0;
  let over5 = 0;
  for (let p = 0; p < nPaths; p++) {
    if (sorted[p] < -0.02) over2++;
    if (sorted[p] < -0.05) over5++;
  }

  return {
    mcLoss5Pct: mcVar * 100,
    pLoss2: over2 / nPaths,
    pLoss5: over5 / nPaths,
    pDd: ddHits / nPaths,
    worstPathPct: sorted[0] * 100,
    mcVarPct: mcVar * 100,
    paths: nPaths,
  };
}

/** Đối chiếu chéo MC-VaR vs HS-VaR (nghiệm thu CRB-3.2 — sai lệch > 20% log). */
export function crossCheckMcVsHs(mc: McResult, hsVarPct: number): number {
  if (hsVarPct <= 1e-9) return 0;
  return Math.abs(mc.mcVarPct - hsVarPct) / hsVarPct;
}
