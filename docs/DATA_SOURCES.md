# The Trader — Data Sources Inventory

> **Project:** The Trader — Hệ thống giao dịch đa agent (Multi-Agent Trading System) cho VNDIRECT
> **Document:** `docs/DATA_SOURCES.md` · **Version:** 0.1.0 · **Updated:** 2026-10-05
> **Cross-refs:** [DB_SCHEMA.md](./DB_SCHEMA.md) (data dictionary) · [TECHNICAL_BLUEPRINT.md](./TECHNICAL_BLUEPRINT.md) (API surface & kiến trúc)

---

## 1. Purpose

Tài liệu này là **kho kiểm kê (inventory) mọi nguồn dữ liệu** mà The Trader tiêu thụ hiện tại hoặc dự kiến tích hợp: nguồn nội bộ (seed generator, LLM), nguồn ngoài dự kiến (API giao dịch VNDIRECT, market data, tin tức, dữ liệu thay thế). Với mỗi nguồn, tài liệu ghi rõ: endpoint/bảng dữ liệu, tần suất cập nhật, **mapping sang model Prisma** (field nào được đổ dữ liệu từ nguồn nào), và **chiến lược fallback** khi nguồn không khả dụng.

Nguyên tắc chung: **mọi dữ liệu thị trường phải qua validate §5 trước khi ghi DB**; khi nguồn ngoài chết, hệ thống **phục vụ bản cache cuối cùng và đánh dấu stale** — không bao giờ render giá "sống" từ nguồn không xác thực.

---

## 2. Inventory Summary

| # | Nguồn | Loại | Trạng thái | Hướng | Models Prisma affected |
|---|---|---|---|---|---|
| S1 | Seed generator nội bộ (`prisma/seed.ts`) | Nội bộ, deterministic | ✅ **Implemented** | → DB | Tất cả 17 models (demo) |
| S2 | LLM glm-4.6 (`z-ai-web-dev-sdk`) | AI service, backend-only | ✅ **Implemented** | → DB | `AgentMessage`, `AgentRun`, `Signal`, `Order` (paper), `AuditLog`, `Agent` (health) |
| S3 | VNDIRECT Trading API | Broker API | 🔜 Planned (feature flag) | ↔ ngoài | `Order`, `Trade`, `BrokerAccount`, `Position`, `AuditLog` |
| S4 | Market data feed (VNDIRECT/VPS · HOSE/HNX) | Market data | 🔜 Planned | → DB | `Quote`, `Bar`, `Instrument` |
| S5 | Tin tức tài chính (CafeF, VnEconomy, Tuổi Trẻ, Reuters) | News | 🔜 Planned | → LLM context | `AgentMessage` (sentiment), `Signal` (gián tiếp) |
| S6 | Alternative data (dòng khối ngoại, margin) | Quant data | 🔜 Planned | → LLM context | `RiskAlert` (metric), prompt context |

---

## 3. Nguồn hiện tại (Implemented)

### 3.1 S1 — Seed generator nội bộ (`prisma/seed.ts`)

**Mục đích:** sinh bộ dữ liệu demo deterministic để dashboard và 5 agent có dữ liệu hoạt động ngay mà không phụ thuộc nguồn ngoài. Chạy thủ công: `bun prisma/seed.ts` (sau `bun run db:push`). Script **xóa sạch dữ liệu cũ** trước khi ghi — chỉ dùng cho dev/demo.

**Thuật toán (đảm bảo reproducible):**

