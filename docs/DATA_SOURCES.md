# The Trader — Data Sources Inventory

> **Project:** The Trader — Hệ thống giao dịch đa agent (Multi-Agent Trading System) cho VNDIRECT
> **Document:** `docs/DATA_SOURCES.md` · **Version:** 0.2.0 · **Updated:** 2026-10-06
> **Cross-refs:** [DB_SCHEMA.md](./DB_SCHEMA.md) (data dictionary) · [TECHNICAL_BLUEPRINT.md](./TECHNICAL_BLUEPRINT.md) (API surface & kiến trúc)

---

## 1. Purpose

Tài liệu này là **kho kiểm kê (inventory) mọi nguồn dữ liệu** mà The Trader tiêu thụ hiện tại hoặc dự kiến tích hợp: nguồn nội bộ (seed generator, LLM), nguồn ngoài dự kiến (API giao dịch VNDIRECT, market data, tin tức, dữ liệu thay thế). Với mỗi nguồn, tài liệu ghi rõ: endpoint/bảng dữ liệu, tần suất cập nhật, **mapping sang model Prisma** (field nào được đổ dữ liệu từ nguồn nào), và **chiến lược fallback** khi nguồn không khả dụng.

Nguyên tắc chung: **mọi dữ liệu thị trường phải qua validate §5 trước khi ghi DB**; khi nguồn ngoài chết, hệ thống **phục vụ bản cache cuối cùng và đánh dấu stale** — không bao giờ render giá "sống" từ nguồn không xác thực.

---

## 2. Inventory Summary

| # | Nguồn | Loại | Trạng thái | Hướng | Models Prisma affected |
|---|---|---|---|---|---|
| S1 | Seed generator nội bộ (`prisma/seed.ts`) | Nội bộ, deterministic | ✅ **Implemented** | → DB | Tất cả 19 models (demo) |
| S2 | LLM glm-4.6 (`z-ai-web-dev-sdk`) | AI service, backend-only | ✅ **Implemented** | → DB | `AgentMessage`, `AgentRun`, `Signal`, `Order` (paper), `AuditLog`, `Agent` (health) |
| S3 | VNDIRECT Trading API | Broker API | 🟡 **Scaffold** (flag + audit, gateway pending) | ↔ ngoài | `Order`, `Trade`, `BrokerAccount`, `Position`, `AuditLog` |
| S4 | Market data feed (VNDIRECT/VPS · HOSE/HNX) | Market data | ✅ **Implemented** (simulated + stale marking) | → DB | `Quote`, `Bar`, `Instrument`, `DataSourceStatus` |
| S5 | Tin tức tài chính (RSS VN) | News | ✅ **Implemented** (RSS live) | → DB + LLM context | `NewsItem`, `AgentMessage` (sentiment), `Signal` (gián tiếp) |
| S6 | Alternative data (dòng khối ngoại, margin) | Quant data | ✅ **Implemented** (simulated deterministic) | → LLM context | `RiskAlert`, `DataSourceStatus` + prompt context |

---

## 3. Nguồn hiện tại (Implemented)

### 3.1 S1 — Seed generator nội bộ (`prisma/seed.ts`)

**Mục đích:** sinh bộ dữ liệu demo deterministic để dashboard và 5 agent có dữ liệu hoạt động ngay mà không phụ thuộc nguồn ngoài. Chạy thủ công: `bun prisma/seed.ts` (sau `bun run db:push`). Script **xóa sạch dữ liệu cũ** trước khi ghi — chỉ dùng cho dev/demo.

**Thuật toán (đảm bảo reproducible):**

