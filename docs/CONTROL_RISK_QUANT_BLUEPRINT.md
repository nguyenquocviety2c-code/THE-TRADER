# CONTROL BLUEPRINT — ỦY BAN KIỂM SOÁT ĐỊNH LƯỢNG (QUANT RISK ENGINE)

> **Project:** The Trader — Hệ thống giao dịch đa agent (VNDIRECT)
> **Document:** `docs/CONTROL_RISK_QUANT_BLUEPRINT.md` · **Version:** 1.1 (chốt 5 câu hỏi §9 + review toàn văn vá 7 lỗi) · **Updated:** 2026-10-07
> **Status:** **ĐÃ CHỐT THIẾT KẾ — CHỜ LỆNH TRIỂN KHAI** theo 2 đợt G1 → G2 (user #50: chưa triển khai vội, chỉ xác nhận thiết kế)
> **Cross-refs:** [MARKET_EXPANSION_BLUEPRINT.md](./MARKET_EXPANSION_BLUEPRINT.md) (B7 ensemble · B8 scorecard · B9 cổng đồng thuận) · [ML_LEARNING_BLUEPRINT.md](./ML_LEARNING_BLUEPRINT.md) (kế hoạch tương lai Phòng Học máy) · [DB_SCHEMA.md](./DB_SCHEMA.md) · [TECHNICAL_BLUEPRINT.md](./TECHNICAL_BLUEPRINT.md)
> **Changelog v1.1 (phiên #50):** Chốt §9 — Q1 HS-VaR · Q2 **CHO PHÉP NỚI** hạn mức khi thị trường yên bình (mult ∈ [0,6 · 1,15], trần +15% cứng) → sửa §0.3 + CRB-1 + nghiệm thu · Q3/Q4 theo đề xuất · Q5 triển khai 2 đợt. Review toàn văn vá 7 lỗi: (a) tham chiếu treo CRB-11/CRB-12 → CRB-0/UI-G1; (b) sai vị trí dấu căn giới hạn EWMA chart CRB-8 (phải NHÂN √(μ/(2−μ))) + tách ký hiệu μ (chart) khỏi λ (RiskMetrics); (c) ngữ nghĩa P(chạm DD) trong MC CRB-3 → tỉ lệ path; (d) mâu thuẫn vị trí file CRB-6 (ml/ → risk/forecast.ts); (e) ký tự lạ lọt vào nghiệm thu CRB-6; (f) lỗi đánh máy CRB-7; (g) diễn đạt gap §1.2.
> **Người soạn:** Kỹ sư AI / Kiến trúc sư hệ thống (phiên #49–#50)

---

## §0. Nguyên tắc nền tảng (BẤT BIẾN — không thương lượng)

1. **VETO vẫn là luật cứng trong mã** (AUD-CODE #6). Toàn bộ thuật toán trong blueprint này phục vụ **đo lường, dự báo, điều chỉnh hạn mức động** — KHÔNG BAO GIỜ thay phán quyết binary của Ủy ban bằng xác suất. Xác suất chỉ có 2 lối ra: (a) bằng chứng vào Bộ tổng hợp Bayes, (b) cảnh báo RiskAlert. Nguyên văn `consensus.ts`: *"VETO Ủy ban Kiểm soát vẫn TUYỆT ĐỐI — cổng không vượt veto"* — quant engine cũng chịu ràng buộc này.
2. **Viết tay TypeScript thuần** — đúng phong cách codebase: `Float64Array` phẳng, RNG `mulberry32` seed cố định (deterministic, tái lập được), 0 dependency mới, 0 chi phí LLM.
3. **Một nguồn sự thật cho hạn mức**: roster config (`agent-roster.ts`, AUD-CODE #15) vẫn là gốc; hệ số động điều chỉnh **hai chiều có trần** (sửa v1.1 theo user #50 Q2): SIẾT khi biến động cao hơn mốc bình thường, NỚI tối đa +15% khi thị trường yên bình hơn mốc — multiplier ∈ [0,6 · 1,15]. Mọi lần NỚI (mult > 1) phát RiskAlert INFO để kiểm toán; trần 1,15 là cứng trong mã.
4. **Không bịa dữ liệu** (văn hoá hệ thống): danh mục rỗng/thiếu lịch sử → quant engine chạy **chế độ proxy** trên rổ top-10 thanh khoản và GHI RÕ `proxyMode: true` trong snapshot + UI. Không tô đỏ/đen bằng số liệu rỗng.
5. **Schema additive** — không phá cột cũ, không migration destructive (chuẩn mọi blueprint trước).
6. **Chống đếm kép (T7.5)**: bằng chứng quant vào Bayes đúng MỘT lần với `source` riêng (`quant-tail:`, `quant-drift:`) — không trùng phiếu llm-vote của 6 cử tri; quant KHÔNG thêm cử tri thứ 7 cho cổng đồng thuận 80%.

---

## §1. Hiện trạng & 6 khoảng trống (đối chiếu mã nguồn phiên #49)

| # | Khoảng trống (file hiện tại) | Hệ quả | Gói | Bước vá |
|---|---|---|---|---|
| 1 | Hạn mức tĩnh 40%/25%/15% mọi chế độ thị trường (`agent-roster.ts` config) | Biến động 3%/ngày vẫn cho vị thế 25% NAV như lúc yên bình | P1 | CRB-1 |
| 2 | Exposure A7 chỉ check ngành/vị thế **LỚN NHẤT** (`runExposure`) | 3 ngành 39/39/20% NAV → HHI 0,34 ≈ chỉ ~3 ngành hiệu quả, nhưng A7 vẫn báo "ĐẠT" vì mỗi ngành < 40% | P2 | CRB-4 |
| 3 | Không có VaR/CVaR — không ai trả lời "P(lỗ > x% NAV trong 5 phiên)?" | Risk Manager A6 chỉ suy luận định tính trên snapshot | P1 | CRB-2, CRB-3 |
| 4 | Không dự báo drawdown — chỉ biết DD hiện tại (maxDrawdown trong backtest A14) | Phát hiện muộn, phản ứng sau khi chạm ngưỡng | P1+P3 | CRB-3, CRB-6, CRB-8 |
| 5 | Không đo tương quan giữa các vị thế | 8 mã "khác nhau" cùng ngành, corr 0,8 = 1 cược khổng lồ | P2 | CRB-5 |
| 6 | Không stress test kịch bản; bet sizing không có cơ sở xác suất | Không biết danh mục sống sót thế nào trong kịch bản 2022 | P1+P4 | CRB-3, CRB-9 |

Số liệu nền (đo phiên #48–#49): 215.327 bar EOD thật · 111k HOSE / 69k HNX / 35k UPCOM · chu kỳ 23 agents ~101s ≤ ngân sách 180s (Bước 10 MEB v1.1) → quant engine phải **≤ 1,5s** để không phá ngân sách.

---

## §2. Kiến trúc đích — `src/lib/risk/` (RiskQuantEngine)

```
src/lib/risk/
  volatility.ts      CRB-1  EWMA σ + hạn mức động (RiskMetrics λ=0,94)
  tail.ts            CRB-2/3 HS-VaR/CVaR + Monte Carlo bootstrap stress test
  concentration.ts   CRB-4/5 HHI ngành & vị thế + ma trận tương quan
  forecast.ts        CRB-6/8 hồi quy logistic P(vi phạm 5 phiên) + CUSUM/EWMA chart
  sizing.ts          CRB-9 Fractional Kelly (¼-Kelly) tư vấn bet sizing
  engine.ts          CRB-0  ORCHESTRATOR — gọi tất cả, trả RiskQuantResult + persist snapshot
  (CRB-7 Bayesian limit-learning nằm trong engine.ts — cập nhật AppSetting)
```

**Vị trí trong chu kỳ 23 agents (thay đổi đợt C):**

```
ĐỢT A platform → ĐỢT B research (5 LLM)
      ↓
[CRB-0] RISKQUANT ENGINE (mới — deterministic ~1s, chạy TRƯỚC đợt C)
      ↓
ĐỢT C Ủy ban Kiểm soát: risk-manager (LLM — prompt giờ có khối QUANT) + exposure (dùng hạn mức ĐỘNG) + compliance
      ↓
ĐỢT D Bayes (+2 bằng chứng quant) → ĐỢT E Chủ tịch → phê duyệt trader
```

Lý do quant chạy **trước** đợt C: (a) risk-manager LLM cần con số định lượng trong prompt; (b) exposure A7 cần hạn mức động; (c) deterministic nên không phụ thuộc đầu ra LLM.

---

## §3. GÓI ƯU TIÊN 1 — Rủi ro đuôi & biến động (CRB-1 → CRB-3)

### CRB-1 · EWMA volatility + hạn mức động

**Công thức (RiskMetrics chuẩn):**
```
σ²ₜ = λ·σ²ₜ₋₁ + (1−λ)·r²ₜ        λ = 0,94 (chuẩn RiskMetrics daily)
σ_ann = σ_daily × √252
```
Chuỗi đầu vào: daily returns **của danh mục thật** (tổng hợp Position × Bar hiện hữu theo thời gian giữ — F-102); danh mục rỗng/<60 phiên → rổ top-10 thanh khoản (proxy mode, §0.4).

**Hạn mức động (hai chiều có trần — §0.3, chốt user #50 Q2):**
```
volRef   = median(σ_ewma 250 phiên gần nhất của chuỗi)     — mốc "bình thường"
mult     = clamp(volRef / σ_ewma,20 hiện tại, 0,6, 1,15)    — SIẾT khi vol cao hơn mốc,
                                                             NỚI tối đa +15% khi YÊN BÌNH hơn mốc
dynMaxPositionPct = maxPositionPct × mult                  (25% → [15% · 28,75%])
dynMaxSectorPct    = maxSectorWeightPct × mult             (40% → [24% · 46%])
mult > 1 → RiskAlert INFO "nới hạn mức theo biến động thấp hơn mốc" (kiểm toán được)
```
Kèm **vol ratio** hiển thị: `σ_now/σ_ref` (1,0 = bình thường; 1,5 = biến động cao 50%).

**Điểm nối:**
- `runExposure` (A7): đọc `dynMaxSectorPct/dynMaxPositionPct` từ RiskQuantResult thay số tĩnh — **điều kiện VETO giữ nguyên ngữ nghĩa, chỉ ngưỡng thay đổi** (ngưỡng động ∈ [0,6 · 1,15]× tĩnh — nới chỉ khi thị trường yên bình hơn mốc và luôn phát INFO alert).
- Prompt risk-manager (A6): thêm dòng `- Biến động EWMA20 năm hoá: x,x% (×1,4 mốc bình thường) → hạn mức vị thế động y,y% NAV`.
- RiskAlert WARN khi `mult ≤ 0,75` (biến động gấp ~1,33 lần bình thường).

**Nghiệm thu:** (1) λ=0,94 tái lập trên chuỗi giả 250 điểm — so sánh với công thức tham chiếu viết độc lập; (2) mốc volRef dùng median (không mean — chống nhiễu đỉnh spike); (3) mult ∈ [0,6 · 1,15] mọi đầu vào (property test 10.000 lần quét ngẫu nhiên); (3b) mult > 1 chỉ xảy ra khi σ_now < σ_ref (yên bình hơn mốc) và luôn kèm INFO alert; (4) danh mục rỗng → proxyMode=true hiện rõ trong output.

### CRB-2 · Historical Simulation VaR/CVaR

**Công thức:**
```
r_p,t = Σᵢ wᵢ·rᵢ,t   (wᵢ = MVᵢ/NAV theo Position hiện tại, cửa sổ 250 phiên,
                      mã thiếu lịch sử → thay return rổ cùng ngành, ghi proxy)
VaR95(1 phiên)  = −percentile(r_p, 5%) × NAV          (VND và % NAV)
CVaR95(1 phiên) = −mean(r_p : r_p ≤ percentile5) × NAV
VaR95(5 phiên)  = VaR95(1) × √5                       (quy tắc căn bậc hai thời
                                                      gian — CLT, xem §8)
```
Percentile bằng sort `Float64Array` (không nội suy — lấy order statistic gốc, deterministic).

**Điểm nối:**
- Prompt risk-manager (A6): `- VaR95 5 phiên: a,a% NAV (≈ b ₫) · CVaR95: c,c% NAV` — LLM đối chiếu với lỗ ngày tối đa 50tr ₫ và DD 15%.
- RiskAlert CRITICAL khi CVaR95(5 phiên) > 5% NAV; WARN khi > 3%.
- Bayes evidence `quant-tail:hs-cvar` (§5).

**Nghiệm thu:** (1) tính tay trên 10-return ví dụ chuẩn (VaR = |min của 5% tệ|); (2) mã có < 60 phiên lịch sử không tham gia trực tiếp (proxy ngành, đếm số mã proxy trong output); (3) VaR ≤ CVaR mọi trường hợp (bất đẳng thức bắt buộc); (4) NAV = 0 → skip + proxyMode.

### CRB-3 · Monte Carlo bootstrap stress test

**Thuật toán:**
```
N_PATHS = 5.000 · HORIZON = 5 bước · RNG mulberry32(seed 777) — deterministic
mỗi path: 5 lần rút CÓ HOÀN TRẢ từ phân phối kinh nghiệm r_p (250 phiên, CRB-2)
P&L_path = Π(1+r̃ⱼ) − 1
Báo cáo: P(lỗ > 2% NAV) · P(lỗ > 5% NAV) · lỗ percentile 5% (MC-VaR khớp chéo
HS-VaR CRB-2 — sai lệch > 20% phải log) · worst-path observed ·
P(chạm DD 15%) = |{path : DD_hiện_tại + lỗ_path > 15%}| / N_PATHS
```

**Điểm nối:** prompt risk-manager + khối QUANT trong Tổng hợp (UI thuộc G1, §10); RiskAlert CRITICAL khi `P(chạm DD 15%) ≥ 0,10`.

**Nghiệm thu:** (1) cùng seed → kết quả byte-identical giữa 2 lần chạy; (2) MC-VaR5% lệch HS-VaR95 ≤ 20% trên dữ liệu thật (khớp chéo 2 phương pháp — nếu lệch lớn hơn là dấu hiệu phân phối đuôi nặng, log để review chứ không chắn); (3) runtime ≤ 300ms (5.000×5 phép nhân trên Float64Array).

---

## §4. GÓI ƯU TIÊN 2 — Đo tập trung đúng nghĩa (CRB-4 → CRB-5)

### CRB-4 · HHI — chỉ số tập trung Herfindahl-Hirschman

**Công thức:**
```
HHI_sector   = Σⱼ sⱼ²        (sⱼ = tỷ trọng ngành / NAV)
HHI_position = Σᵢ wᵢ²        (wᵢ = tỷ trọng vị thế / NAV)
Ngành hiệu quả  N_eff_sector  = 1 / HHI_sector     (≈ số ngành "độc lập" đẳng trọng)
Vị thế hiệu quả N_eff_position = 1 / HHI_position
```
**Ngưỡng (chốt thiết kế):** `HHI_sector > 0,25` (≈ < 4 ngành hiệu quả) HOẶC `HHI_position > 0,15` (≈ < 6,7 vị thế hiệu quả, trong khi mục tiêu `targetPositions: 8`) → cảnh báo tập trung, vẫn giữ điều kiện VETO cũ của A7 (ngành lớn nhất > hạn mức) — **HHI là tín hiệu SIÊT SỚM, VETO giữ nguyên ranh giới**. Hồi đúng gap §1.2: 3 ngành × 39% → HHI = 0,4563 > 0,25 → cảnh báo bật dù A7 cũ báo "ĐẠT".

**Điểm nối:** `runExposure` thêm 2 dòng content + output breaches; prompt risk-manager; Bayes evidence `quant-tail:hhi` khi vượt ngưỡng (weight 0,3 — khiêm tốn).

**Nghiệm thu:** (1) test ví dụ 3 ngành 39/39/20 + 2% tiền: HHI = 0,1521+0,1521+0,04 = 0,3442 → alert đúng; (2) danh mục 8 vị thế đẳng trọng 12,5% → HHI 0,125 < 0,15 → im lặng đúng; (3) HHI ∈ (0, 1] mọi đầu vào hợp lệ.

### CRB-5 · Ma trận tương quan + "số cược hiệu quả"

**Công thức:**
```
Cửa sổ 60 phiên daily returns, chỉ top-15 vị thế theo MV (cap ma trận 15×15)
corr(i,j) = Pearson(rᵢ, rⱼ) — cặp nào < 40 phiên chung → bỏ, đếm pairsProxy
avgCorr  = trung bình corr các cặp i<j
N_eff_bets = N / (1 + (N−1)·avgCorr)     — "số cược độc lập" của danh mục
```
**Ngưỡng:** `avgCorr > 0,7` hoặc `N_eff_bets < N/2` → RiskAlert WARN "danh mục N vị thế thực chất là ~N_eff cược".

**Điểm nối:** prompt risk-manager (dòng `- Tương quan TB vị thế: 0,xx → ~N_eff cược độc lập`); UI Tổng hợp.

**Nghiệm thu:** (1) 2 chuỗi hoàn toàn đồng biến → corr ≈ 1, N_eff ≈ 1; (2) 2 chuỗi ngẫu nhiên seed khác → corr ≈ 0, N_eff ≈ N; (3) ma trận đối xứng, đường chéo không tính vào avgCorr; (4) < 2 vị thế → skip (không chia 0).

---

## §5. GÓI ƯU TIÊN 3 — Dự báo xác suất vi phạm (CRB-6 → CRB-8)

### CRB-6 · Hồi quy logistic P(vi phạm giới hạn trong 5 phiên)

**Mô hình viết tay (phong cách `ml/nn.ts` — đặt tại `src/lib/risk/forecast.ts` theo §2):**
```
8 đặc trưng (TẤT CẢ có sẵn, không lookahead):
  x1 volZ     = (σ_ewma20 − volRef)/volRef          (CRB-1)
  x2 rsiBucket rổ (0..3 chuẩn hoá)                   (đã có trong rl.ts state)
  x3 mom5     rổ (chuẩn hoá tanh)
  x4 exposure = invested fraction NAV
  x5 ddNow    = drawdown hiện tại / 0,15
  x6 hhiSector (CRB-4)
  x7 avgCorr  (CRB-5, thiếu → 0)
  x8 volRatio20/60 (chuẩn hoá)
Nhãn y: rổ top-10 có |ret 5 phiên| ≤ −2% (đuôi xấu) → 1, ngược lại 0
  — PHA 1 train trên proxy rổ (đúng kiểu ml-forecast/features.ts);
    PHA 2 (khi RiskQuantSnapshot ≥ 250 chu kỳ): retrain nhãn = vi phạm hạn
    mức THẬT của danh mục (navSeries). Ghi rõ modelVersion "phase1-basket"/"phase2-nav".
Huấn luyện: full-batch gradient descent + ridge λ=0,01 · lr=0,1 · ≤500 epoch
  · seed 2026 · chuẩn hoá z-score như MLP · AUC tính trên split thời gian 80/20.
Serving: p_breach = σ(βᵀx) → LR = clamp( (p/(1−p)) / (p₀/(1−p₀)), 0,5, 3,0 )
  (p₀ = base-rate tập train — so odds với nền, KHÔNG dùng odds thô)
```

**Điểm nối:** Bayes evidence `quant-drift:breach-prob` — direction DOWN khi p > 0,35, weight = clamp(p×1,5, 0,3, 0,8); prompt risk-manager; UI.

**Nghiệm thu:** (1) AUC val ≥ 0,55 mới được serving (dưới ngưỡng → chỉ log, không vào Bayes — trung thực); (2) deterministic cùng seed; (3) LR luôn trong [0,5 · 3,0] (ràng buộc synthesis); (4) không dùng bất kỳ đặc trưng nào cần dữ liệu tương lai.

### CRB-7 · Bayesian limit-learning — hạn mức tự học từ lịch sử vi phạm

**Công thức (Beta-Bernoulli conjugate — tái dùng pattern `bandit.ts`):**
```
Mỗi loại giới hạn ℓ ∈ {sector, position, dd, dailyLoss}:
  prior Beta(α₀=1, β₀=99)  — prior khiêm tốn, base 1%
  mỗi chu kỳ: vi phạm (snapshot vượt hạn động) → α += 1, không → β += 1
  posteriorMean = (α+1)/(α+β+2)
  tightening mult_ℓ = 1 − 0,5 × max(0, posteriorMean − 0,05)   (floor 0,75)
  → dynLimit_ℓ = static_ℓ × mult_ℓ — hợp nhất với CRB-1 bằng
    min(volMult, mult_ℓ): mult_ℓ ≤ 1 MỘT CHIỀU (chỉ siết), NỚI chỉ đến từ volMult
```
Lưu `AppSetting` key `risk-quant-limits` (JSON {alpha, beta per limit}) — cache in-process 60s như `consensus.ts`. Giới hạn chỉ SIẾT dần theo dữ liệu thật, floor 0,75× tĩnh, và **reset nút bấm thủ công** (AppSetting ghi đè) — mọi thay đổi ghi AuditLog.

**Nghiệm thu:** (1) posterior monotonic (thêm vi phạm → mean tăng); (2) mult không bao giờ > 1; (3) khởi động mới (chưa có data) → mult = 1 (giữ tĩnh); (4) có nút reset + audit trail.

### CRB-8 · CUSUM + EWMA control chart — phát hiện trôi dạt sớm

**Công thức (CUSUM một phía — downside):**
```
Chuỗi: daily NAV (PHA 1: từ RiskQuantSnapshot mỗi chu kỳ tích luỹ; < 60 điểm →
  basket proxy). σ = stdev returns 60 phiên, k = 0,5σ, h = 4σ (ARL ≈ chuẩn 5%)
Sₜ = max(0, Sₜ₋₁ + (−rₜ − k))        — hạ vệ downside
Sₜ⁺ = max(0, Sₜ₋₁⁺ + (rₜ − k))        — upside (thông tin chế độ, không báo động)
BÁO ĐỘNG khi Sₜ > h → RiskAlert WARN "trôi dạt xuống phát hiện sớm, cách DD
ngưỡng còn z phiên theo trend hiện tại" (ngoại suy tuyến tính — chỉ mô tả, không dự báo)
EWMA chart biến động: zₜ = μ·rₜ + (1−μ)·zₜ₋₁ với μ = 0,1 (hệ số làm mượt chart —
  tách ký hiệu khỏi λ RiskMetrics CRB-1); vượt ±L·σ·√(μ/(2−μ)), L = 2,7 → WARN vol-shift
```

**Điểm nối:** RiskAlert (đây là kênh CHÍNH của CRB-8 — cảnh báo sớm trước khi DD chạm 15%, vá gap §1.4); Bayes evidence `quant-drift:cusum` khi báo động (weight 0,3).

**Nghiệm thu:** (1) chuỗi sinh drift −0,5σ/phiên 20 phiên → báo động ≤ phiên 10; (2) chuỗi iid → không báo động trong 500 phiên (đo ARL thực); (3) reset S sau báo động (tránh alert chồng mỗi phiên — kèm cooldown 1 ngày).

---

## §6. GÓI ƯU TIÊN 4 — Định kích thước vị thế có cơ sở (CRB-9)

### CRB-9 · Fractional Kelly (¼-Kelly) — tư vấn bet sizing

**Công thức:**
```
p = Σᵢ (wᵢ · posteriorMeanᵢ)   — wᵢ = trọng số consensus của các cử tri
                                  ĐỒNG HƯỚNG tín hiệu (bandit alpha/beta — có sẵn)
    ; không cử tri nào đồng hướng → p = 0,5 (không biết — trung tính)
b = (targetPrice − entry)/(entry − stopLoss)     (BUY; SELL đảo dấu — b ≤ 0 → skip)
f* = (b·p − (1−p))/b                              (Kelly đầy đủ)
f  = clamp(f*/4, 0, dynMaxPositionPct/100)        (¼-Kelly + chặn hạn mức động)
```
**TUYỆT ĐỐI tham mưu**: f chỉ xuất hiện trong `signal.rationale` của Chủ tịch (prompt thêm dòng gợi ý: "Kelly ¼ gợi ý tỷ trọng tối đa x,x% NAV cho tín hiệu này — căn cứ bandit posterior của các cử tri đồng hướng") và UI — KHÔNG tự động đặt khối lượng lệnh. Khối lượng lệnh vẫn do trader phê duyệt (requireApproval A8).

**Nghiệm thu:** (1) p=0,5, b=2 → f* = 0 → f = 0 (đúng: không edge thì không đặt); (2) p=0,7, b=1 → f* = 0,4 → f = 0,1 = 10% NAV ≤ 15% floor động; (3) f không bao giờ vượt dynMax; (4) b ≤ 0 (target ≤ entry) → skip + log.

---

## §7. Thay đổi schema (additive — 1 model + 1 enum-free)

| Đối tượng | Thay đổi | Lý do |
|---|---|---|
| **model `RiskQuantSnapshot`** (mới) | `id · createdAt · nav BigInt · proxyMode Boolean · volEwmaAnnPct Float · volRatio Float · dynMaxPositionPct Float · dynMaxSectorPct Float · var95Pct Float · cvar95Pct Float · var95Vnd BigInt · mcLoss5Pct Float · mcPDd Float · hhiSector Float · hhiPosition Float · effSectors Float · effBets Float · avgCorr Float · cusumS Float · pBreach5d Float? · kellyHint Float? · detail Json` |Snapshot 1 dòng/chu kỳ — nguồn chuỗi NAV cho CRB-6/8 PHA 2 + truy hồi lịch sử |
| `RiskAlert` (hiện có) | **KHÔNG đổi** — thêm loại message quy ước `[quant-…]` | tái dùng hạ tầng cảnh báo + acknowledge |
| `AppSetting` (hiện có) | key mới `risk-quant-limits` (CRB-7) | Beta per-limit + nút reset |
| `MarketAssessment.detail` (JSON) | + `riskQuant {…}` (không migration) | truy hồi UI + narrative |

Không đổi enum, không đổi cột cũ, không đụng bảng 23 agent / bandit / consensus.

---

## §8. Quan hệ với Central Limit Theorem (ghi minh bạch — không phải "tính năng")

CLT **không phải module cài thêm** — nó đã là nền của 3 chỗ trong hệ thống và sẽ là nền của 2 chỗ mới: (1) CI80 Holt `±1,2816σ√h` đang chạy; (2) quy tắc `×√5` mở rộng VaR 1→5 phiên (CRB-2); (3) bootstrap Monte Carlo (CRB-3) — lý luận tập kinh nghiệm hội tụ về chuẩn; (4) posterior Beta → xấp xỉ chuẩn khi pulls lớn (bandit weight trong consensus — đã ngầm); (5) sai số chuẩn base-rate 250 phiên (Bayes bậc 0). Blueprint chỉ **ghi rõ giới hạn áp dụng**: return tài chính đuôi FAT, tương quan, non-stationary → CLT dùng như approximation có kiểm soát (cắt percentile empirical thay giả định chuẩn khi có ≥ 250 điểm), đó là lý do CRB-2 chọn Historical Simulation thay VaR analytic (variance-covariance).

---

## §9. Quyết định đã chốt từ câu trả lời của user (phiên #50)

| # | Câu hỏi | Câu trả lời của user | Khoản triển khai trong blueprint này |
|---|---|---|---|
| 1 | CRB-2 dùng HS-VaR (empirical) hay VaR analytic (giả định chuẩn)? | **HS-VaR** | §3 CRB-2 giữ nguyên — percentile empirical, không giả định chuẩn (đuôi FAT VN) |
| 2 | Hạn mức động có được phép NỚI khi thị trường YÊN BÌNH? | **Được phép** | §0.3 + CRB-1 sửa v1.1: mult ∈ [0,6 · **1,15**], trần +15% cứng, INFO alert mỗi lần nới, nghiệm thu thêm 3b |
| 3 | CRB-6 PHA 1 train nhãn trên proxy rổ top-10 — chấp nhận? | **Theo đề xuất** | §5 CRB-6: PHA 1 nhãn proxy rổ → PHA 2 retrain nhãn vi phạm thật khi đủ 250 snapshot NAV |
| 4 | ¼-Kelly xuất hiện ở đâu? | **Theo đề xuất** | §6 CRB-9: chỉ trong rationale tín hiệu + UI — tuyệt đối tham mưu, không tự đặt khối lượng |
| 5 | Triển khai 2 đợt hay một lần cả 4 gói? | **2 đợt** | §10: G1 (CRB-1→5) trước → G2 (CRB-6→9) sau; user #50 chỉ thị "chưa triển khai vội" — chờ lệnh khởi động G1 |

## §10. Ngân sách hiệu năng & lộ trình

| Giai đoạn | Nội dung | Thêm vào chu kỳ | Giá ước tính |
|---|---|---|---|
| G1 (chốt #50 Q5) | CRB-1→5 (EWMA · VaR/CVaR · MC · HHI · corr) + schema + UI tổng hợp | ≤ 1,0s deterministic | ~400 dòng TS thuần |
| G2 (sau G1 nghiệm thu) | CRB-6→9 (logistic · Beta-learning · CUSUM · Kelly) + Bayes evidence | +0,3s (1 forward logistic) | ~350 dòng |
| Tổng | 9 bước · 6 file mới `src/lib/risk/` · 1 model mới · 0 dependency · 0 route mới | **≤ 1,5s** | ≤ 800 dòng |

Ràng buộc cứng: chu kỳ tổng sau khi gộp ≤ 185s (ngân sách MEB 180s + 5s dự phòng) — nếu vượt, MC cắt N_PATHS 5.000 → 2.000 (ước lượng ảnh hưởng ±0,3% percentile, đo lại khi cắt).