- **PRNG kiểu LCG** với seed cố định `42`: `state = (state × 1103515245 + 12345) mod 2^31` → cùng seed cho cùng dữ liệu, test ổn định.
- **30 mã VN30** (HOSE, `STOCK`), mỗi mã có: tên công ty tiếng Việt, ngành (Ngân hàng, Bất động sản, Công nghệ, Vật liệu, Tiêu dùng, Bán lẻ, Năng lượng, Hàng không, Y tế, Chứng khoán…), **giá tham chiếu thực tế** (VCB 91,500 · FPT 138,700 · VNM 65,700…), độ biến động ngày (`vol` 1.1%–2.4%), khối lượng nền (`volBase` 0.3–9.2 triệu cp).
- **90 ngày giao dịch mỗi mã (2,700 bar):** bỏ thứ 7/CN; random-walk **có mean-reversion** về giá tham chiếu (drift 2%/ngày); `high`/`low` nở thêm ≤ 0.6 × vol; khối lượng 0.6–1.5 × `volBase`; **mọi giá làm tròn bội 100 VND** (`round100`); close phiên cuối **ép về đúng giá tham chiếu** để quote nhất quán.
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
- **Input:** snapshot từ DB — quotes + 90-day bars của watchlist, positions + avgPrice, số dư tài khoản, risk alerts đang mở — được pack vào role-prompt cho từng agent theo `Agent.config`.
- **Output parsed & persisted:**
  - `AgentMessage` (`content`, `reasoning`, `sentiment` bullish/bearish/neutral) — broadcast;
  - `Signal` từ bước tổng hợp của Portfolio Strategist (`direction`, `confidence`, `score`, `rationale`, `targetPrice/stopLoss/takeProfit`);
  - `Order` giấy từ Execution Manager (paper);
  - `AgentRun` audit mỗi agent: `tokensIn/tokensOut`, `costUsd`, `durationMs`, `taskStatus`, `output` JSON.
- **Tần suất:** on-demand khi trader bấm **Run agents**; roadmap: chu kỳ định kỳ (mỗi 15–60 phút trong phiên) + event-driven khi có tin khẩn.
- **Fallback:** nếu SDK/LLM lỗi hoặc timeout → run đánh dấu `FAILED` với `error`, agent chuyển `ERROR`, UI vẫn hiển thị `AgentMessage` cũ (last cached) kèm nhãn stale; có thể sinh `RiskAlert` (severity INFO/WARNING) "agent pipeline unavailable".

---

## 4. Nguồn ngoài dự kiến (Planned)

### 4.1 S3 — VNDIRECT Trading API (đặt lệnh & số dư)

| Hạng mục | Chi tiết |
|---|---|
| **Capability** | Đặt lệnh (LO/market), hủy lệnh, tra trạng thái lệnh, số dư & hạn mức (cash, margin), lịch sử khớp |
| **Auth** | OAuth2/access token cấp cho khách hàng VNDIRECT (open API); credential broker lưu env server-side, **không** lưu plaintext trong DB — tham chiếu qua `BrokerAccount.accountNumber` |
| **Rate limit** | Theo chính sách open platform VNDIRECT — client phải dùng token-bucket + exponential backoff; không spam endpoint trạng thái (poll mở lệnh 2–5s/lệnh) |
| **Tần suất** | Event-driven theo thao tác trader/agent + polling trạng thái lệnh đang mở |
| **Điều kiện bật** | Feature flag `LIVE_TRADING` (mặc định **off**) — xem [TECHNICAL_BLUEPRINT.md §8](./TECHNICAL_BLUEPRINT.md); mọi lệnh thật vẫn qua veto của Risk Manager |
| **Mapping Prisma** | `Order.status` PENDING→SUBMITTED→PARTIALLY_FILLED/FILLED/REJECTED, `filledQuantity`, `avgFillPrice`, `fee`, `submittedAt/filledAt/cancelledAt`; `Trade` mỗi lần khớp (`price`, `quantity`, `fee`, `tax`); `BrokerAccount.cashBalance/equity/marginUsed/status` sync định kỳ; `AuditLog` mỗi thao tác (`ORDER_SUBMITTED_LIVE`…) |
| **Fallback** | Gateway không phản hồi → giữ trạng thái `SUBMITTED`, đánh dấu "unconfirmed" trên UI, thử lại theo backoff; **không** tự hủy lệnh đã gửi (side-effect ngoài không được rollback mù quáng); mọi chi tiết ghi `AuditLog` |

### 4.2 S4 — Market data (VNDIRECT/VPS · HOSE/HNX)