- **PRNG kiểu LCG** với seed cố định `42`: `state = (state × 1103515245 + 12345) mod 2^31` → cùng seed cho cùng dữ liệu, test ổn định. **Phạm vi deterministic (F-115, audit 2026-10-06):** giá trị bar/quote/orders/orders v.v. cố định theo **ngày chạy** — cửa sổ 90 ngày tính từ `new Date()` lúc chạy seed, nên chạy lại vào 2 ngày khác nhau cho khác mốc thời gian (cùng một ngày → dữ liệu giống hệt). Đây là chủ đích để dữ liệu demo luôn "tươi" so với hôm nay.
- **30 mã VN30** (HOSE, `STOCK`), mỗi mã có: tên công ty tiếng Việt, ngành (Ngân hàng, Bất động sản, Công nghệ, Vật liệu, Tiêu dùng, Bán lẻ, Năng lượng, Hàng không, Y tế, Chứng khoán…), **giá tham chiếu thực tế** (VCB 91,500 · FPT 138,700 · VNM 65,700…), độ biến động ngày (`vol` 1.1%–2.4%), khối lượng nền (`volBase` 0.3–9.2 triệu cp).
- **90 ngày giao dịch mỗi mã (2,700 bar):** bỏ thứ 7/CN; random-walk **có mean-reversion** về giá tham chiếu (drift 2%/ngày); `high`/`low` nở thêm ≤ 0.6 × vol; khối lượng 0.6–1.5 × `volBase`; **mọi giá làm tròn bội 100 VND** (`round100`) **và mọi OHLC nằm trong dải ±7% so close hôm trước** (Q2 — audit 2026-10-06 F-101); close phiên cuối **kéo về sát giá tham chiếu trong dải trần/sàn** để quote nhất quán.
- **Quote mới nhất mỗi mã:** `refPrice` = close hôm trước; `ceilingPrice` = round100(ref × 1.07); `floorPrice` = round100(ref × 0.93); `change`/`changePct` so close trước; bid/ask lệch ±0.1% kèm depth ngẫu nhiên (5–60 lô × 100 cp).

**Tần suất:** on-demand (re-seed khi cần). **Không phải nguồn production** — được thay bằng S4 khi tích hợp market data.

**Mapping model Prisma:**

| Model | Fields được sinh |
|---|---|
| `User` | demo `trader@thetrader.vn` (passwordHash placeholder) |
| `BrokerAccount` | VNDIRECT margin `VD0029961828`: `cashBalance` 486,500,000 · `equity` 1,284,300,000 · `marginUsed` 92,000,000 |
| `Instrument` | `symbol`, `name`, `market=HOSE`, `type=STOCK`, `sector`, `outstandingShares` |
| `Bar` | 90 × `date/open/high/low/close/volume/value` mỗi mã |
| `Quote` | toàn bộ field giá + `refPrice/ceilingPrice/floorPrice/tradedAt` |
| `Agent` × 5 | `code/name/role/description/config` (đúng config ở [TECHNICAL_BLUEPRINT.md §5](./TECHNICAL_BLUEPRINT.md)) + `healthScore` 88–100 |
| `AgentRun` | 6 run/agent: `taskStatus`, `durationMs`, `tokensIn/Out`, `costUsd`, `output`/`error` |
| `AgentTask` | 9 đầu việc tiếng Việt theo agent |
| `AgentMessage` | 5 tin broadcast có `content/reasoning/sentiment` |
| `Signal` | 8 tín hiệu BUY/SELL/HOLD với `score`, `targetPrice/stopLoss/takeProfit`, `expiresAt` +3 ngày |
| `Position` | 7 vị thế OPEN với `avgPrice`, `realizedPnl` |
| `Order` + `Trade` | 7 lệnh (FILLED/PARTIALLY_FILLED/SUBMITTED/CANCELLED) + bút toán: `fee` = 0.15% × notional, `tax` = 0.1% × notional (SELL) |
| `RiskAlert` | 3 cảnh báo (sector weight 42% > 40%, VHM loss −5.4%, rebalance deviation 6.8% > 5%) |
| `AuditLog` | 6 action chuẩn hóa |
| `Watchlist` + `WatchlistItem` | watchlist mặc định "VN30 tiêu điểm" 8 mã |

**Fallback:** không cần — nguồn nội bộ luôn khả dụng; dữ liệu demo được đánh dấu rõ trên sticky footer dashboard.

### 3.2 S2 — LLM phân tích đa agent (glm-4.6, backend-only)

**Endpoint tiêu thụ:** `POST /api/agents/run` (orchestrator — mô tả luồng đầy đủ ở [TECHNICAL_BLUEPRINT.md §5.2](./TECHNICAL_BLUEPRINT.md)).

