/**
 * Lightweight technical indicators for the Market Analyst agent prompt.
 * All functions are pure and operate on ascending close-price arrays.
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