| Hạng mục | Chi tiết |
|---|---|
| **Capability** | Quote level-1 realtime (bid/ask/last/volume), tick intraday, OHLCV EOD, giá tham chiếu/trần/sàn hàng ngày, danh mục mã niêm yết |
| **Endpoint dạng** | REST public/authorized của VNDIRECT/VPS hoặc feed HOSE/HNX — ước tính cần mini-service riêng cho tick streaming (roadmap WebSocket, [TECHNICAL_BLUEPRINT.md §8](./TECHNICAL_BLUEPRINT.md)) |
| **Tần suất** | Quote: 1–5s trong phiên (poll) hoặc realtime (mini-service); EOD bar: 1 lần/ngày sau 15:00 ICT; ref/ceiling/floor: đầu phiên 09:00 ICT |
| **Mapping Prisma** | `Quote.*` toàn bộ field (`open/high/low/last/close`, `volume`, `bid/askPrice/Volume`, `change/changePct`, `refPrice/ceilingPrice/floorPrice`, `tradedAt`); `Bar` (`open/high/low/close/volume/value` — upsert theo `@@unique([instrumentId, date])`); `Instrument` (`isActive`, `listingDate`, `outstandingShares`) |
| **Fallback** | **Phục vụ quote cache cuối + đánh dấu stale**: response API kèm `stale: true` và `tradedAt` tuổi thực; UI đổi màu/nhãn "data stale"; khôi phục tự động khi nguồn sống lại; không ghi quote rác vào DB |

### 4.3 S5 — Tin tức tài chính (News & Sentiment agent)

| Nguồn | Định dạng | Ghi chú tích hợp |
|---|---|---|
| **CafeF** (`cafef.vn`) | RSS feeds (tin chứng khoán, doanh nghiệp, vĩ mô) | Nguồn tin VN dày nhất; tiếng Việt; crawl hourly; lọc theo keyword mã/ngành trong watchlist |
| **VnEconomy** (`vneconomy.vn`) | RSS / HTML | Tin vĩ mô & chính sách — quan trọng cho macro view của Market Analyst |
| **Tuổi Trẻ Kinh tế** (`tuoitre.vn/kinh-doanh`) | RSS | Tin nhanh, đa ngành |
| **Reuters** (`reuters.com`) | RSS / API (nếu có license) | Bối cảnh quốc tế (Fed, DXY, hàng hóa) ảnh hưởng dòng vốn mới nổi |

- **Auth:** phần lớn public RSS; nếu dùng API thương mại → key trong env server-side.
- **Rate limit:** tôn trọng `robots.txt` + crawl cách nhau ≥ 30–60 phút mỗi nguồn; dedupe theo URL + content-hash.
- **Tần suất tiêu thụ:** News & Sentiment agent đọc batch tin mới mỗi run cycle (hiện chỉ khi `POST /api/agents/run` được gọi; roadmap: hourly).
- **Mapping Prisma:** không có model News riêng trong schema — tin được nén thành context trong prompt và **kết quả** lưu qua `AgentMessage.content/reasoning/sentiment` (bullish/bearish/neutral) + ảnh hưởng `Signal.score`. (Roadmap: thêm model `NewsItem` nếu cần traceability từng bài.)
- **Fallback:** nguồn tin chết → agent báo "no new data since <timestamp>" trong message, giữ sentiment cũ; đa nguồn → mất một nguồn chỉ giảm phủ, không chết luồng.

### 4.4 S6 — Alternative data (dòng khối ngoại, margin)

| Nguồn | Dữ liệu | Mapping |
|---|---|---|
| Khối ngoại (foreign flows) | Mua/bán ròng theo mã & theo sàn (EOD, từ HOSE/HNX hoặc tổng hợp CafeF) | Prompt context cho Market Analyst/Strategist; `RiskAlert` khi dòng ròng đảo chiều mạnh (VD `metricKey: "market.foreign_flow.net"`) |
| Margin data | Dư nợ margin theo mã/định mức các broker (EOD) | Prompt context cho Risk Manager; `RiskAlert.metricKey: "portfolio.margin_concentration"` |

- **Tần suất:** EOD (sau 15:00 ICT) hoặc theo tuần.
- **Fallback:** thiếu metric → bỏ khỏi prompt, ghi chú trong `AgentMessage.reasoning`; không phỏng đoán (no fabrication).

---

## 5. Data Quality Rules (áp cho mọi nguồn ghi vào DB)