- **SDK:** `z-ai-web-dev-sdk` v0.0.18, model **`glm-4.6`** — chỉ import trong Route Handler, không bao giờ ở client (API key không expose).
- **Input:** snapshot từ DB — quotes + 90-day bars của watchlist, positions + avgPrice, số dư tài khoản, risk alerts đang mở, **10 tin RSS mới nhất (S5) + dòng khối ngoại (S6)** — được pack vào role-prompt cho từng agent theo `Agent.config` (chi tiết phân bổ khối: [TECHNICAL_BLUEPRINT.md §5.2](./TECHNICAL_BLUEPRINT.md)).
- **Output parsed & persisted:**
  - `AgentMessage` (`content`, `reasoning`, `sentiment` bullish/bearish/neutral) — broadcast;
  - `Signal` từ bước tổng hợp của Portfolio Strategist (`direction`, `confidence`, `score`, `rationale`, `targetPrice/stopLoss/takeProfit`);
  - `Order` giấy từ Execution Manager (paper);
  - `AgentRun` audit mỗi agent: `tokensIn/tokensOut`, `costUsd`, `durationMs`, `taskStatus`, `output` JSON.
- **Tần suất:** on-demand khi trader bấm **Run agents**; đã có sẵn scheduler tự động trong mini-service market-engine (`AGENT_CYCLE_MINUTES`, **mặc định 0 = TẮT** để tiết kiệm chi phí LLM — xem [TECHNICAL_BLUEPRINT.md §6](./TECHNICAL_BLUEPRINT.md)).
- **Fallback:** nếu SDK/LLM lỗi hoặc timeout → run đánh dấu `FAILED` với `error`, agent chuyển `ERROR`, UI vẫn hiển thị `AgentMessage` cũ (last cached) kèm nhãn stale; có thể sinh `RiskAlert` (severity INFO/WARNING) "agent pipeline unavailable".

---

## 4. Nguồn ngoài (S3 scaffold · S4–S6 đã triển khai ở Giai đoạn 2)

### 4.1 S3 — VNDIRECT Trading API (đặt lệnh & số dư) — 🟡 Scaffold

| Hạng mục | Chi tiết |
|---|---|
| **Capability** | Đặt lệnh (LO/market), hủy lệnh, tra trạng thái lệnh, số dư & hạn mức (cash, margin), lịch sử khớp |
| **Auth** | OAuth2/access token cấp cho khách hàng VNDIRECT (open API); credential broker lưu env server-side, **không** lưu plaintext trong DB — tham chiếu qua `BrokerAccount.accountNumber` |
| **Rate limit** | Theo chính sách open platform VNDIRECT — client phải dùng token-bucket + exponential backoff; không spam endpoint trạng thái (poll mở lệnh 2–5s/lệnh) |
| **Tần suất** | Event-driven theo thao tác trader/agent + polling trạng thái lệnh đang mở |
| **Điều kiện bật** | Feature flag `LIVE_TRADING` (mặc định **off**) — xem [TECHNICAL_BLUEPRINT.md §9](./TECHNICAL_BLUEPRINT.md); mọi lệnh thật vẫn qua veto của Risk Manager |
| **Mapping Prisma** | `Order.status` PENDING→SUBMITTED→PARTIALLY_FILLED/FILLED/REJECTED, `filledQuantity`, `avgFillPrice`, `fee`, `submittedAt/filledAt/cancelledAt`; `Trade` mỗi lần khớp (`price`, `quantity`, `fee`, `tax`); `BrokerAccount.cashBalance/equity/marginUsed/status` sync định kỳ; `AuditLog` mỗi thao tác (`ORDER_SUBMITTED_LIVE`…) |
| **Fallback** | Gateway không phản hồi → giữ trạng thái `SUBMITTED`, đánh dấu "unconfirmed" trên UI, thử lại theo backoff; **không** tự hủy lệnh đã gửi (side-effect ngoài không được rollback mù quáng); mọi chi tiết ghi `AuditLog` |

**Đã triển khai (scaffold, `src/lib/trading-mode.ts`):** `LIVE_TRADING=false` mặc định → mọi `Order` là paper order nội bộ. Bật `LIVE_TRADING=true` mà thiếu `VNDIRECT_API_BASE`/`VNDIRECT_API_TOKEN` → route convert trả **503** + audit `LIVE_TRADING_BLOCKED`; đủ cấu hình nhưng gateway chưa có → **501** + audit `LIVE_ORDER_GATEWAY_UNAVAILABLE`; `AuditLog` ORDER_CREATED giờ kèm `mode`. Trạng thái mode hiển thị qua `GET /api/system/status` (`trading: paper | live | live-unconfigured`). **Còn pending:** gateway mini-service thật để gửi lệnh ra VNDIRECT.

