# TECHNICAL BLUEPRINT — MỞ RỘNG ĐỘ PHỦ THỊ TRƯỜNG 15/15 + QUỐC TẾ + DỮ LIỆU CƠ BẢN

> **Project:** The Trader — Hệ thống giao dịch đa agent (VNDIRECT)
> **Document:** `docs/MARKET_EXPANSION_BLUEPRINT.md` · **Version:** 1.1 (đã vá sau review 37-REVIEW: 3 lỗi P0 + 6 P1) · **Updated:** 2026-10-07
> **Status:** **ĐÃ CHỐT TRIỂN KHAI** — dựa trên 5 câu trả lời của user (phiên #37, xem §0)
> **Cross-refs:** [RESEARCH_COUNCIL_PLAN.md](./RESEARCH_COUNCIL_PLAN.md) (§9 — 5 câu hỏi mở, **đã chốt**) · [DATA_SOURCES.md](./DATA_SOURCES.md) · [TECHNICAL_BLUEPRINT.md](./TECHNICAL_BLUEPRINT.md) · [DB_SCHEMA.md](./DB_SCHEMA.md)
> **Changelog v1.1 (phiên #37 — review 37-REVIEW):** B7 — **REPLACE** bằng chứng quant `mlp-forecast` cũ bằng phiếu cử tri (chống đếm kép, test T7.5) · ensemble có deadband FLAT 0,05 + định nghĩa chuẩn hoá linreg · cổng đồng thuận dùng khoảng đóng + epsilon + **shadow-mode 10 chu kỳ** trước enforcement + gate bind theo assessment sinh ra tín hiệu · B12 — Yahoo null/splits/adjclose · B14 — watcher re-probe tuần (hoá lời hứa T1) · §3.4 — trọng số composite segment INDEX + tái chuẩn hoá · vá số học B4 + backup DB B1 + xoá phương án `unitScale` + typos encoding.

---

## §0. Quyết định đã chốt từ câu trả lời của user (phiên #37)

| # | Câu hỏi mở (RESEARCH_COUNCIL_PLAN §9) | Câu trả lời của user | Khoản triển khai trong blueprint này |
|---|---|---|---|
| 0 | *(Yêu cầu chủ)* 15 tổ hợp chỉ vận hành 1/15 — thiếu sót lớn | **Muốn đầy đủ 15/15**, bao hàm HNX · ETF · dữ liệu tài chính cơ bản · sàn quốc tế | Toàn bộ §1–§4: 15 bước / 7 giai đoạn |
| 1 | Phạm vi đợt 1: chốt cả 3 nâng cấp P0 hay từng phần? | **Chốt cả 3** | Bước 6 (bảng chỉ báo mở rộng) + Bước 7 (MLP ensemble) + Bước 8 (Scorecard) |
| 2 | MLP có nên thành phiếu bầu độc lập? | **Phiếu bầu theo số đông — đồng thuận 80% trở lên** | Bước 7 (MLP thành cử tri thứ 6) + **Bước 9 — Cổng đồng thuận 80%** |
| 3 | Scorecard trưng diện ở đâu? | **Tab Đội Agent** | Bước 8 (bảng điểm) + Bước 14 (ma trận độ phủ) — cả hai nhúng trong workspace Đội Agent |
| 4 | Giữ ràng buộc chu kỳ ≤ 90s hay nới? | **Nới** | Bước 10 — ngân sách mới ≤ 180s (cảnh báo > 300s) + nới quota sync + nới rổ |
| 5 | Nạp thử HNX đợt này hay để P2? | **Nạp luôn** | Bước 3–4 — nạp HNX + UPCOM + ETF + INDEX ngay trong giai đoạn 1 |

> **Nguyên tắc xuyên suốt (văn hoá hệ thống):** không bịa dữ liệu. Ô thị trường nào không có sản phẩm niêm yết hoặc chưa có nguồn dữ liệu xác minh được sẽ hiển thị **trung thực** trạng thái của nó (§1.2) — "15/15 vận hành" nghĩa là **15/15 ô được hạ tầng vận hành đầy đủ và tự sáng khi dữ liệu xuất hiện**, không phải tô xanh mọi ô bằng dữ liệu giả.

---

## §1. Mục tiêu & định nghĩa "vận hành 15/15"

### 1.1. Ba tiêu chí để một tổ hợp được coi là "VẬN HÀNH"

Một ô (sàn × loại tài sản) đạt trạng thái vận hành khi và chỉ khi đủ cả 3:

1. **T1 — Dữ liệu thật tự động:** Instrument của ô được sync bar EOD + quote tự động theo lịch (dchart cho VN, Yahoo cho quốc tế); không có sản phẩm → ô ghi "0 sản phẩm niêm yết" và **watcher re-probe tuần** (job market-engine, Bước 14 — Chủ nhật 04:00 ICT re-probe danh sách ứng viên các ô ⚪/🟡, probe-trước-khi-tạo như B3) tự nạp khi mã đầu tiên xuất hiện dữ liệu.
2. **T2 — Tham gia chu kỳ 23 agents:** mã trong ô vào rổ/bằng chứng của Bộ tổng hợp Bayes (theo phân đoạn §3.4) và hiển thị trong context prompt của các agent nghiên cứu.
3. **T3 — Hiển thị & đo lường:** ô hiện trong **Ma trận độ phủ** (tab Đội Agent) kèm số instrument · số bar · phiên cuối · chế độ nguồn (real / 0-sản phẩm / chờ-nguồn).

### 1.2. Bảng 15 tổ hợp — hiện trạng → đích (kèm bằng chứng probe 2026-10-07)

| # | Sàn × Loại | Hiện tại | Sản phẩm thật? | Nguồn đã xác minh | Trạng thái đích |
|---|---|---|---|---|---|
| 1 | HOSE × STOCK | ✅ **ĐANG CHẠY** — 30 mã VN30 mở rộng, 90.785 bar EOD thật | Có | dchart (đang chạy) | 🟢 Vận hành thật |
| 2 | HOSE × ETF | ❌ Chưa nạp | Có — 5 ETF đang niêm yết | dchart — probe 5/5 mã OK (E1VFVN30, FUEVFVND, FUESSVFL, FUEVN100, FUEIP100) | 🟢 Vận hành thật (Bước 3–4) |
| 3 | HOSE × FUND | ❌ | **Không** — HOSE không có quỹ đóng niêm yết | probe VF1/VFMVF1/VFF/PRBF/BF1 = rỗng | ⚪ Hạ tầng sẵn, 0 sản phẩm |
| 4 | HOSE × INDEX | ❌ Chưa nạp | Có — VNINDEX, VN30, VNMID, VNSML, VNALL | dchart — probe OK (VNINDEX 1.753,39 điểm 07-10) | 🟢 Vận hành thật (Bước 3–4) |
| 5 | HNX × STOCK | ❌ Chưa nạp | Có | dchart — probe **21/23 mã OK** (PVS, SHB, PVI, IDI, MCH…) | 🟢 Vận hành thật — **nạp luôn** (user §0.5) |
| 6 | HNX × ETF | ❌ | **Không** — HNX chưa có ETF niêm yết | — | ⚪ Hạ tầng sẵn, 0 sản phẩm |
| 7 | HNX × FUND | ❌ | **Không còn** — quỹ đóng đã tất toán/chuyển đổi | probe VF1/VFMVF1/VFF/PRBF/BF1 = rỗng | ⚪ Hạ tầng sẵn, 0 sản phẩm |
| 8 | HNX × INDEX | ❌ Chưa nạp | Có — HNX-Index, HNX30 | dchart — probe OK (symbol `HNX`, `HNX30`) | 🟢 Vận hành thật (Bước 3–4) |
| 9 | UPCOM × STOCK | ❌ Chưa nạp | Có | dchart — probe QNP/CLL/BVB OK (+ nạp thêm ở Bước 3) | 🟢 Vận hành thật (Bước 3–4) |
| 10 | UPCOM × ETF | ❌ | **Không** | — | ⚪ Hạ tầng sẵn, 0 sản phẩm |
| 11 | UPCOM × FUND | ❌ | **Không** | — | ⚪ Hạ tầng sẵn, 0 sản phẩm |
| 12 | UPCOM × INDEX | ❌ Chưa nạp | Có — UPCOM-Index | dchart — probe OK (symbol `UPCOM`) | 🟢 Vận hành thật (Bước 3–4) |
| 13 | HOSE × BOND | ❌ | **Không** — trái phiếu không giao dịch tại HOSE | — | ⚪ Hạ tầng sẵn, 0 sản phẩm |
| 14 | HNX × BOND | ❌ | **Có** (trái phiếu chính phủ giao dịch HNX) nhưng **không có nguồn công khai miễn phí đã xác minh từ sandbox** | finfo blocked (§2) | 🟡 Chờ nguồn — hạ tầng + ingest pipeline sẵn |
| 15 | UPCOM × BOND | ❌ | **Có** (trái phiếu doanh nghiệp) — cùng vấn đề nguồn | finfo blocked (§2) | 🟡 Chờ nguồn — hạ tầng + ingest pipeline sẵn |

**Tổng kết độ phủ đích:**
- 🟢 **7/15 ô vận hành thật ngay** (1 đang chạy + 6 nạp mới bằng dchart đã xác minh hôm nay);
- ⚪ **6/15 ô "0 sản phẩm niêm yết"** — thị trường không có sản phẩm (không phải hệ thống thiếu); pipeline tự sáng khi sản phẩm xuất hiện;
- 🟡 **2/15 ô bond "chờ nguồn"** — sản phẩm có thật, cần egress finfo hoặc nguồn trả phí khi deploy ngoài sandbox.

**Cộng thêm 2 chiều mở rộng ngoài lưới 15** (theo yêu cầu user): 🌐 **Sàn quốc tế** (US/HK — Yahoo đã xác minh hoạt động từ sandbox, §2) và 📊 **Dữ liệu tài chính cơ bản** (finfo — pipeline hoàn chỉnh, chế độ `pending-egress` trong sandbox, tự sáng khi deploy ngoài).

### 1.3. Câu trả lời câu hỏi "bao nhiêu loại thị trường" (cập nhật sau triển khai)

Sau khi blueprint hoàn tất, hệ thống bao hàm: **3 sàn VN niêm yết (HOSE/HNX/UPCOM) × 5 loại tài sản + 2 sàn quốc tế (US/HK) + trái phiếu (chờ nguồn) + dữ liệu cơ bản** — mở từ "chuyên gia 1 tổ hợp" (phiên #36) lên **7 tổ hợp nội địa vận hành thật (§1.2: 1 đang chạy + 6 nạp mới) + quốc tế + cơ bản**, với 15/15 ô hạ tầng đầy đủ.

---

## §2. Bằng chứng nguồn dữ liệu — probe thực đo sandbox 2026-10-07 06:37 UTC

| Nguồn | Endpoint | Kết quả probe | Kết luận |
|---|---|---|---|
| **dchart VNDIRECT** (công khai) | `GET /dchart/history?symbol=…&resolution=D` | HNX (PVS, SHB, PVI, IDI, MCH, VCS, NTP, TV2, CEO, PGC, KLB, PET, SAM, APC, DMC, NDN, PIT, SBS, CSM, BSH, BVS) ✓ · UPCOM (QNP, CLL, BVB) ✓ · ETF 5 mã ✓ · INDEX (VNINDEX 1753.39 điểm, VN30, HNX, HNX30, UPCOM, VNMID, VNSML, VNALL) ✓ · FUND (VF1, VFMVF1, VFF, PRBF, BF1) ✗ trống · AAPL ✗ trống | **Nguồn chính cho 7 ô nội địa** — đã chạy ổn định 1 năm dữ liệu thật từ phiên #33 |
| **Yahoo Finance chart v8** | `GET query1/v8/finance/chart/AAPL?range=5d&interval=1d` + header User-Agent | **HTTP 200, dữ liệu AAPL thật** (NasdaqGS); KHÔNG có User-Agent → HTTP 429 | **Nguồn sàn quốc tế** — bắt buộc UA header + throttle + retry (§3.1) |
| **finfo VNDIRECT** (công khai) | `/v4/lastprice` | HTTP 000 (timeout 8s) — DNS → 10.210.100.8 (RFC1918 private) | **Chặn egress sandbox** — pipeline viết theo spec, mode `pending-egress`, tự hoạt động khi deploy máy chủ egress thật (cùng pattern `vndirect.ts` #34) |
| **Stooq** | `q/d/l/?s=aapl.us` | HTTP 000 (0 byte) | ❌ Bỏ — không egress từ sandbox |
| **CafeF / Vietstock / DNSE** | trang chủ | HTTP 200 / 200 / 200 | Fallback P2 cho dữ liệu cơ bản (scrape — mỏng, chỉ dùng khi user yêu cầu số trong sandbox) |

### 2.1. ⚠ Phát hiện quan trọng về ĐƠN VỊ (phải sửa trước khi nạp)

Đo thực tế cùng ngày: dchart trả **cổ phiếu theo nghìn VND** (PVS close 33.8 = 33.800₫) nhưng trả **index theo điểm thô** (VNINDEX 1753.39). Hàm `toRealBars()` hiện tại (`eod-sync.ts`) **nhân ×1000 vô điều kiện** — nếu nạp index ngay bây giờ, VNINDEX sẽ bị lưu thành 1.753.400 "VND" (sai 1.000 lần) và vượt logic neo quote ±7%. → **Bước 2 (chuẩn hoá đơn vị) là điều kiện tiên quyết của mọi nạp dữ liệu mới.**

---

## §3. Kiến trúc đích

### 3.1. Tầng nguồn — adapter registry

Mỗi nguồn khai báo tĩnh: thị trường phục vụ · loại tài sản · quy tắc đơn vị · giới hạn tốc độ:

| Adapter | Sàn | Loại | Đơn vị nguồn → DB | Rate limit | Trạng thái |
|---|---|---|---|---|---|
| `dchart-vn` (`eod-sync.ts`, mở rộng) | HOSE · HNX · UPCOM | STOCK · ETF · (FUND/BOND watcher) | nghìn VND → ×1000 VND round100 · **INDEX: điểm → ×100 (Int)** | 300ms/request (giữ) | đang chạy |
| `yahoo-intl` (`intl-eod.ts`, **mới**) | US · HK | STOCK · ETF · INDEX | USD/HKD thô → **×100 cents (Int)** · index ×100 điểm | 1.200ms/request + retry 429 ×3 backoff 5s/15s/45s + UA header bắt buộc | Bước 12 |
| `finfo-fundamentals` (`fundamentals.ts`, **mới**) | VN | cơ bản mỗi mã | tỷ lệ thô (P/E…) | 500ms/request | mode `pending-egress` trong sandbox |
| `rss-news` (hiện tại) | VN | tin tức | — | — | đang chạy |

### 3.2. Ma trận chuẩn hoá đơn vị (single source of truth — `UnitSpec`)

| Loại instrument | Nguồn trả | Biến đổi khi ingest | Giá trị lưu DB (Int) | Ví dụ |
|---|---|---|---|---|
| STOCK VN | nghìn VND | ×1000 → round100 | VND | PVS 33.8 → 33.800 |
| ETF VN | nghìn VND | ×1000 → round100 | VND | E1VFVN30 23.35 → 23.350 |
| **INDEX VN** | **điểm thô** | **×100, KHÔNG round100, KHÔNG ×1000** | điểm×100 | VNINDEX 1753.39 → 175.339 |
| STOCK/ETF QT | USD/HKD thô | ×100 → nguyên | cents USD/HKD | AAPL 231.4 → 23.140 |
| INDEX QT | điểm thô | ×100 | điểm×100 | ^GSPC 5700 → 570.000 |
| BOND (khi có nguồn) | % mệnh giá | ×100 | %×100 | 98.5 → 9.850 |

Kèm theo: **cận giá hợp lệ theo loại** (INDEX: 100..10.000.000 điểm×100; STOCK VN: 500..5.000.000 VND như hiện tại; cents: 100..5.000.000) và **neo Quote theo loại** — INDEX/quốc tế **không có trần/sàn ±7%** (đặt `ceilingPrice/floorPrice = null`), spread tính theo tick của loại (0,1 điểm index = 10 đơn vị DB).

### 3.3. Thay đổi schema (tất cả additive — không destructive)

| Đối tượng | Thay đổi | Lý do |
|---|---|---|
| `enum Market` | **+ `US`, `HK`** | sàn quốc tế (Postgres enum thêm giá trị = an toàn) |
| `Instrument` | **+ `currency String? @default("VND")`** | USD/HKD cho quốc tế; display format theo này |
| `Instrument` | **KHÔNG thêm cột đơn vị** — đã chốt bảng tra §3.2 (`UnitSpec` theo (market,type)) là single source of truth | tránh 2 nguồn sự thật lệch nhau khi thêm loại/sàn mới |
| **model `FinancialFundamental`** (mới) | `instrumentId · period (Q1–Q4/FY) · year · revenue BigInt? (VND nguyên) · netProfit BigInt? (VND nguyên) · eps Float? (VND) · bvps Float? (VND) · roe Float? · roa Float? · pe Float? · pb Float? · source · mode (real/pending) · @@unique([instrumentId, period, year])` — bỏ cột `quarter?` dư thừa (kỳ đã nằm trong `period`) | dữ liệu cơ bản — Bước 11 |
| `BanditEvent` | **+ `confidence Float?`** | lưu độ tự tin phiếu khi cast để tính Brier (Bước 8) |
| `MarketAssessment.detail` (JSON, không migration) | + `segments[]` · + `consensus {ratio, gate, tally[]}` | phân đoạn thị trường (Bước 5) + cổng đồng thuận (Bước 9) |

### 3.4. Rổ & bằng chứng PHÂN ĐOẠN (multi-segment)

Hiện tại: một rổ duy nhất top-10 thanh khoản HOSE → một posterior thị trường. Đích:

| Segment | Rổ | Bằng chứng riêng | Posterior |
|---|---|---|---|
| `VN-HOSE-STOCK` | top-10 ADTV (như hiện tại) | breadth · lexicon tin · flows · Holt · RSI/z · phiếu LLM | pUp/pDown riêng |
| `VN-HNX-STOCK` | top-5 ADTV HNX | breadth segment · Holt · RSI | riêng |
| `VN-UPCOM-STOCK` | top-3 ADTV UPCOM | Holt · RSI | riêng |
| `VN-ETF` | toàn bộ ETF active (≤10) | breadth ETF · Holt | riêng |
| `VN-INDEX` | VNINDEX + VN30 (+ HNX, UPCOM) | động lượng index · RSI index | riêng |
| `VN-COMPOSITE` | — (hợp các segment trên) | — | **posterior tổng = trung bình trọng số**: segment có ADTV VND đo được (HOSE/HNX/UPCOM-STOCK · ETF) theo ADTV thật; segment INDEX **không có ADTV VND** → trọng số cố định **0,05/index** (không đo được thì cố định khiêm tốn, không bịa); sau khi lấy trung bình **tái chuẩn hoá pUp+pDown+pFlat = 1** (dùng cho bandit settle + narrative — giữ tương thích chuỗi lịch sử) |
| `INTERNATIONAL` | ^GSPC · ^IXIC · ^HSI + 8 mã US + 3 mã HK | động lượng index quốc tế (Bước 13) | riêng (tham khảo, không vào composite VN) |

- Engine `synthesizeMarketAssessment()` **chạy lại theo từng segment** (input = bằng chứng segment đó) → `detail.segments[]`; chairman prompt (Đợt E) nhận khối "ĐA THỊ TRƯỜNG" gọn (1 dòng/segment).
- MLP/Q-learning tiếp tục train trên rổ `VN-HOSE-STOCK` (chuỗi lịch sử sâu nhất) — mở rộng per-segment là P2, khai báo rõ trong ml-panel.

### 3.5. Cổng đồng thuận 80% (câu trả lời §0.2)

- **Pool cử tri = 6:** market-analyst · fair-value · news-sentiment · liquidity · risk-manager · **ml-forecast (ensemble MLP+linreg — mới, Bước 7)**. Chủ tịch KHÔNG bầu (vai tổng hợp).
- **Công thức:** mỗi phiếu có trọng số `wᵢ = clamp(healthScore/100 × posteriorMean bandit, 0.3 · 1)` (trùng công thức weight bằng chứng hiện tại — tái dùng). Với mỗi hướng d ∈ {UP, DOWN, FLAT}: `S(d) = Σ wᵢ·[voteᵢ = d]`; `consensusRatio = max_d S(d) / Σ wᵢ`.
- **3 mức cổng:**

| consensusRatio | Cổng | Hệ quả thực thi |
|---|---|---|
| **[0,80 · 1,00]** | **ĐỒNG THUẬN** | Tín hiệu được EXECUTE nếu posterior đạt stance (margin ≥ 0,12 như hiện tại) |
| **[0,50 · 0,80)** | **ĐA SỐ YẾU** | Tín hiệu **ép HOLD** + narrative giải thích "số đông X% nhưng dưới ngưỡng đồng thuận 80%" |
| **[0,00 · 0,50)** | **KHÔNG ĐỒNG THUẬN** | HOLD |

So ngưỡng dùng epsilon số thực: `ratio ≥ 0,80 − 1e⁻⁹` → ĐỒNG THUẬN (tránh dải chết 0,7999… không rơi vào dải nào).

- **VETO Ủy ban Kiểm soát vẫn TUYỆT ĐỐI** — cổng đồng thuận không vượt veto (an toàn trước hết).
- Pool < 4 cử tri có mặt (agent lỗi/thiếu) → coi như KHÔNG ĐỒNG THUẬN (fail-safe).
- Áp dụng tại: Đợt D (tính + lưu `detail.consensus`) → Đợt E (chairman prompt nêu cổng, bắt buộc tôn trọng) → Đợt F (`signal-execution.ts` chặn convert khi gate ≠ ĐỒNG THUẬN).
- **Gate bind theo assessment SINH RA tín hiệu:** snapshot gate lưu vào Signal ngay lúc Chủ tịch tạo tín hiệu (chu kỳ N) — việc convert ở chu kỳ N+k không bị đánh giá lại bằng consensus mới hơn (ổn định + kiểm chứng được theo tín hiệu, không theo thời điểm bấm nút).
- **Shadow-mode trước enforcement (Bước 9 pha a):** ≥ 10 chu kỳ đầu cổng chỉ tính + lưu `detail.consensus` + log "shadow: đã-sẽ-chặn" (KHÔNG chặn tín hiệu thật); sau đó review tỉ lệ tín hiệu bị chặn (worklog) → user duyệt → bật enforcement qua AppSetting key `consensus.enforce` (bảng key-value có sẵn, mặc định `false`).
- Lưu ý rời rạc: 6 cử tri đồng trọng số chỉ đạt {100% · 83,3% · 66,7% · 50%…} → cổng thực chất = **≥ 5/6 đồng ý**; trọng số khác nhau cho ratio liên tục (ví dụ 3 trong Appendix B). Diễn giải dải 50–79,9% = HOLD cứng là cách đọc nghiêm ngặt của "đồng thuận 80% trở lên" — cần user tái xác nhận khi bật `consensus.enforce` (xem Bước 9).
- Ví dụ: 6 phiếu đồng trọng số 1 — 5 UP + 1 DOWN → 83,3% ≥ 80% → ĐỒNG THUẬN; 4 UP + 2 DOWN → 66,7% → ĐA SỐ YẾU → HOLD (xem Appendix B).

### 3.6. Scorecard Hội đồng Nghiên cứu (câu trả lời §0.1+§0.3)

Per agent: **hit-rate 5 phiên** (từ `BanditEvent` đã settle) · **Brier score** `mean((confidence − outcome)²)` (cần cột `confidence` mới) · **đóng góp posterior** trung bình |Δlog-odds| của driver `llm-vote:<code>` trong 30 assessment gần · **streak** · posteriorMean bandit · healthScore. Endpoint `GET /api/research/scorecard`; UI **tab Đội Agent** (dưới section nhóm Nghiên cứu), sort hit-rate giảm dần, trạng thái "chưa đủ dữ liệu" trung thực khi pulls < 5.

### 3.7. Ma trận độ phủ UI (tab Đội Agent)

`GET /api/coverage` → lưới **5 cột (loại) × 3 hàng (sàn)** = 15 ô + hàng quốc tế + hàng cơ bản. Mỗi ô: số instrument active · tổng bar · phiên cuối · tuổi quote · mode. Màu: 🟢 real · ⚪ 0-sản phẩm · 🟡 chờ-nguồn. Click ô → chi tiết. Nguồn dữ liệu thuần query DB + `DataSourceStatus` — không bảng mới.

### 3.8. Nới ngân sách (câu trả lời §0.4)

| Thông số | Hiện tại | Đích | Ghi chú |
|---|---|---|---|
| Ngân sách chu kỳ (tiêu chí nghiệm thu) | ≤ 90s | **≤ 180s mục tiêu, cảnh báo > 300s** | tính thêm 4 chỉ báo + 7 segment + scorecard |
| `MAX_SYMBOLS_PER_SYNC` (eod-sync.ts) | 40 | **150** | 30 HOSE + 21 HNX + ~10 UPCOM + 5 ETF + 8 index + dự phòng |
| `REQUEST_INTERVAL_MS` dchart | 300ms | **giữ 300ms** | tôn trọng nguồn công cộng — 150 mã ≈ 45s/lượt sync |
| Rổ context market block | top-10 | top-10 HOSE **+ khối segment gọn** | prompt không phình quá +40% |
| Bandit settle / ML cooldown | 5 phiên / 10s | giữ | không đổi |

---

## §4. KẾ HOẠCH TRIỂN KHAI — **7 GIAI ĐOẠN · 15 BƯỚC**

> Mỗi bước: mục tiêu · việc code (file thật) · DB/API/UI · test (mã T) · nghiệm thu. Thứ tự có phụ thuộc: B2 trước B4; B1 trước B11; B7 trước B9 (MLP phải là cử tri trước khi có cổng). Task ID subagent đánh theo phiên triển khai (38-a, 38-b…).

### GIAI ĐOẠN 0 — Nền tảng (chuẩn bị không phá vỡ gì đang chạy)

**Bước 1 — Mở rộng schema đa thị trường**
- Việc code: `prisma/schema.prisma` — enum `Market` +`US` +`HK`; `Instrument.currency`; model `FinancialFundamental` (bỏ cột `quarter?` dư thừa — kỳ đã nằm trong `period`; ghi rõ đơn vị: revenue/netProfit **VND nguyên**, eps/bvps VND, roe/roa/pe/pb tỉ lệ thô); `BanditEvent.confidence Float?`. **Backup DB (pg_dump / snapshot Supabase) TRƯỚC khi chạy `bun run db:push`** — chi phí ~0, phòng edge case `ALTER TYPE` chọn path tạo lại type. Sau đó chạy `bun run db:push`. Đồng bộ `docs/DB_SCHEMA.md`.
- Nghiệm thu: push OK không mất dữ liệu (24 → 25 model); các route hiện tại chạy như cũ.
- Test: **T1.1** GET /api/agents · /api/assessment vẫn 200 sau push.

**Bước 2 — Chuẩn hoá đơn vị theo loại tài sản (UnitSpec)**
- Việc code: `src/lib/eod-sync.ts` — `toRealBars(symbol, history, unit: UnitSpec)` với bảng tra §3.2; cận giá theo loại; `anchorQuoteToRealEod` nhận loại → INDEX/QT bỏ trần sàn (null), spread theo tick. `src/lib/format.ts` — helper hiển thị theo (market, type, currency). `src/lib/types.ts` — type `UnitSpec`.
- Nghiệm thu: nạp lại 30 mã HOSE hiện tại → **byte-identical** với DB hôm nay (regression 0);
- Test: **T2.1** VNINDEX 1753.39 → 175.339 (điểm×100); **T2.2** PVS 33.8 → 33.400 VND (không đổi hành vi cũ); **T2.3** quote index không có trần/sàn; **T2.4** giá ngoài cận theo loại bị skip + đếm skipped minh bạch.

### GIAI ĐOẠN 1 — Nạp 7 ô nội địa thật (bao gồm "nạp luôn" HNX — §0.5)

**Bước 3 — Universe seed đa sàn (script probe-verify từng mã)**
- Việc code: `prisma/expand-universe.ts` (mới, idempotent upsert) — danh sách ứng viên Appendix A: 21 HNX + ~10 UPCOM (probe thêm) + 5 ETF + 8 index; **mỗi mã probe dchart trước khi tạo** (mã trống → bỏ + log, không tạo instrument chết); gán `market/type/sector/currency` đúng bảng §1.2.
- DB: +~44 Instrument mới (đều `isActive=true`).
- Test: **T3.1** đếm instrument theo (market×type) khớp bảng seed; **T3.2** chạy lại script = idempotent (không đuplicate); **T3.3** 0 instrument nào không có bar sau Bước 4.

**Bước 4 — Deep backfill đa sàn + nới quota**
- Việc code: `src/lib/eod-sync.ts` — `MAX_SYMBOLS_PER_SYNC` 40→150; `deepBackfillEod` chạy theo unit từng instrument (Bước 2); API `POST /api/market/eod-sync` nhận `force=deep` (giữ nguyên hành vi mặc định 10-day). EOD sync hằng ngày 15:45 ICT (market-engine) tự phủ toàn bộ instrument mới. **Index & instrument quốc tế KHÔNG vào tick-engine sinh quote mô phỏng** — quote neo EOD thật (`anchorQuoteToRealEod`), tôn trọng nguyên tắc không-bịa-dữ liệu.
- Nghiệm thu: **+~100.000–121.000 bar thật** (21 HNX × ~3.000 ≈ 63k · UPCOM 3–10 mã × ~2.500 ≈ 7,5–25k · 5 ETF × ~1.800 ≈ 9k · 8 index × ~3.000 ≈ 24k) → DB tổng ~190–210k bar (hiện 90.785); thời gian backfill ≤ 5 phút. **Ràng buộc thứ tự: deep backfill phải HOÀN TẤT trước chu kỳ agent kế tiếp** (chu kỳ bốc giữa chừng sẽ thấy dữ liệu nửa vời).
- Test: **T4.1** spot-check VNINDEX phiên 07-10 = 175.339 ± 1; **T4.2** PVS khớp giá HNX công bố ± 1 tick; **T4.3** 0 bar tương lai/T7-CN; **T4.4** tổng bar tăng đúng kỳ vọng (log script).

**Bước 5 — Rổ & bằng chứng phân đoạn (multi-segment Bayes)**
- Việc code: `src/lib/ml/features.ts` — `loadTopSeries` mở rộng thành `loadSegmentBaskets()` (§3.4); `src/lib/bayes/evidence.ts` — bằng chứng gắn segment (breadth/RSI/Holt per segment; lexicon tin & flows giữ market-wide VN); `src/lib/bayes/synthesis.ts` — chạy engine per segment + composite trọng số (§3.4 quy tắc INDEX 0,05/index + tái chuẩn hoá) → `detail.segments[]`; `src/lib/agent-context.ts` — chairman prompt thêm khối "ĐA THỊ TRƯỜNG" (1 dòng/segment); `src/components/dashboard/synthesis-workspace.tsx` + `assessment-brief.tsx` — hiển thị khối segment. **Pattern query: load toàn bộ series MỘT LẦN rồi phân đoạn in-memory — không chạy 7 vòng query full bar-history** (áp lực DB + ngân sách 180s).
- Test: **T5.1** chu kỳ full 23 agents 0 lỗi, `detail.segments` đủ 7 segment; **T5.2** deterministic: chạy synthesis 2 LẦN trên cùng snapshot dữ liệu → composite pUp/pDown giống hệt (so sánh trực tiếp — không phụ thuộc "chu kỳ trước", vì thị trường thật có thể đảo chuyển mạnh giữa 2 chu kỳ gây fail oan); **T5.3** bandit settle vẫn dùng composite VN (tương thích chuỗi cũ).

### GIAI ĐOẠN 2 — Ba nâng cấp P0 Hội đồng Nghiên cứu ("chốt cả 3" — §0.1)

**Bước 6 — Bảng chỉ báo mở rộng cho Market Analyst** *(RESEARCH_COUNCIL_PLAN §7.1)*
- Việc code: `src/lib/agent-context.ts` `buildMarketBlock()` — thêm 4 cột đã có code trong `indicators.ts`: `MACD hist` (×1000) · `%B Bollinger` · `ATR14%` · `Stoch %K` — kèm đơn vị từng cột. KHÔNG đụng prompt (đã nhắc tên MACD/BOLL từ #34).
- Test: **T6.1** đối chiếu 2–3 giá trị với TradingView lệch < 5%; **T6.2** mã < 26 phiên hiển thị "—"; **T6.3** Bayes Bậc 3 quy tắc MACD (LR 1,25 có sẵn) có input đồng bộ.

**Bước 7 — ML Forecast ensemble MLP + linreg → CỬ TRI độc lập** *(§7.2 + §0.2)*
- Việc code: `src/lib/agent-service-runs.ts` `runMlForecast()` — load `MlModel` serving (dl-mlp) → `predictProba` qua `latestFeatures()` **top-10 — GIỮ NGUYÊN rổ bằng chứng quant #35** (không đổi 10→5, tránh phân phối phiếu nhảy khi REPLACE); ensemble hướng = `score = 0,7×(pUp−pDown) + 0,3×tanh(z)`, `z` = z-score của đại lượng linreg `proj₅ = slope×5/last×100` trên cửa sổ 60 phiên (cùng công thức `runMlForecast` hiện tại — định nghĩa "chuẩn hoá" tường minh), **deadband `|score| < 0,05 → FLAT`** (thống nhất ngưỡng với code #35 — hàm sign() thuần gần như không bao giờ FLAT, thiên lệch tally về 2 cực); output thêm `modelVersion` + fallback linreg khi chưa có model. `src/lib/bayes/evidence.ts` — phiếu ml-forecast vào `agentVotes` (cử tri thứ 6) với LR `1 + 0,8×|pUp−pDown|` cap 2,0; **REPLACE (chống đếm kép): XOÁ block bằng chứng quant `mlp-forecast (MLP 10→16→8→3)` mục 6g-a (evidence.ts ≈L474–506) — giữ nguyên `rl-policy` 6g-b; nếu không xoá, cùng tín hiệu MLP vào Bayes 2 LẦN (quant + vote) và nặng tally lần thứ 3**; `BanditEvent.confidence` của phiếu MLP = `max(pUp, pDown, pFlat)` (đầu vào Brier — Bước 8). `src/lib/ml/bandit.ts` — **arm thứ 6** `ml-forecast` (BanditArm seed Beta(1,1) → weight khiêm tốn ~0,5 khi chưa có track record).
- Test: **T7.1** Σ xác suất MLP = 1,000 ± 0,001 từng mã; **T7.2** xoá MlModel → fallback linreg, chu kỳ vẫn 23 agents; **T7.3** agentVotes có 6 phiếu; **T7.4** ml/status hiện arm mới; **T7.5 (chống đếm kép)** trong `marketEvidence` KHÔNG đồng thời tồn tại nguồn `mlp-forecast (MLP…)` và phiếu `llm-vote:ml-forecast` — tín hiệu MLP vào Bayes đúng 1 lần; **T7.6** khi |pUp−pDown| nhỏ, phiếu ensemble nhận FLAT (deadband hoạt động).

**Bước 8 — Research Council Scorecard** *(§7.6 + §0.3)*
- Việc code: `src/lib/research/scorecard.ts` (mới) — tổng hợp hit-rate/Brier/posterior-contribution/streak từ `BanditEvent` (settled) + `MarketAssessment.detail.drivers`; `src/app/api/research/scorecard/route.ts` (mới); `src/components/dashboard/agents-workspace.tsx` — khối "Bảng điểm Hội đồng Nghiên cứu" ngay dưới section nhóm research (**tab Đội Agent** — user chốt §0.3).
- Test: **T8.1** endpoint trả 6 agent (5 LLM + ml-forecast); **T8.2** pulls < 5 → hiển thị "chưa đủ dữ liệu" trung thực; **T8.3** sort hit-rate giảm dần; **T8.4** UI không tràn mobile 390.

### GIAI ĐOẠN 3 — Đồng thuận 80% + nới (§0.2 + §0.4)

**Bước 9 — Cổng đồng thuận 80% end-to-end**
- Việc code: `src/lib/bayes/synthesis.ts` — tính tally + `consensusRatio` + gate (§3.5 — khoảng đóng + epsilon 1e⁻⁹) trên `agentVotes` 6 cử tri; `src/lib/bayes/types.ts` + `persist.ts` — lưu `detail.consensus`; **gate snapshot lưu vào Signal ngay lúc Chủ tịch tạo tín hiệu** (convert ở chu kỳ sau KHÔNG bị đánh giá lại bằng consensus mới); `src/lib/signal-execution.ts` — chặn convert khi gate ≠ ĐỒNG THUẬN (kèm lý do) **chỉ khi AppSetting `consensus.enforce = true`**; `agent-context.ts` — chairman prompt nêu cổng bắt buộc tôn trọng; UI `synthesis-workspace.tsx` + `agents-workspace.tsx` + `assessment-brief.tsx` hiển thị cổng (thanh tally 6 phiếu + ngưỡng 80%).
- **Hai pha bắt buộc:** (a) **shadow-mode ≥ 10 chu kỳ** — cổng tính + lưu + log "shadow: đã-sẽ-chặn" nhưng KHÔNG chặn tín hiệu thật; (b) review tỉ lệ tín hiệu bị chặn (worklog) → user duyệt (tái xác nhận cách đọc dải 50–79,9% = HOLD cứng) → bật `consensus.enforce = true`.
- Test: **T9.1** mô phỏng 5/6 UP → gate ĐỒNG THUẬN, tín hiệu đi qua (cả 2 pha); **T9.2** 4/6 UP → ĐA SỐ YẾU: pha shadow tín hiệu đi qua + log "đã-sẽ-chặn", pha enforce bị HOLD + rejectNote ghi rõ; **T9.3** VETO + đồng thuận 100% → vẫn bị chặn (veto tối thượng); **T9.4** pool 3 cử tri → KHÔNG ĐỒNG THUẬN (fail-safe); **T9.5** narrative có câu giải thích cổng; **T9.6** đổi consensus ở chu kỳ N+1 KHÔNG đổi số phận tín hiệu đã sinh ở chu kỳ N (gate bind theo snapshot); **T9.7** ratio = 0,7999… rơi đúng dải ĐA SỐ YẾU, không rơi ngoài dải nào (epsilon).

**Bước 10 — Nới ngân sách & quota (tiêu chí nghiệm thu mới)**
- Việc code: cập nhật hằng số `eod-sync.ts` (đã ở B4); cập nhật tiêu chí test trong `docs/TECHNICAL_BLUEPRINT.md` + `RESEARCH_COUNCIL_PLAN.md` §8 (≤90s → ≤180s); `agent-context.ts` rổ top-10 HOSE giữ + segment gọn; đo và ghi durationMs chu kỳ vào worklog mỗi phiên.
- Test: **T10.1** chu kỳ đầy đủ sau toàn bộ giai đoạn 0–3: ≤ 180s, 0 lỗi; **T10.2** sync daily 150 mã ≤ 60s.

### GIAI ĐOẠN 4 — Dữ liệu tài chính cơ bản (§0 mục tiêu)

**Bước 11 — FinancialFundamental pipeline (finfo, pending-egress)**
- Việc code: `src/lib/fundamentals.ts` (mới) — client finfo theo VNDIRECT Open API spec (financial statements theo mã/kỳ); ingest tuần trong `runDataCollector` (`agent-service-runs.ts`) — try/catch toàn bộ, lỗi mạng → `DataSourceStatus key "fundamentals"` mode `pending-egress`; `src/lib/agent-context.ts` `buildValuationBlock()` — **chỉ** thêm cột P/E·EPS·BVPS·ROE khi mode=real có dữ liệu (prompt fair-value khai báo giới hạn như hiện tại khi chưa có); UI coverage matrix + settings hiển thị mode trung thực.
- Ngoài sandbox (máy chủ egress thật): finfo sáng → dữ liệu thật chảy vào, không sửa thêm dòng nào.
- Test: **T11.1** sandbox: chu kỳ vẫn chạy đủ 23 agents khi finfo timeout (try/catch); **T11.2** DataSourceStatus mode=pending-egress hiển thị đúng; **T11.3** (khi có egress) P/E VCB khớp công bố ± 5%.

### GIAI ĐOẠN 5 — Sàn quốc tế (Yahoo — đã xác minh HTTP 200)

**Bước 12 — Adapter quốc tế + universe US/HK**
- Việc code: `src/lib/intl-eod.ts` (mới) — `fetchYahooChart(symbol, range, interval)`: **UA header bắt buộc** (đã đo 429 khi thiếu), throttle 1.200ms, retry 429/5xx ×3 backoff 5/15/45s; request kèm `&events=div,split`; parse `timestamp[]` + **`indicators.adjclose[0].adjclose[]` (fallback `indicators.quote[].close[]`)** — adjclose đã điều chỉnh split/cổ tức nên chuỗi đặc trưng không bị gãy khi tách cổ phiếu (bar cuối adjclose = close → spot-check T12.1 vẫn khớp giá thật); **index có giá trị `null` bị skip + đếm skipped minh bạch** (Yahoo trả null cho phiên thiếu dữ liệu — parse thẳng sẽ sinh bar giá 0/NaN) → `RealBarInput` cents ×100 (index ×100 điểm); universe mặc định Appendix A (8 US + ^GSPC ^IXIC + 3 HK + ^HSI = 14); **quy ước symbol cross-market: giữ nguyên ký hiệu Yahoo (`AAPL` · `0700.HK` · `^GSPC`) — `Instrument.symbol` unique TOÀN CỤC, không thêm suffix**; `prisma/expand-universe.ts` mở rộng tạo Instrument `market=US/HK`, `currency=USD/HKD`; scheduler market-engine thêm job **06:15 ICT** (sau đóng cửa Mỹ); API `POST /api/market/intl-sync` (manual). EOD 1 lần/ngày là đủ (range=1y backfill lần đầu).
- Test: **T12.1** AAPL phiên cuối khớp giá thật ± 0,5%; **T12.2** 429 → retry đúng backoff (log); **T12.3** ^HSI điểm nguyên không ×1000; **T12.4** sync 14 mã ≤ 30s (đã throttle); **T12.5** response chứa close null → bar bị skip + đếm skipped, KHÔNG sinh bar giá 0/NaN; **T12.6** mã có split trong 1 năm qua → chuỗi adjclose không có bước nhảy gãy (so sánh return quanh ngày split).

**Bước 13 — Bằng chứng quốc tế vào tổng hợp (segment INTERNATIONAL)**
- Việc code: `src/lib/bayes/evidence.ts` — segment `INTERNATIONAL`: động lượng ^GSPC/^HSI 5 phiên (LR 1,15 khi |mom| > 1%) + RSI14 (LR 1,2 khi < 30 / > 70) — weight 0,4 (tham khảo, không vào composite VN); chairman prompt thêm 1 dòng "Quốc tế: S&P +x% · HSI −y% · ảnh hưởng tâm lý VN"; UI `synthesis-workspace.tsx` + `quotes-table.tsx` (group theo sàn).
- Test: **T13.1** detail.segments có INTERNATIONAL; **T13.2** narrative/chairman nhắc quốc tế khi |mom| ≥ 1%; **T13.3** composite VN KHÔNG đổi do bằng chứng quốc tế (thiết kế tách bạch).

### GIAI ĐOẠN 6 — Đóng gói & nghiệm thu tổng

**Bước 14 — Ma trận độ phủ API + UI (tab Đội Agent)**
- Việc code: `src/app/api/coverage/route.ts` (mới) — query DB group theo (market×type) + DataSourceStatus + tuổi quote → 15 ô + quốc tế + cơ bản (§3.7); `src/components/dashboard/coverage-matrix.tsx` (mới) — lưới 5×3 + legend + tooltip; nhúng `agents-workspace.tsx` (**tab Đội Agent** — đồng nhất với scorecard theo §0.3); **watcher re-probe tuần trong market-engine (Chủ nhật 04:00 ICT): re-probe danh sách ứng viên các ô ⚪/🟡** (FUND VF1/VFMVF1/VFF/PRBF/BF1 · ETF HNX · UPCOM ứng viên chưa nạp · BOND ứng viên khi có nguồn) — mã đầu tiên CÓ dữ liệu → tự tạo Instrument + backfill → ô tự sáng (hoá tiêu chí T1 "watcher tự nạp"; probe-trước-khi-tạo như B3, không tạo instrument chết).
- Test: **T14.1** 15 ô luôn render (kể cả ô 0 sản phẩm — trung thực); **T14.2** ô 🟢 có instrument/bar/lastBarDate đúng DB; **T14.3** mobile 390 không tràn lưới; **T14.4** click ô → tooltip chi tiết; **T14.5** watcher: ứng viên probe trống → ô vẫn ⚪; ứng viên probe có dữ liệu (mock) → Instrument + bar được tạo, ô chuyển 🟢.

**Bước 15 — E2E tổng + go/no-go**
- Việc code: không code mới — chạy kịch bản nghiệm thu toàn chương trình, fix lỗi phát hiện, cập nhật README/USER_PROMPTS/worklog, commit+push.
- Test tổng (checklist đóng dấu): **T15.1** chu kỳ 23 agents 0 lỗi ≤ 180s với universe ~90 mã · **T15.2** 50+ bằng chứng, ≥ 7 segments, 6 cử tri, cổng đồng thuận hoạt động · **T15.3** ma trận 15 ô + quốc tế + cơ bản đúng trạng thái · **T15.4** scorecard render (hoặc "chưa đủ dữ liệu") · **T15.5** browser desktop 1280 + mobile 390: 7 workspace 0 console error · **T15.6** nút Huấn luyện E2E ML vẫn deterministic · **T15.7** rollback an toàn: mọi migration additive, tắt segment quốc tế = không ảnh hưởng chuỗi VN.

---

## §5. Rủi ro & giảm thiểu

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Nhầm đơn vị index/quốc tế (sai 100–1000 lần) | 🔴 cao | Bước 2 là tiên quyết + test T2.x spot-check giá đã biết công khai + regression 30 mã hiện tại byte-identical |
| Yahoo 429/đổi hợp đồng API | 🟡 vừa | UA + throttle 1.2s + retry backoff ×3 + chỉ sync 1 lần/ngày (EOD) + DataSourceStatus fallback stale |
| dchart rate-limit khi 150 mã | 🟡 vừa | giữ 300ms/request (tổng ~45s) + retry 5xx có sẵn (2 lần backoff) + sync theo nhóm sàn |
| Chu kỳ vượt ngân sách mới | 🟡 vừa | segment prompt gọn (1 dòng/segment) + đo durationMs mỗi phiên + cảnh báo 300s |
| Prompt phình → chi phí/tokens tăng | 🟡 vừa | chỉ market block mở top-10 + 4 cột; phần segment là dòng tổng hợp; 17 agent dịch vụ vẫn 0 token |
| "15/15" bị hiểu sai là 15 ô dữ liệu thật | 🟢 thấp | ma trận độ phủ hiển thị 3 màu + chú thích "0 sản phẩm niêm yết" / "chờ nguồn" — không tô xanh giả |
| Đếm kép tín hiệu MLP khi nâng lên cử tri | 🔴 cao | B7 chỉ định REPLACE (xoá block quant 6g-a) + test T7.5 chặn hồi quy |
| Cổng 80% chặn tín hiệu quá mức (6 cử tri đồng trọng số ≈ cần ≥5/6) | 🟡 vừa | shadow-mode 10 chu kỳ đo tỉ lệ chặn trước khi bật `consensus.enforce`; veto vẫn tối thượng |
| Postgres enum thêm giá trị | 🟢 thấp | additive — không destructive; backup pg_dump/snapshot trước db:push (B1) |
| Chuỗi bandit/assessment lịch sử đứt gãy khi đổi pool 6 cử tri | 🟡 vừa | composite VN giữ nguyên công thức; đồng thuận là trường mới (detail.consensus) không đè số cũ; pulls/arm cũ bảo toàn |

---

## §6. Lộ trình phiên làm việc (mapping Task ID subagent)

| Phiên | Giai đoạn | Bước | Task ID gợi ý | Kết quả user thấy |
|---|---|---|---|---|
| #38 | 0 + 1 | B1–B5 | 38-a (schema+unit), 38-b (seed+backfill), 38-c (segments) | +~100–121k bar thật; HNX/UPCOM/ETF/index sống trong UI; assessment đa thị trường |
| #39 | 2 + 3 | B6–B10 | 39-a (P0 ba nâng cấp), 39-b (cổng 80% shadow→enforce + nới) | Bảng chỉ báo mới; MLP cử tri (đã REPLACE chống đếm kép); scorecard tab Đội Agent; cổng đồng thuận 80% — shadow-mode 10 chu kỳ trước khi bật enforce |
| #40 | 4 + 5 | B11–B13 | 40-a (fundamentals), 40-b (intl Yahoo) | Sàn US/HK sống; segment quốc tế; pipeline cơ bản pending-egress |
| #41 | 6 | B14–B15 | 41-a (coverage matrix), 41-b (E2E go/no-go) | Ma trận 15/15 trên tab Đội Agent + báo cáo nghiệm thu tổng |

Mỗi phiên kết thúc bằng commit + push + cập nhật worklog (quy trình chuẩn hiện tại).

---

## Appendix A — Danh sách mã đã xác minh bằng probe (2026-10-07)

**HNX (21 mã có dữ liệu dchart):** PVS · SHB · PVI · IDI · MCH · VCS · NTP · TV2 · CEO · PGC · KLB · PET · SAM · APC · DMC · NDN · PIT · SBS · CSM · BSH · BVS *(BAS, BIT probe trống — bỏ)*

**UPCOM (3 mã verified + nạp thêm khi chạy B3 bằng probe từng ứng viên):** QNP · CLL · BVB

**ETF HOSE (5/5 có dữ liệu):** E1VFVN30 · FUEVFVND · FUESSVFL · FUEVN100 · FUEIP100 *(FUEMAFVN30, FUEKIP30, FUEHAT30, FUEBBB, FUEVIF probe trống)*

**INDEX (8 mã có dữ liệu):** VNINDEX · VN30 · VNMID · VNSML · VNALL (HOSE) · HNX · HNX30 (HNX) · UPCOM (UPCOM)

**Quốc tế (đề xuất mặc định — user đổi được):** US: AAPL · MSFT · NVDA · GOOGL · AMZN · META · TSLA · JPM + ^GSPC · ^IXIC · HK: 0700.HK · 0005.HK · 3888.HK + ^HSI

> Script `expand-universe.ts` **probe từng mã trước khi tạo instrument** — danh sách này là điểm khởi đầu đã xác minh, mã trống tự động bị bỏ (không tạo instrument chết).

## Appendix B — Công thức cổng đồng thuận + ví dụ tính tay

```
wᵢ   = clamp(healthScoreᵢ/100 × posteriorMeanᵢ(bandit), 0.3, 1)     // 6 cử tri
S(d) = Σ wᵢ · [voteᵢ = d]          cho d ∈ {UP, DOWN, FLAT}
consensusRatio = max_d S(d) / Σ wᵢ
gate: ratio ∈ [0.80, 1] → ĐỒNG THUẬN · ratio ∈ [0.50, 0.80) → ĐA SỐ YẾU (HOLD) · ratio ∈ [0, 0.50) → KHÔNG ĐỒNG THUẬN (HOLD)
      (so ngưỡng 0.80 với epsilon 1e⁻⁹; 2 pha: shadow ≥ 10 chu kỳ → user duyệt → mới bật AppSetting consensus.enforce)
ràng buộc: pool < 4 cử tri → KHÔNG ĐỒNG THUẬN · VETO Ủy ban → chặn tuyệt đối mọi cấp · gate bind theo assessment SINH RA tín hiệu
```

Ví dụ 1 — 6 phiếu đồng trọng số: 5 UP + 1 DOWN → ratio 5/6 = **83,3% ≥ 80%** → ĐỒNG THUẬN → tín hiệu EXECUTE (nếu posterior đạt stance).
Ví dụ 2 — 4 UP + 2 DOWN → 66,7% → ĐA SỐ YẾU → HOLD, rejectNote: "số đông 66,7% dưới ngưỡng đồng thuận 80%".
Ví dụ 3 — trọng số khác nhau: 3 UP (w=1 mỗi phiếu) + 3 DOWN (w=0.3 mỗi phiếu, agent yếu lịch sử) → S(UP)=3, Σw=3.9 → ratio 76,9% → vẫn ĐA SỐ YẾU (trực giác: phiếu agent mạnh nặng hơn nhưng chưa đủ 80%).

## Appendix C — Bảng tổng file thay đổi theo bước

| Bước | File sửa/mới | Loại |
|---|---|---|
| B1 | prisma/schema.prisma · docs/DB_SCHEMA.md | sửa |
| B2 | src/lib/eod-sync.ts · src/lib/format.ts · src/lib/types.ts | sửa |
| B3 | prisma/expand-universe.ts · docs/DATA_SOURCES.md | **mới** |
| B4 | src/lib/eod-sync.ts · src/app/api/market/eod-sync/route.ts | sửa |
| B5 | src/lib/ml/features.ts · src/lib/bayes/{evidence,synthesis,types,persist}.ts · src/lib/agent-context.ts · synthesis-workspace.tsx · assessment-brief.tsx | sửa |
| B6 | src/lib/agent-context.ts | sửa |
| B7 | src/lib/agent-service-runs.ts · src/lib/bayes/evidence.ts · src/lib/ml/bandit.ts | sửa |
| B8 | src/lib/research/scorecard.ts · src/app/api/research/scorecard/route.ts · agents-workspace.tsx | **mới** + sửa |
| B9 | src/lib/bayes/{synthesis,types,persist}.ts · src/lib/signal-execution.ts · agent-context.ts · synthesis-workspace.tsx · agents-workspace.tsx · assessment-brief.tsx | sửa |
| B10 | docs/TECHNICAL_BLUEPRINT.md · docs/RESEARCH_COUNCIL_PLAN.md (tiêu chí) | sửa |
| B11 | src/lib/fundamentals.ts · src/lib/agent-service-runs.ts · agent-context.ts | **mới** + sửa |
| B12 | src/lib/intl-eod.ts · prisma/expand-universe.ts · mini-services/market-engine · src/app/api/market/intl-sync/route.ts | **mới** + sửa |
| B13 | src/lib/bayes/evidence.ts · agent-context.ts · quotes-table.tsx · synthesis-workspace.tsx | sửa |
| B14 | src/app/api/coverage/route.ts · src/components/dashboard/coverage-matrix.tsx · agents-workspace.tsx · src/lib/types.ts | **mới** + sửa |
| B15 | README.md · docs/USER_PROMPTS.md · worklog.md | sửa |

---

*Blueprint này trả lời trực tiếp 4 câu của user: **cần triển khai những gì** (§1–§3: 7 ô dữ liệu thật + 6 ô hạ tầng + 2 ô chờ nguồn + quốc tế + cơ bản + cổng đồng thuận + scorecard + nới) · **bao nhiêu bước** (15 bước) · **là những bước nào** (§4, 7 giai đoạn có phụ thuộc rõ) · **triển khai như thế nào** (từng bước: file thật · thuật toán · DB/API/UI · test mã T · nghiệm thu). Mọi con số nguồn đều probe thực đo 2026-10-07 · **v1.1 vá sau review 37-REVIEW (3 lỗi P0 + 6 P1) trước khi mở phiên #38**.*