| # | Quy tắc | Chi tiết |
|---|---|---|
| Q1 | **Bội số 100 VND** | Mọi giá HOSE phải `price % 100 == 0` (tick size). Vi phạm → reject (nguồn ngoài) / round + flag (nguồn chính thức) |
| Q2 | **Dải giá ±7% (HOSE)** | `floorPrice ≤ price ≤ ceilingPrice`, với trần/sàn = round100(ref × 1.07 / × 0.93). HNX ±10%, UPCOM ±15% áp khi mở rộng thị trường |
| Q3 | **Khối lượng không âm** | `volume ≥ 0`, `quantity > 0`, `value ≥ 0`; `value` nhất quán ≈ Σ(price × qty) |
| Q4 | **Dedup OHLCV** | `Bar` ràng buộc `@@unique([instrumentId, date])` — ingest lại dùng upsert (idempotent); `Quote` append-only theo `tradedAt` |
| Q5 | **Đồng nhất change** | `change = last − refPrice`; `changePct = change / refPrice × 100` (làm tròn 2 chữ số) |
| Q6 | **Timezone** | Lưu UTC trong DB; hiển thị `Asia/Ho_Chi_Minh` (UTC+7); ngày giao dịch closes 15:00 ICT; `Bar.date` chuẩn hóa EOD |
| Q7 | **Lịch giao dịch** | Thứ 2–thứ 6 (seed bỏ thứ 7/CN); lịch nghỉ lễ/Tết chưa cài — roadmap; ngoài phiên → không sinh quote mới |
| Q8 | **Phiên HOSE** | ATO 09:00–09:15 · liên tục **09:15–11:30** · liên tục **13:00–14:45** · ATC 14:45–15:00 — logic "in-session" dùng cho scheduler & stale marking |
| Q9 | **Số nguyên VND** | Không nhận giá tiền dạng thập phân; quy đổi tại ingest nếu nguồn trả decimal (xem [DB_SCHEMA.md §3](./DB_SCHEMA.md)) |

---

## 6. Fallback Strategy (tổng quát)

1. **Serve last cached**: quote/bản tin cuối vẫn hiển thị — DB chính là cache bền.
2. **Mark stale**: response kèm cờ tuổi dữ liệu (`tradedAt` age); UI sticky footer + panel hiển thị trạng thái nguồn (live / stale / offline).
3. **No fabrication**: agent không được bịa số liệu khi thiếu nguồn — khai báo rõ "no new data" trong `AgentMessage`.
4. **Escalate**: mất nguồn kéo dài (quá 1 phiên) → `RiskAlert` WARNING (`code: DATA_SOURCE_STALE`) để trader quyết định tiếp tục paper-run hay dừng.

---

## 7. Implementation Checklist

**✅ Done (verified trong codebase):**

- [x] Prisma schema 17 models + 12 enums đã push vào SQLite (`db/custom.db`) — [DB_SCHEMA.md](./DB_SCHEMA.md)
- [x] Seed generator deterministic: 30 mã VN30, 90 ngày OHLCV, quote kèm trần/sàn ±7%, demo portfolio, 5 agent + runs/messages/tasks/signals/orders/trades/positions/risk alerts/watchlist (`prisma/seed.ts`)
- [x] Chuẩn integer VND + round100 + fee 0.15% / tax 0.1% TNCN trong dữ liệu mẫu
- [x] LLM phân tích đa agent qua `z-ai-web-dev-sdk` (glm-4.6, backend-only) trong `POST /api/agents/run`, có audit `AgentRun` (tokens/cost/duration)
- [x] Ràng buộc dedup `Bar @@unique([instrumentId, date])` + composite indexes cho truy vấn feed

**🔜 Pending (theo roadmap [TECHNICAL_BLUEPRINT.md §8](./TECHNICAL_BLUEPRINT.md)):**

- [ ] Tích hợp VNDIRECT Trading API (auth, đặt/hủy lệnh, sync số dư) sau feature flag `LIVE_TRADING`
- [ ] Market data ingestion job: poll quote trong phiên + upsert EOD bar + ref/ceiling/floor đầu phiên
- [ ] Đánh dấu stale cho quote cache khi nguồn chết (cờ response + UI)
- [ ] News crawler RSS (CafeF, VnEconomy, Tuổi Trẻ, Reuters) + dedupe URL/hash cho News & Sentiment agent
- [ ] Alternative data EOD: dòng khối ngoại, dư nợ margin
- [ ] WebSocket mini-service realtime quotes
- [ ] Lịch nghỉ lễ/Tết + dải giá HNX ±10% / UPCOM ±15%
- [ ] Job scheduler chu kỳ agent run tự động trong phiên

---

## 8. Change Log

| Ngày | Thay đổi |
|---|---|
| 2026-10-05 | Tái tạo tài liệu sau reset workspace; đối chiếu `prisma/seed.ts`, `prisma/schema.prisma`, `package.json` |