### 4.2 S4 — Market data (VNDIRECT/VPS · HOSE/HNX) — ✅ Implemented (simulated + stale marking)

| Hạng mục | Chi tiết |
|---|---|
| **Capability** | Quote level-1 realtime (bid/ask/last/volume), tick intraday, OHLCV EOD, giá tham chiếu/trần/sàn hàng ngày, danh mục mã niêm yết |
| **Endpoint dạng** | REST public/authorized của VNDIRECT/VPS hoặc feed HOSE/HNX — feed thật còn pending; hiện nay tick đi qua **`POST /api/market/tick`** (S4 tick engine nội bộ) và mini-service market-engine gọi endpoint này mỗi 10s (`TICK_MS` — xem [TECHNICAL_BLUEPRINT.md §6](./TECHNICAL_BLUEPRINT.md)) |
| **Tần suất** | Tick: 10s (TICK_MS, engine gọi `POST /api/market/tick`); **EOD rollover: tick đầu tiên của ngày ICT mới** — ghi `Bar` OHLCV phiên vừa đóng (upsert `@@unique([instrumentId, date])`, chỉ ngày giao dịch — Q7), kéo `refPrice` về close phiên trước, mở dải trần/sàn mới ±7%, reset `volume` về 0 với **ngân sách khối lượng ngày** 0,3–9,2 triệu cp/mã (FNV-1a theo `(mã, ngày)` — fix F-103, không còn tích luỹ vô hạn); ref/ceiling/floor: đầu phiên 09:00 ICT |
| **Mapping Prisma** | `Quote.*` toàn bộ field (`open/high/low/last/close`, `volume`, `bid/askPrice/Volume`, `change/changePct`, `refPrice/ceilingPrice/floorPrice`, `tradedAt`) — cập nhật tại chỗ trên quote mới nhất mỗi mã; `Bar` (`open/high/low/close/volume/value` — upsert theo `@@unique([instrumentId, date])`); `Instrument` (`isActive`, `listingDate`, `outstandingShares`); `DataSourceStatus` (mode/stale — xem dưới) |
| **Fallback** | **Đã implement stale marking**: `DataSourceStatus` (key `market-quotes`) ghi mode + `lastSuccessAt` mỗi tick; `GET /api/system/status` tính `stale`/`ageMinutes`; footer dashboard hiển thị dot màu (live=green · simulated=amber · fallback=red · stale=amber) + `lastError`; nguồn stale >4 tiếng → `escalateStaleSources()` tạo `RiskAlert` WARNING `DATA_SOURCE_STALE` (dedupe 24h, §6.4). Không ghi quote rác vào DB |

**Cách triển khai thực tế (đã verify E2E):** mỗi tick thực hiện **random-walk + mean-reversion 3%** về giá tham chiếu trên quote mới nhất từng mã (drift ±0,4%/tick, clamp vào dải trần/sàn), tuân thủ toàn bộ data-quality rules §5: **Q1** giá làm tròn bội 100 VND · **Q2** luôn nằm trong dải `[floorPrice, ceilingPrice]` ±7% HOSE · **Q3** khối lượng chỉ tăng (có ngân sách ngày) · **Q5** `change = last − refPrice`, `changePct = change/refPrice × 100`. Nguồn được đánh dấu `mode="simulated"` trong `DataSourceStatus` — không giả mạo "live"; `meta.mode` của `GET /api/market/quotes` đọc trực tiếp từ `DataSourceStatus` (F-117). `MARKET_STRICT_SESSION=true` thì engine **chỉ sinh tick trong phiên** (Q7/Q8 — lịch T2–T6 + nghỉ lễ VN 2026 ước lượng trong `src/lib/market-session.ts`, biên phiên chính xác tới giây — F-111); mặc định `false` để demo chạy 24/7 (đã gắn nhãn mô phỏng). `GET /api/market/quotes` trả thêm `meta { mode, asOf }` cho stale marking phía client.

