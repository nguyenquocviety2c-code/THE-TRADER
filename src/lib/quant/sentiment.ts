/**
 * src/lib/quant/sentiment.ts — LEXICON SENTIMENT TIẾNG VIỆT (phiên #34).
 *
 * Thuật toán NLP từ điển (lexicon-based) THẬT — không LLM, deterministic:
 *  1. Tokenize: lowercase, bỏ dấu câu, tách theo khoảng trắng.
 *  2. Quét n-gram (3 → 2 → 1 từ, ưu tiên cụm dài nhất) đối chiếu từ điển
 *     polarity tài chính Việt Nam (~75 thuật ngữ thật).
 *  3. Phủ định: nếu từ đứng TRƯỚC cụm khớp là phủ định (không/chưa/chẳng/chả/
 *     đừng) thì đảo dấu polarity ("không tăng" → âm tính).
 *  4. score = (pos − neg) / max(1, pos + neg) ∈ [−1, 1].
 *
 * Pure functions — không DB, không side-effect.
 */

/** Các từ phủ định (window 1 từ đứng trước cụm khớp). */
const NEGATORS = new Set(["không", "chưa", "chẳng", "chả", "đừng"]);

/** Từ đơn mang polarity dương (xanh/tăng). */
const BULLISH_WORDS = new Set([
  "tăng", "xanh", "gom", "bật", "lãi", "mua", "thắng", "rót", "thâu", "hưởng",
  "vượt", "nâng",
]);

/** Từ đơn mang polarity âm (đỏ/giảm). */
const BEARISH_WORDS = new Set([
  "giảm", "đỏ", "bán", "lỗ", "sụt", "tụt", "rơi", "trượt", "âm", "sụp", "hạ",
]);

/** Cụm 2 từ dương. */
const BULLISH_BIGRAMS = new Set([
  "tăng trần", "tăng mạnh", "tăng tốc", "tăng trưởng", "tăng điểm", "tăng giá",
  "bật tăng", "bật lên", "mua ròng", "tích lũy", "tích luỹ", "tích cực",
  "thặng dư", "lợi nhuận", "kỷ lục", "phục hồi", "hồi phục", "thâu tóm",
  "nâng cấp", "vượt dự báo", "vượt đỉnh", "phá đỉnh", "bứt phá", "đột phá",
  "khởi sắc", "hưởng lợi", "nới lỏng", "rót vốn", "rót tiền", "thoát đáy",
  "quay tăng", "vượt trội", "lạc quan", "hấp dẫn", "tăng nhiệt",
]);

/** Cụm 2 từ âm. */
const BEARISH_BIGRAMS = new Set([
  "giảm mạnh", "giảm sâu", "giảm điểm", "giảm tốc", "bán ròng", "cắt lỗ",
  "thua lỗ", "bay màu", "xuống giá", "phá giá", "cảnh báo", "rủi ro",
  "đình trệ", "suy yếu", "thoát hiểm", "chạm sàn", "xả hàng", "lao dốc",
  "sụp giảm", "chốt lời", "quan ngại", "thất vọng", "bán mạnh", "khó khăn",
  "thu hẹp", "đứng trước", "bất ổn",
]);

/** Cụm 3 từ dương. */
const BULLISH_TRIGRAMS = new Set([
  "lợi nhuận kỷ lục", "dòng tiền rót", "khối ngoại mua", "nâng khuyến nghị",
  "dòng vốn rót", "mua ròng mạnh",
]);

/** Cụm 3 từ âm. */
const BEARISH_TRIGRAMS = new Set([
  "áp lực bán", "phát hành thêm", "khối ngoại bán", "hạ khuyến nghị",
  "lỗ kỷ lục", "bán ròng mạnh",
]);

/** Tokenize: lowercase → bỏ dấu câu/số → tách khoảng trắng. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"'`()[\]{}<>%€$¥₫•\-–—_/\\|+=*&^~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);
}

/** Một lần khớp polarity trong chuỗi token. */
interface LexHit {
  /** Cụm từ khớp (đã nối lại bằng khoảng trắng). */
  term: string;
  /** +1 bullish / −1 bearish (đã áp dụng phủ định). */
  polarity: 1 | -1;
}

