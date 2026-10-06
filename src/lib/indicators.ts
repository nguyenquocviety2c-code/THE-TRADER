/**
 * Technical indicators for the agent stack + Bộ tổng hợp Bayes (phiên #34).
 * All functions are pure and operate on ascending arrays (closes ascending by
 * date; bars ascending by date). Các hàm cũ (sma/rsi/pctChange/latestVsMean)
 * GIỮ NGUYÊN hành vi — phần mở rộng thêm MACD/Bollinger/ATR/OBV/Stochastic.
 */

/** Simple moving average of the last `period` closes; null if insufficient data. */
export function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}

/** Wilder's RSI (period default 14); null if insufficient data. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  // F-118 (audit 19-b): chuỗi giá PHẲNG (avgGain=0 && avgLoss=0) không có
  // xu hướng đo được → null; chỉ khi toàn gain (avgLoss=0, avgGain>0) mới là RSI 100 chuẩn Wilder
  if (avgLoss === 0 && avgGain === 0) return null; // chuỗi phẳng — không có xu hướng đo được
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Percent change between two numbers, rounded to 2 decimals. */
export function pctChange(from: number, to: number): number {
  if (from <= 0) return 0;
  return Math.round(((to - from) / from) * 100 * 100) / 100;
}

/** Ratio of the latest value to the mean of the trailing window (excl. latest). */
export function latestVsMean(series: number[], window: number): number | null {
  if (series.length < window + 1) return null;
  const latest = series[series.length - 1];
  const trailing = series.slice(series.length - 1 - window, series.length - 1);
  const mean = trailing.reduce((s, v) => s + v, 0) / window;
  if (mean <= 0) return null;
  return Math.round((latest / mean) * 100) / 100;
}

/* ══════════════ Phần mở rộng phiên #34 — Bộ tổng hợp Bayes ══════════════ */

/**
 * EMA chuẩn (exponential moving average): seed = SMA của `period` giá đầu,
 * sau đó EMA_t = α·y_t + (1−α)·EMA_{t−1} với α = 2/(period+1).
 * Trả về chuỗi EMA cùng chiều dài input (phần đầu null đến khi đủ seed).
 */
function ema(values: number[], period: number): (number | null)[] {
  if (values.length < period || period <= 0) return values.map(() => null);
  const alpha = 2 / (period + 1);
  const out: (number | null)[] = values.map(() => null);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** MACD (12, 26, 9) — giá trị MỚI NHẤT của macd line / signal line / histogram. */
export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

/** MACD chuẩn: EMA nhanh − EMA chậm, signal = EMA(macd, 9); null khi thiếu dữ liệu. */
export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): MacdResult | null {
  if (closes.length < slow + signalPeriod) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f != null && s != null) macdLine.push(f - s);
  }
  if (macdLine.length < signalPeriod) return null;
  const signalLine = ema(macdLine, signalPeriod);
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  if (lastSignal == null) return null;
  return { macd: lastMacd, signal: lastSignal, histogram: lastMacd - lastSignal };
}

/** Bollinger Bands (20, 2) — dải trên/dưới quanh SMA, %B vị trí giá trong dải. */
export interface BollingerResult {
  upper: number;
  mid: number;
  lower: number;
  /** %B = (last − lower) / (upper − lower); dải phẳng → 0.5. */
  percentB: number;
}

/** Bollinger Bands của `period` phiên cuối; null khi thiếu dữ liệu hoặc giá ≤ 0. */
export function bollinger(closes: number[], period = 20, mult = 2): BollingerResult | null {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const mid = window.reduce((s, v) => s + v, 0) / period;
  let sq = 0;
  for (const v of window) sq += (v - mid) * (v - mid);
  const sd = Math.sqrt(sq / period); // độ lệch chuẩn tổng thể (quy ước Bollinger)
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const last = closes[closes.length - 1];
  if (last <= 0) return null;
  const width = upper - lower;
  const percentB = width > 0 ? (last - lower) / width : 0.5;
  return { upper, mid, lower, percentB };
}

/** Thanh giá tối thiểu cho ATR/Stochastic/OBV. */
export interface PriceBar {
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/**
 * ATR (Average True Range, period 14) — làm mượt Wilder:
 * TR_t = max(high−low, |high−close_{t−1}|, |low−close_{t−1}|);
 * ATR seed = trung bình TR `period` phiên đầu, sau đó
 * ATR_t = (ATR_{t−1}×(period−1) + TR_t) / period.
 * Trả về ATR của phiên cuối; null khi thiếu dữ liệu.
 */
export function atr(bars: PriceBar[], period = 14): number | null {
  if (bars.length < period + 1 || period <= 0) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose)
    );
    trs.push(tr);
  }
  let value = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    value = (value * (period - 1) + trs[i]) / period;
  }
  return value;
}

/**
 * On-Balance Volume — chuỗi OBV đầy đủ (cùng chiều dài input):
 * OBV_0 = 0; OBV_t = OBV_{t−1} ± volume_t theo dấu close_t − close_{t−1}.
 */
export function obv(bars: { close: number; volume: number }[]): number[] {
  if (bars.length === 0) return [];
  const out: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const prev = out[i - 1];
    const diff = bars[i].close - bars[i - 1].close;
    out.push(diff > 0 ? prev + bars[i].volume : diff < 0 ? prev - bars[i].volume : prev);
  }
  return out;
}

/** Stochastic %K/%D — vị trí giá đóng trong dải cao/thấp gần nhất. */
export interface StochasticResult {
  k: number;
  d: number;
}

/**
 * Stochastic oscillator (14, 3): %K = (C − L_n)/(H_n − L_n)×100 (n = kPeriod),
 * %D = SMA của %K trên dPeriod phiên (Slow Stochastic). Null khi thiếu dữ liệu
 * hoặc dải phẳng (không đo được vị trí trong dải).
 */
export function stochastic(bars: PriceBar[], kPeriod = 14, dPeriod = 3): StochasticResult | null {
  if (bars.length < kPeriod + dPeriod - 1) return null;
  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < bars.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    const range = hh - ll;
    kValues.push(range > 0 ? ((bars[i].close - ll) / range) * 100 : 50);
  }
  const tail = kValues.slice(-dPeriod);
  const d = tail.reduce((s, v) => s + v, 0) / tail.length;
  return { k: kValues[kValues.length - 1], d };
}