**Bộ khớp lệnh giấy (paper matching engine — fix F-206, cùng tick):** cuối mỗi tick, lệnh `PENDING`/`PARTIALLY_FILLED` giá LIMIT được khớp **toàn phần tại giá đặt** khi thị trường vượt điều kiện (BUY: `last ≤ giá đặt` · SELL: `last ≥ giá đặt`). Mỗi lệnh khớp chạy trong một Prisma transaction (claim có điều kiện chống chạy đua giữa các tick) và ghi: `Trade` (phí 0,15% notional, thuế TNCN 0,1% chỉ lệnh BÁN) + `Position` (bình quân giá vốn khi BUY / realized P&L khi SELL, tự đóng vị thế khi về 0) + `BrokerAccount.cashBalance` + `equity` (tiền mặt + GTTH vị thế mở) + `AuditLog ORDER_FILLED` (before/after — before ghi trạng thái thật của lệnh, F-302). Lệnh SELL vượt điều kiện nhưng **không đủ vị thế mở** → tự **REJECTED đúng một lần** + `AuditLog ORDER_REJECTED` kèm lý do `INSUFFICIENT_POSITION` (F-303 — không retry mỗi tick). Hủy lệnh qua **`POST /api/orders/[id]/cancel`** (chỉ PENDING/PARTIALLY_FILLED → 409 nếu đã kết thúc) ghi `AuditLog ORDER_CANCELLED`. Khi sang phiên mới (EOD rollover), `equity` của mọi tài khoản hoạt động được chốt lại = tiền mặt + GTTH (F-105); `/api/portfolio` luôn tính live.

### 4.3 S5 — Tin tức tài chính (News & Sentiment agent) — ✅ Implemented (RSS live)

**5 feed RSS đã kiểm chứng hoạt động** (crawler `src/lib/news.ts`, gọi qua `POST /api/news` hoặc scheduler market-engine mỗi 15 phút `NEWS_MS`):

| Nguồn | Feed RSS | Category | Ghi chú |
|---|---|---|---|
| **VnEconomy** (`vneconomy.vn/thi-truong.rss`) | RSS 2.0 | `market` | Tin thị trường chứng khoán |
| **CafeF** (`cafef.vn/thi-truong-chung-khoan.rss`) | RSS 2.0 | `market` | Nguồn tin VN dày nhất về chứng khoán |
| **VNExpress** (`vnexpress.net/rss/kinh-doanh.rss`) | RSS 2.0 | `macro` | Tin kinh doanh/vĩ mô |
| **Tuổi Trẻ** (`tuoitre.vn/rss/kinh-doanh.rss`) | RSS 2.0 | `macro` | Tin nhanh, đa ngành |
| **VietnamNet** (`vietnamnet.vn/rss/kinh-doanh.rss`) | RSS 2.0 | `macro` | Tin kinh doanh/vĩ mô |

> DanTri trả HTML thay vì RSS nên bị loại khỏi danh sách. Reuters (quốc tế) giữ ở roadmap nếu cần bối cảnh Fed/DXY.

- **Parser:** `fast-xml-parser` v5 (hỗ trợ RSS 2.0, RDF/RSS 1.0 và Atom — Atom dùng parser riêng giữ attribute `href`, fix F-108); strip HTML khỏi title/summary; tối đa **10 tin/feed**; timeout 8s; `User-Agent: TheTraderBot/1.0` — đã nạp thật 50 tin ở lần chạy kiểm chứng đầu tiên.
- **Rate limit:** tôn trọng nguồn — **tối thiểu 60 giây giữa 2 lần nạp** (guard in-memory; `POST /api/news` dồn lịch trả 429 kèm header `Retry-After` chuẩn — F-210); scheduler chạy cách nhau 15 phút (`NEWS_MS`).
- **Dedupe:** theo **URL** — `NewsItem.url` là unique key, crawler dùng upsert (idempotent; nạp lại chỉ update `summary` nếu đổi).
- **Tần suất tiêu thụ:** News & Sentiment agent nhận **10 tin mới nhất** (`latestNewsForContext`) mỗi run cycle; UI hiển thị 12 tin mới nhất (`GET /api/news?limit=12`).

**Mapping Prisma (CÓ model News riêng — đã thêm ở Giai đoạn 2):**