/** Quét token: n-gram 3→2→1, ưu tiên cụm dài; phủ định lật dấu. */
function scanTokens(tokens: string[]): LexHit[] {
  const hits: LexHit[] = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    // Cụm 3 từ trước (dài nhất thắng)
    if (i + 2 < tokens.length) {
      const tri = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
      const polarity = BULLISH_TRIGRAMS.has(tri) ? 1 : BEARISH_TRIGRAMS.has(tri) ? -1 : 0;
      if (polarity !== 0) {
        const negated = i > 0 && NEGATORS.has(tokens[i - 1]);
        hits.push({ term: tri, polarity: (negated ? -polarity : polarity) as 1 | -1 });
        i += 3;
        matched = true;
      }
    }
    if (!matched && i + 1 < tokens.length) {
      const bi = `${tokens[i]} ${tokens[i + 1]}`;
      const polarity = BULLISH_BIGRAMS.has(bi) ? 1 : BEARISH_BIGRAMS.has(bi) ? -1 : 0;
      if (polarity !== 0) {
        const negated = i > 0 && NEGATORS.has(tokens[i - 1]);
        hits.push({ term: bi, polarity: (negated ? -polarity : polarity) as 1 | -1 });
        i += 2;
        matched = true;
      }
    }
    if (!matched) {
      const uni = tokens[i];
      const polarity = BULLISH_WORDS.has(uni) ? 1 : BEARISH_WORDS.has(uni) ? -1 : 0;
      if (polarity !== 0) {
        const negated = i > 0 && NEGATORS.has(tokens[i - 1]);
        hits.push({ term: uni, polarity: (negated ? -polarity : polarity) as 1 | -1 });
      }
      i += 1;
    }
  }
  return hits;
}

/**
 * Chấm điểm cảm xúc một tiêu đề/tin tức tài chính tiếng Việt.
 * score ∈ [−1, 1] = (pos − neg) / max(1, pos + neg); 0 = không có từ mang tính
 * hướng (neutral thật sự, không phải "chưa chấm").
 */
export function scoreNews(text: string): number {
  if (!text || !text.trim()) return 0;
  const hits = scanTokens(tokenize(text));
  if (hits.length === 0) return 0;
  let pos = 0;
  let neg = 0;
  for (const h of hits) {
    if (h.polarity > 0) pos++;
    else neg++;
  }
  return (pos - neg) / Math.max(1, pos + neg);
}

/** Alias ngữ nghĩa — chấm điểm một headline (đồng nhất với scoreNews). */
export const scoreHeadline = scoreNews;

/** Một mục tin để tổng hợp cảm xúc (title + summary tuỳ chọn). */
export interface SentimentItemInput {
  title: string;
  summary?: string | null;
}

/** Kết quả tổng hợp cảm xúc cả danh sách tin. */
export interface SentimentAggregate {
  /** Điểm trung bình các tin ∈ [−1, 1]. */
  score: number;
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  /** Mẫu ghi chú 3 tin tiêu biểu (để nhúng narrative/prompt). */
  sampleNotes: string[];
}

/** Ngưỡng coi một tin là có hướng (tránh nhiễu 1 từ yếu). */
const ITEM_BULLISH_THRESHOLD = 0.1;

/**
 * Tổng hợp cảm xúc danh sách tin: điểm trung bình + phân loại từng tin
 * (bullish nếu score > 0.1, bearish nếu < −0.1, còn lại neutral).
 */
export function aggregateSentiment(items: SentimentItemInput[]): SentimentAggregate {
  const scores = items.map((it) =>
    scoreNews([it.title, it.summary ?? ""].filter(Boolean).join(" — "))
  );
  let bullishCount = 0;
  let bearishCount = 0;
  let neutralCount = 0;
  const samples: { text: string; score: number }[] = items.map((it, i) => ({
    text: it.title,
    score: scores[i],
  }));
  for (const s of scores) {
    if (s > ITEM_BULLISH_THRESHOLD) bullishCount++;
    else if (s < -ITEM_BULLISH_THRESHOLD) bearishCount++;
    else neutralCount++;
  }
  const score = scores.length
    ? scores.reduce((s, v) => s + v, 0) / scores.length
    : 0;
  // Mẫu: 3 tin có |score| lớn nhất (tiêu biểu nhất)
  const sampleNotes = [...samples]
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 3)
    .filter((s) => Math.abs(s.score) > 0)
    .map(
      (s) =>
        `"${s.text.length > 70 ? s.text.slice(0, 70).trimEnd() + "…" : s.text}" (${s.score >= 0 ? "+" : ""}${s.score.toFixed(2)})`
    );
  return { score, bullishCount, bearishCount, neutralCount, sampleNotes };
}