| Model | Fields được đổ từ nguồn |
|---|---|
| `NewsItem` | `title`, `summary` (đã strip HTML), `url` (dedupe), `source` (tên nguồn), `sourceUrl` (URL feed gốc), `category` (`market`/`macro`), `publishedAt` (từ `pubDate`/`published`/`updated`/`dc:date`), `fetchedAt` |
| `DataSourceStatus` | key `news`: `mode` (`live` khi nạp được / `fallback` khi mọi feed chết), `lastSuccessAt`, `lastError`, `meta.providers` |
| `AgentMessage` | **kết quả phân tích** của news-sentiment agent: `content`, `reasoning`, `sentiment` (bullish/bearish/neutral) — sentiment KHÔNG lưu ở `NewsItem` |
| `Signal` | ảnh hưởng gián tiếp qua `score`/`direction` từ bước tổng hợp của Portfolio Strategist (prompt có `newsBlock`) |
| `AuditLog` | action `NEWS_INGESTED` mỗi lần crawler chạy (kèm số liệu added/updated/mode) |

- **Fallback:** mọi feed chết → `mode=fallback` (đang phục vụ cache — news card hiển thị badge chế độ + stale), agent khai báo rõ "no new data since <timestamp>" trong message và không bịa tin; mất một nguồn chỉ giảm độ phủ, không chết luồng.

### 4.4 S6 — Alternative data (dòng khối ngoại, margin) — ✅ Implemented (simulated deterministic)

| Nguồn | Dữ liệu | Mapping |
|---|---|---|
| Khối ngoại (foreign flows) | Mua/bán ròng theo mã & theo sàn (EOD, từ HOSE/HNX hoặc tổng hợp CafeF) | Prompt context (`flowsBlock`) cho Market Analyst/Strategist/Risk Manager; `RiskAlert` khi dòng ròng đảo chiều mạnh (`metricKey: "market.foreign_flow.net"`) |
| Margin data | Dư nợ margin theo mã/định mức các broker (EOD) | Prompt context cho Risk Manager; `RiskAlert.metricKey: "portfolio.margin_concentration"` (roadmap) |

**Đã triển khai — flows simulator deterministic** (`src/lib/flows.ts`, endpoint `GET /api/market/flows`):

- Nguồn EOD chuyên dụng (HOSE/HNX, tổng hợp CafeF) chưa mở trong môi trường này → dùng **mô phỏng deterministic**: FNV-1a hash theo `(symbol, ngày)` cho hệ số ngẫu nhiên ổn định, **scale theo thanh khoản thật** từ DB (≈ 0.5–6% giá trị giao dịch phiên, giới hạn **2–80 tỷ VND/mã**) — cùng ngày cho cùng kết quả, không "nhảy" theo request.
- `mode="simulated"` ghi rõ vào `DataSourceStatus` (key `foreign-flows`) và vào payload (`note` khai báo "Mô phỏng deterministic theo thanh khoản thật") — tuân thủ nguyên tắc **no fabrication**: agent được báo rõ đây là dữ liệu mô phỏng.
- **Mapping rủi ro:** tổng bán ròng toàn thị trường < **−300 tỷ VND** → `RiskAlert` WARNING `FOREIGN_FLOW_OUTFLOW` (`metricKey: "market.foreign_flow.net"`, `metricValue` theo tỷ VND, `threshold: -300`) — **dedupe 24h** (tối đa 1 alert/ngày).
- `flowsPromptBlock()` đóng gói tổng mua/bán ròng + top 5 mua ròng/bán ròng thành `flowsBlock` nhúng vào prompt của market-analyst, risk-manager, news-sentiment và portfolio-strategist (xem [TECHNICAL_BLUEPRINT.md §5.2](./TECHNICAL_BLUEPRINT.md)).

- **Tần suất:** mỗi lần gọi `GET /api/market/flows` / mỗi run cycle (nguồn thật sẽ là EOD sau 15:00 ICT hoặc theo tuần).
- **Fallback:** thiếu metric → bỏ khỏi prompt, ghi chú trong `AgentMessage.reasoning`; không phỏng đoán (no fabrication).

---

## 5. Data Quality Rules (áp cho mọi nguồn ghi vào DB)

| # | Quy tắc | Chi tiết |
|---|---|---|
| Q1 | **Bội số 100 VND** | Mọi giá HOSE phải `price % 100 == 0` (tick size). Vi phạm → reject (nguồn ngoài) / round + flag (nguồn chính thức) |
| Q2 | **Dải giá ±7% (HOSE)** | `floorPrice ≤ price ≤ ceilingPrice`, với trần/sàn = round100(ref × 1.07 / × 0.93). HNX ±10%, UPCOM ±15% áp khi mở rộng thị trường |
| Q3 | **Khối lượng không âm** | `volume ≥ 0`, `quantity > 0`, `value ≥ 0`; `value` nhất quán ≈ Σ(price × qty) |
| Q4 | **Dedup OHLCV** | `Bar` ràng buộc `@@unique([instrumentId, date])` — ingest lại dùng upsert (idempotent); `Quote` **update-in-place** tại quote mới nhất mỗi mã (1 row/mã, `tradedAt` ghi mỗi tick; lưu lịch sử tick là roadmap — audit 2026-10-06 F-204) |
| Q5 | **Đồng nhất change** | `change = last − refPrice`; `changePct = change / refPrice × 100` (làm tròn 2 chữ số) |
| Q6 | **Timezone** | Lưu UTC trong DB; hiển thị `Asia/Ho_Chi_Minh` (UTC+7); ngày giao dịch closes 15:00 ICT; `Bar.date` chuẩn hóa EOD |
| Q7 | **Lịch giao dịch** | Thứ 2–thứ 6 + **lịch nghỉ lễ VN 2026 ước lượng** (Tết Dương lịch, Tết Bính Ngọ, Giỗ Tổ, 30/4–1/5, Quốc khánh) đã cài trong `src/lib/market-session.ts`; lịch chính thức từng năm — roadmap; ngoài phiên → không sinh quote mới |
| Q8 | **Phiên HOSE** | ATO 09:00–09:15 · liên tục **09:15–11:30** · liên tục **13:00–14:45** · ATC 14:45–15:00 — logic "in-session" dùng cho scheduler & stale marking |
| Q9 | **Số nguyên VND** | Không nhận giá tiền dạng thập phân; quy đổi tại ingest nếu nguồn trả decimal (xem [DB_SCHEMA.md §3](./DB_SCHEMA.md)) |

---

## 6. Fallback Strategy (tổng quát)

1. **Serve last cached**: quote/bản tin cuối vẫn hiển thị — DB chính là cache bền (tin tức RSS lưu bền trong `NewsItem`).
2. **Mark stale**: **đã implement** — bảng `DataSourceStatus` (singleton-theo-key) ghi `mode` + `lastSuccessAt` mỗi lần nguồn thành công/thất bại; `GET /api/system/status` tính `stale`/`ageMinutes` cho từng nguồn; footer dashboard hiển thị chip trạng thái từng nguồn (dot màu: live=green · simulated=amber · fallback=red · stale=amber, kèm `lastError`); `GET /api/news` meta cũng mang `stale`/`ageMinutes`/`providers`.
3. **No fabrication**: agent không được bịa số liệu khi thiếu nguồn — khai báo rõ "no new data" trong `AgentMessage`; dữ liệu mô phỏng (S4 tick, S6 flows) luôn gắn `mode="simulated"` và được báo rõ trong prompt.
4. **Escalate**: **đã implement** — nguồn stale kéo dài **quá 4 tiếng** → `RiskAlert` WARNING (`code: DATA_SOURCE_STALE`, `metricKey: source.<key>.stale_minutes`, dedupe 24h) để trader quyết định tiếp tục paper-run hay dừng; chạy tự động mỗi lần `GET /api/system/status` được gọi (`escalateStaleSources()`).

---

## 7. Implementation Checklist

**✅ Done (verified trong codebase):**

- [x] Prisma schema 19 models + 12 enums đã push vào SQLite (`db/custom.db`) — [DB_SCHEMA.md](./DB_SCHEMA.md)
- [x] Seed generator deterministic: 30 mã VN30, 90 ngày OHLCV, quote kèm trần/sàn ±7%, demo portfolio, 5 agent + runs/messages/tasks/signals/orders/trades/positions/risk alerts/watchlist (`prisma/seed.ts`)
- [x] Chuẩn integer VND + round100 + fee 0.15% / tax 0.1% TNCN trong dữ liệu mẫu
- [x] LLM phân tích đa agent qua `z-ai-web-dev-sdk` (glm-4.6, backend-only) trong `POST /api/agents/run`, có audit `AgentRun` (tokens/cost/duration)
- [x] Ràng buộc dedup `Bar @@unique([instrumentId, date])` + composite indexes cho truy vấn feed
- [x] **Market data ingestion job (S4 — mô phỏng):** tick engine `POST /api/market/tick` (random-walk + mean-reversion, Q1–Q5) được market-engine gọi mỗi 10s (`TICK_MS`); `MARKET_STRICT_SESSION` chỉ cho tick trong phiên
- [x] **Đánh dấu stale cho quote cache (S4):** `DataSourceStatus` + `GET /api/system/status` + chips trạng thái nguồn trên footer + `escalateStaleSources()` → RiskAlert `DATA_SOURCE_STALE`
- [x] **News crawler RSS + dedupe (S5):** 5 feed VN kiểm chứng (VnEconomy, CafeF, VNExpress, Tuổi Trẻ, VietnamNet), parser `fast-xml-parser`, dedupe theo `url` (model `NewsItem`), rate-limit 60s, audit `NEWS_INGESTED`
- [x] **Alternative data EOD (S6 — simulated):** flows simulator deterministic (`GET /api/market/flows`) + RiskAlert `FOREIGN_FLOW_OUTFLOW` (−300 tỷ, dedupe 24h) + `flowsBlock` trong prompt agent
- [x] **WebSocket mini-service realtime quotes:** `mini-services/market-engine` (port 3003) broadcast `quotes`/`news`/`cycle` + scheduler; client nối qua gateway `io("/?XTransformPort=3003")` (hook `useRealtimeMarket`)
- [x] **Job scheduler chu kỳ agent run tự động trong phiên:** có sẵn trong market-engine (`AGENT_CYCLE_MINUTES`) — **mặc định 0 = TẮT** để tiết kiệm chi phí LLM
- [x] S3 scaffold: feature flag `LIVE_TRADING` + cổng kiểm tra + audit (`LIVE_TRADING_BLOCKED` / `LIVE_ORDER_GATEWAY_UNAVAILABLE`)
- [x] Lịch giao dịch T2–T6 + nghỉ lễ VN 2026 ước lượng (`src/lib/market-session.ts`) + sessionPhase (ATO/liên tục/trưa/ATC)

**🔜 Pending (theo roadmap [TECHNICAL_BLUEPRINT.md §9](./TECHNICAL_BLUEPRINT.md)):**

- [ ] Tích hợp VNDIRECT Trading API thật (auth, đặt/hủy lệnh, sync số dư) sau feature flag `LIVE_TRADING` — gateway mini-service còn pending
- [ ] Market data feed thật (VNDIRECT/VPS · HOSE/HNX) thay tick mô phỏng + upsert EOD bar thật + ref/ceiling/floor đầu phiên
- [ ] Dữ liệu khối ngoại/margin thật (EOD) thay flows simulator
- [ ] HNX/UPCOM (dải giá ±10% / ±15%) + lịch nghỉ Tết chính thức từng năm
- [ ] Reuters/tin quốc tế cho bối cảnh Fed/DXY (tuỳ chọn)

---

## 8. Change Log

| Ngày | Thay đổi |
|---|---|
| 2026-10-05 | Tái tạo tài liệu sau reset workspace; đối chiếu `prisma/seed.ts`, `prisma/schema.prisma`, `package.json` |
| 2026-10-06 | **Giai đoạn 2:** S3 → 🟡 Scaffold (flag `LIVE_TRADING` + audit, gateway pending); S4 → ✅ Implemented (tick engine mô phỏng + stale marking `DataSourceStatus`); S5 → ✅ Implemented (crawler RSS live 5 nguồn VN + model `NewsItem` dedupe url); S6 → ✅ Implemented (flows simulator deterministic + RiskAlert `FOREIGN_FLOW_OUTFLOW`); cập nhật §4.1–4.4, §5 Q7 (lịch lễ 2026), §6 fallback đã implement, checklist tick các mục realtime/scheduler/crawler |
