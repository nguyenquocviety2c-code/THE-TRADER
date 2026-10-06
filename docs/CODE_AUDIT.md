# The Trader — Kế hoạch rà soát code (Code Audit Checklist)

> **Project:** The Trader — Hệ thống giao dịch đa agent cho VNDIRECT
> **Document:** `docs/CODE_AUDIT.md` · **Version:** 0.1.0 · **Created:** 2026-10-06
> **Cross-refs:** [PHASE3_BLUEPRINT.md](./PHASE3_BLUEPRINT.md) (§7.1: audit chạy TRƯỚC khi triển khai Giai đoạn 3) · [TECHNICAL_BLUEPRINT.md](./TECHNICAL_BLUEPRINT.md) · [DB_SCHEMA.md](./DB_SCHEMA.md) · [DATA_SOURCES.md](./DATA_SOURCES.md)
> **Mục đích:** rà soát **toàn bộ code hiện tại** (v0.3 — sau Giai đoạn 1+2) tìm lỗi, vấn đề, thiếu sót trước khi xây Giai đoạn 3. Mỗi phần dưới đây liệt kê **chi tiết những gì phải kiểm, cách kiểm, tiêu chuẩn đạt**.

---

## 1. Phương pháp & quy ước

### 1.1 Phân cấp mức độ (severity)

| Cấp | Tên | Định nghĩa | Ví dụ |
|---|---|---|---|
| **P0** | Blocker | V_apps sai số tiền / crash / mất dữ liệu / lộ secret | BigInt tràn khi serialize, SQL lỗi chạy runtime |
| **P1** | Critical | Sai logic nghiệp vụ tài chính, hỏng luồng chính, lỗi bảo mật không lộ secret | công thức changePct sai, chu kỳ agent crash giữa chừng |
| **P2** | Major | UX hỏng ở nhánh phụ, hiệu năng xấu rõ rệt, doc-code mâu thuẫn | hydration warning, N+1 query feed, doc ghi append nhưng code update |
| **P3** | Minor | Cảnh báo, code smell, thiếu test thủ công, accessibility | thiếu aria-label, magic number |

**Nguyên tắc:** mọi finding phải kèm **bằng chứng** (file:dòng, output lệnh, screenshot) — không đoán.

### 1.2 Bộ công cụ kiểm

| Công cụ | Dùng cho |
|---|---|
| `bunx tsc --noEmit` | type-safety toàn bộ |
| `bun run lint` | ESLint + rule Next.js |
| `agent-browser` (qua gateway :81) | E2E, console errors, tương tác, responsive 390/1440 |
| `z-ai vision` (VLM) | audit ảnh chụp từng section |
| `curl` từng endpoint | status code, shape JSON, biên (empty DB, id rác…) |
| `bun` script import route module | gọi handler trực tiếp không cần HTTP |
| Đọc code tay | đối chiếu doc ↔ code ↔ schema |
| `sqlite3 db/custom.db` (read-only) | kiểm dữ liệu thật trong DB |

### 1.3 Thứ tự chuẩn từng phần

**Đọc → Kiểm tĩnh (tsc/lint) → Kiểm runtime (curl/browser) → Ghi finding → Đề xuất fix.**

---

## 2. Bản đồ phạm vi (inventory)

| Vùng | Số lượng | Vị trí |
|---|---|---|
| Prisma schema + seed | 19 models, 12 enums, ~2,700 bar seed | `prisma/schema.prisma`, `prisma/seed.ts`, `db/custom.db` |
| API routes | 17 endpoint (15 file route + `/api/signals/[id]/convert`) | `src/app/api/**` |
| Lib | 14 file | `src/lib/*` |
| Components | 11 dashboard + layout + page | `src/components/**`, `src/app/**` |
| Hooks | 2 | `src/hooks/use-realtime.ts`, `use-run-agents.ts` |
| Mini-service | 1 | `mini-services/market-engine/index.ts` (port 3003) |
| Realtime client | 1 | socket.io qua gateway `XTransformPort=3003` |
| Env/config | `.env`, `.env.example`, `trading-mode`, `market-session` | — |
| Docs | 5 file MD | `docs/*` |

---

## 3. Chi tiết kiểm tra theo phần

### A. Prisma schema & seed

**A1. Tính nhất quán schema ↔ DB_SCHEMA.md**
- [ ] Đối chiếu từng model (19) field-by-field với docs/DB_SCHEMA.md §6.1–§6.19 — tên, kiểu, default, ràng buộc, index. Mọi lệch = P2 (doc hoặc code sai một trong hai).
- [ ] 12 enum: giá trị trong code khớp bảng enum dictionary §6 phụ lục.
- [ ] Quan hệ `onDelete`: Cascade vs SetNull đúng mô tả (đặc biệt `Signal.agent` = SetNull, `AgentTask.agent` = Cascade).

**A2. Chính sách kiểu dữ liệu tài chính**
- [ ] Mọi trường tiền VND lớn là `BigInt` (cashBalance, equity, marginUsed, realizedPnl, Order.fee, Trade.fee/tax, Bar.value) — kiếm tra bằng grep `Int` trong các model có tiền; lệch = P0.
- [ ] Giá/cổ phiếu là `Int` (bội 100 VND); phần trăm là `Float`.
- [ ] Không có kiểu list (mảng) trên primitive — ràng buộc sandbox.

**A3. Index & ràng buộc vs truy vấn thật**
- [ ] Mỗi truy vấn feed "mới nhất trước" có index `(fk, createdAt desc)` tương ứng: Bar, Quote, AgentRun, AgentMessage, Signal, Order, NewsItem.
- [ ] `@@unique([instrumentId, date])` Bar & `@@unique([broker, accountNumber])` BrokerAccount & `NewsItem.url` unique — còn hiệu lực trong DB thật (PRAGMA index_list).
- [ ] Truy vấn phổ biến có dùng được index (EXPLAIN QUERY PLAN qua sqlite3) — không scan toàn bảng.

**A4. Seed & tính deterministic**
- [ ] Chạy lại `bun prisma/seed.ts` 2 lần → dữ liệu giống hệt (LCG seed 42) — khác nhau = P1.
- [ ] Seed có xóa dữ liệu cũ (deleteMany theo đúng thứ tự FK) — không lỗi ràng buộc Cascade.
- [ ] Giá seed: mọi `price % 100 == 0` (Q1); close cuối = giá tham chiếu gốc; `change/changePct` nhất quán (Q5).
- [ ] Trần/sàn = round100(ref × 1.07 / 0.93) đúng ±7% (Q2).
- [ ] 30 mã × 90 ngày = 2,700 bar; bỏ T7/CN (Q7).

---

### B. API Route Handlers (17 endpoint)

**B1. Bảng kiếm tra chung áp cho TẤT CẢ route** (chạy curl từng endpoint, đối chiếu code):

| # | Kiểm | Tiêu chuẩn |
|---|---|---|
| 1 | `export const dynamic = "force-dynamic"` | mọi route có — thiếu = dữ liệu stale cache |
| 2 | BigInt serialization | response không còn chuỗi BigInt / không crash `JSON.stringify`; mọi số tiền là Number |
| 3 | try/catch toàn cục | lỗi DB/LLM trả `{error}` 5xx JSON — không trả HTML stack |
| 4 | Trạng thái rỗng | DB rỗng (giả lập bằng query where không khớp) → 200 + mảng rỗng, không 500, không `null.data` |
| 5 | Input validation | param `days`, `limit`, `symbol`, path `[id]` rác → 400/404 có thông báo VN, không exception lộ stack |
| 6 | Unicode tiếng Việt | response JSON không mojibake (utf-8 header) |
| 7 | PII | không route nào trả `passwordHash`/`phone`; `accountNumber` chỉ qua /api/portfolio đã mask `VD00••••1828` |
| 8 | Thời gian | mọi DateTime ISO UTC; client tự format Asia/Ho_Chi_Minh (Q6) |

**B2. Kiểm riêng từng endpoint**

- [ ] `GET /api/market/quotes`: 30 mã sort volume desc; `summary.breadth` đếm đúng tăng/giảm (so sqlite tay); `meta.mode/asOf` có mặt; giá bid/ask không âm.
- [ ] `POST /api/market/tick`: sau tick, `change = last − refPrice` đúng Q5; giá trong dải sàn-trần Q2; volume chỉ tăng Q3; `tradedAt` cập nhật; DataSourceStatus `lastSuccessAt` ghi; **kiểm 10 tick liên tục không tạo row Quote mới (update tại chỗ) — đối chiếu với Q4 doc đang ghi "append-only" → mâu thuẫn doc/code phải xử lý (P2, xem §5 mục 3)**.
- [ ] `GET /api/instruments/bars?symbol=&days=`: SMA20 tính trên full history trước khi slice (mã mới < 20 phiên → SMA null không NaN); `days` cap 90; sai symbol → 404.
- [ ] `GET /api/portfolio`: totals đúng (totalEquity = cash + GTTH; dayChangePct bình quân theo trọng số GTTH); unrealizedPnl = (last − avgPrice) × qty; mask accountNumber.
- [ ] `GET /api/orders` + `GET /api/agents` + `GET /api/agents/messages` + `GET /api/signals` + `GET /api/risk/alerts`: shape khớp TYPES trong `src/lib/types.ts`; limit đúng 20/12/30/12/10.
- [ ] `POST /api/agents/run` (chu kỳ đầy đủ): 5/5 agent persist AgentRun; Signal có đủ targetPrice/stopLoss/takeProfit; Order paper: qty lô 100, giá LIMIT bội 100, fee 0.15% notional (so công thức); audit AGENT_RUN_COMPLETED + SIGNAL_APPROVED + ORDER_CREATED có `before/after`; response chứa `failures[]` khi agent lỗi (ch không crash cả chu kỳ); **rate-limit KHÔNG có (đã xác minh Task 17) → ghi finding P1: spam nút = tốn chi phí LLM không giới hạn → fix ở PHASE3 §4.3/4.4**.
- [ ] `POST /api/signals/[id]/convert`: 404 signal rác; 409 signal đã actedAt; BUY ~50 triệu budget; SELL nửa vị thế; lệnh PENDING + `mode` audit (paper/live-unconfigured 503, live thiếu gateway 501 — kiểm tra đủ 3 nhánh của `trading-mode.ts`).
- [ ] `GET /api/news` + `POST /api/news`: rate-limit 60s trả 429 kèm retry; dedupe theo url (nạp 2 lần không nhân đôi); summary đã strip HTML (không còn `<a href`); `meta.stale/ageMinutes/providers`.
- [ ] `GET /api/market/flows`: deterministic — gọi 2 lần cùng ngày cùng symbol cho cùng kết quả; tổng mua/bán ròng nhất quán với top 5 từng phía; mode "simulated" ghi rõ.
- [ ] `GET /api/system/status`: 3 nguồn (market-quotes/news/foreign-flows) có mode + stale + ageMinutes; `escalateStaleSources` tạo RiskAlert DATA_SOURCE_STALE khi ép stale > 4h (kiểm thủ công bằng cách set lastSuccessAt cũ) — dedupe 24h không spam.
- [ ] `GET /api/market/watchlist` + `POST /api/watchlist/toggle`: toggle 2 chiều (thêm→gỡ) đúng mã; audit WATCHLIST_ADDED/REMOVED; hành vi khi watchlist rỗng.

---

### C. Thư viện `src/lib` (14 file — kiểm từng file)

| File | Những gì phải kiểm |
|---|---|
| `serialize.ts` | `toPlain` đệ quy: BigInt → Number, Date giữ ISO; không vòng lặp vô hạn (object lồng nhau); mảng BigInt rỗng an toàn |
| `indicators.ts` | SMA/RSI14/momentum/`latestVsMean` — đối chiếu giá trị tính tay trên chuỗi 20 số mẫu (RSI chuẩn Wilder: dùng trung bình trơn, không trung bình đơn giản); chia 0/empty input → null không NaN |
| `health.ts` | `updateAgentHealth` clamp 0–100; FAILED −12, COMPLETED +2; agent khỏe không vượt 100; đo lường P50 duration chuẩn xác |
| `news.ts` | 5 feed URL còn đúng; parser `fast-xml-parser` chịu RSS 2.0 + Atom + feed hỏng XML nửa chừng (không throw); strip HTML title (thẻ `<img>`, `<![CDATA[`); timeout 8s có hiệu lực (giả lập feed chậm); rate-limit guard in-memory |
| `flows.ts` | FNV-1a hash: cùng (symbol, ngày) → cùng hệ số; scale theo thanh khoản thật (0.5–6% GTGD), clamp 2–80 tỷ; ngưỡng −300 tỷ tạo alert đúng 1 lần/24h |
| `sources.ts` | `staleOf` ngưỡng tuổi từng nguồn; `escalateStaleSources` dedupe 24h (kiểm 2 lần gọi liên tiếp chỉ 1 alert) |
| `market-session.ts` | **Timezone: mọi phép so sánh giờ dùng Asia/Ho_Chi_Minh đúng (UTC+7, không nhầm với giờ máy chủ UTC)**; phiên 09:15–11:30/13:00–14:45 T2–T6; lịch nghỉ lễ 2026 ước lượng khớp bảng doc; kết quả ATO/liên tục/trưa/ATC/đóng cửa đúng từng mốc biên (09:15:00, 11:30:00, 13:00:00, 14:45:00) |
| `trading-mode.ts` | 3 nhánh paper/503/501 đúng điều kiện env; không đọc env ở client |
| `market-quotes.ts` | mean-reversion 3% giữ giá quanh refPrice khi chạy lâu (không dồn biên trần/sàn — đã fix Task 13, kiểm lại); clamp trần/sàn trước khi ghi |
| `format.ts` | formatVnd/formatPct/formatVolume/formatVndCompact/vnClock: vi-VN chuẩn; round100; `changeColor` dấu đúng; hydration-safe (server/client cùng kết quả) |
| `api.ts` | mọi URL relative; lỗi fetch → throw có type (không swallow) |
| `store.ts` (Zustand) | slice không conflict key; selector ổn định (không tạo object mới mỗi render → re-render thừa) |
| `types.ts` | khớp 1-1 shape response thật từng route (so curl) |
| `db.ts` | singleton đúng pattern globalThis (dev hot-reload không mở nhiều connection — kiểm log Prisma warning) |

---

### D. Frontend components & hooks

**D1. Kiểm chung (dùng agent-browser + console)**
- [ ] **Zero console error/warning** khi load `/` qua :81 (desktop + mobile) — đặc biệt React hydration mismatch, `setState during render` (đã từng gặp Task 13).
- [ ] Mọi fetch qua TanStack Query (không `useEffect` + `fetch` thủ công lấn sân); loading = Skeleton; error state có thông báo.
- [ ] Danh sách động có `key` ổn định (id, không index khi sort); `max-h-* overflow-y-auto` + `.custom-scrollbar` cho mọi list dài (quotes, messages, tasks, news, orders).
- [ ] Dark/light toggle cả trang nhất quán (không section trắng lơ lửng).
- [ ] Touch target ≥ 44px (nút sao watchlist, tab, toggle theme).
- [ ] `tabular-nums` cho toàn bộ cột số; `text-up/text-down` đúng dấu (dấu + luôn xanh, − luôn đỏ — kể cả ô "lãi +1,71%" từng bị VLM đọc nhầm màu).
- [ ] Footer sticky bottom khi trang ngắn; đẩy xuống tự nhiên khi dài (kiểm cả 2 trang thái).

**D2. Kiểm riêng từng component**
- [ ] `header.tsx`: đồng hồ không lệch hydration; badge phiên đúng logic market-session; nút Run disabled khi đang chạy; equity chip khớp /api/portfolio.
- [ ] `market-summary.tsx`: breadth 9/15 tổng = số mã có change ≠ 0 (thật ra = tổng mã tính; kiểm công thức); liquidity = tổng value phiên.
- [ ] `quotes-table.tsx`: search theo mã/tên/ngành (có dấu tiếng Việt); click hàng → chart đổi mã (kiểm keyboard Enter); toggle watchlist giữ trang thái khi refetch.
- [ ] `price-chart.tsx`: SMA20 dashed đúng cửa sổ; gradient đổi theo xu hướng; dropdown đủ 30 mã; tooltip không che chart trên mobile.
- [ ] `portfolio-section.tsx`: 3 tab giữ dữ liệu riêng; status badge đúng màu từng trạng thái; tổng hàng cuối khớp tổng cột.
- [ ] `agents-panel.tsx`: 5 card đủ; health bar màu theo ngưỡng (<60 amber); "Đang chạy…" hiển thị trong lúc POST; feed sentiment badge đúng polarity.
- [ ] `signals-feed.tsx`: nút Chuyển lệnh → toast + badge đã chuyển; guard 409 hiển thị thông báo.
- [ ] `risk-alerts.tsx`: severity màu đúng (Nghiêm trọng đỏ / Cảnh báo amber / Thông tin xám).
- [ ] `news-card.tsx`: link mở tab mới (rel noopener); badge nguồn + thời gian tương đối (date-fns vi).
- [ ] `footer.tsx` + pulse bar: chip nguồn động theo /api/system/status; "tick Xs trước" cập nhật; socket event không render-blocking (đã fix Task 13 — kiểm lại sau 60s+).
- [ ] `use-realtime.ts`: mount/unmount không rò listener (`off` đủ 4 event); reconnect tự động sau khi restart market-engine (thử: kill service → start lại → giá tiếp tục cập nhật); cache TanStack được patch thẳng (setQueryData) không double-fetch.
- [ ] `use-run-agents.ts`: invalidate đúng các query liên quan sau run.

---

### E. Realtime & mini-service market-engine

- [ ] **Khởi động độc lập:** `bun run dev` trong `mini-services/market-engine` — service dậy, log health, không crash khi Next app chưa sẵn sàng (retry các cờ POST tick).
- [ ] **Hợp đồng event:** payload `quotes` (mảng đủ field UI cần) / `news` / `cycle` / `welcome` khớp với handler client — đổi một bên mà quên bên kia = P1 im lặng.
- [ ] **Chu kỳ tick 10s:** đều tay; `MARKET_STRICT_SESSION=true` chỉ sinh tick trong phiên (kiểm ngoài giờ bằng cách set env + fake giờ hoặc hàm pure test).
- [ ] **Scheduler agent (`AGENT_CYCLE_MINUTES`):** = 0 (mặc định) → KHÔNG tự gọi LLM (kiểm log + bảng AgentRun không tăng); ≠ 0 → chu kỳ chạy và có audit.
- [ ] **Crawler news 15 phút (`NEWS_MS`):** dừng/đóng băng không treo cả service (feed lỗi → log + DataSourceStatus fallback, service vẫn tick).
- [ ] **Tài nguyên:** chạy 30 phút — RSS/GC không làm bộ nhớ phình (ps RSS ổn định); không tích luỹ timer trùng.
- [ ] **Gateway:** client qua `io("/?XTransformPort=3003")` — KHÔNG hard-code `localhost:3003` ở bất kỳ đâu (grep toàn src/).
- [ ] **Một instance duy nhất:** không chạy 2 tiến trình engine cùng lúc (trùng lẫn tick đôi) — kiểm `ps` + note vận hành.

---

### F. Bảo mật & tuân thủ

- [ ] **Secret sweep:** grep toàn repo theo dõi git cho `ghp_`, `sk-`, `password`, token — 0 kết quả trong file được track (`.env`, `.git/credentials` đã bị ignore — xác nhận lại `git check-ignore`).
- [ ] SDK `z-ai-web-dev-sdk` chỉ import trong route handler (grep import trong `src/components`, `src/hooks` → phải rỗng).
- [ ] Không Server Actions (grep `"use server"` → rỗng) — mọi mutation qua Route Handler.
- [ ] SQL injection: toàn bộ truy vấn Prisma (không `$queryRawUnsafe` / `$executeRawUnsafe`).
- [ ] XSS từ nguồn ngoài: title/summary RSS có `<script>`/`onerror=` → render dạng text (React escape mặc định — kiểm không dùng `dangerouslySetInnerHTML`).
- [ ] `LIVE_TRADING` mặc định false trong `.env.example`; các biến `VNDIRECT_*` không có giá trị thật commit.
- [ ] AuditLog phủ mọi mutation nhạy cảm (đối chiếu danh sách action ở TECHNICAL_BLUEPRINT §7 với code thật — thiếu action nào = P2).
- [ ] Header không hiển thị số tài khoản đủ (mask) — kể cả title/tooltip/aria.

---

### G. Hiệu năng & độ tin cậy

- [ ] **N+1:** route nào include lồng (agents + tasks + runs) — kiểm query count bằng log Prisma (`log: ["query"]` tạm) — mục tiêu ≤ 4 query/route chính.
- [ ] Payload `/api/agents/run` response + prompt size: snapshot không vượt ~8K token input cho 1 agent (chi phí) — đo tokensIn thực tế trong AgentRun.
- [ ] Tick route 10s: thời gian xử lý < 200ms (dev.log application-code); chỉ update 30 row Quote (không scan).
- [ ] `staleTime` phân tầng đúng như doc §8 (quotes 30s / portfolio 60s / bars 5m) — đọc `providers.tsx` + từng hook.
- [ ] Khôi phục lỗi: dừng market-engine 2 phút → UI vẫn dùng cache + badge stale; bật lại → tự đồng bộ.
- [ ] Restart sạch: `pkill next dev` + xoá `.next` → `bun run dev` → app dậy không lỗi cache cũ (đã từng gặp Task 8).
- [ ] dev.log sau 30 phút chạy: không có dòng error lặp (đặc biệt Module not found từ HMR).

---

### H. Đúng đắn nghiệp vụ tài chính (nghiêm ngặt nhất)

- [ ] Phí môi giới 0.15% × notional (Order.fee & Trade.fee) — so công thức trên 3 lệnh thật trong DB.
- [ ] Thuế TNCN 0.1% chỉ áp lệnh BÁN (Trade.tax) — lệnh MUA tax = 0.
- [ ] Lot chẵn 100 cp mọi nơi sinh lệnh (convert + chu kỳ run).
- [ ] `changePct = change / refPrice × 100` (Q5) — kiểm 5 mã ngẫu nhiên bằng sqlite tay.
- [ ] Dải trần/sàn ±7% (Q2) áp cho mọi giá ghi DB (seed + tick).
- [ ] `equity = cash + Σ(marketValue)` nhất quán giữa /api/portfolio và bảng tính tay.
- [ ] Realized P&L không bị đếm vào unrealized (hai cột tách bạch).
- [ ] Không con số nào hiển thị trên UI mà không có nguồn (DB hoặc công thức từ DB) — nguyên tắc no-fabrication.
- [ ] Mode nguồn hiển thị trung thực (simulated amber / live green / fallback red) — không "làm màu" live.

---

### I. Chất lượng tài liệu & vận hành

- [ ] Doc ↔ code mâu thuẫn còn lại: **Q4 "Quote append-only" vs code `quote.update` tại chỗ** (xác minh Task 17) → quyết định: sửa doc sang "update-in-place tại Quote mới nhất" (thực tế đang làm) hoặc đổi code sang append + prune — khuyến nghị sửa doc + ghi chú retention.
- [ ] README hướng dẫn chạy đúng thứ tự (install → env → db:push → seed → dev → engine).
- [ ] `.env.example` đủ biến mới Giai đoạn 2 (TICK_MS, NEWS_MS, AGENT_CYCLE_MINUTES, MARKET_STRICT_SESSION, LIVE_TRADING, VNDIRECT_*) và KHÔNG chứa giá trị thật.
- [ ] worklog.md Task ID liên tục (9–11 đang thiếu entry — đã ghi nhận Task 16, chấp nhận lịch sử).
- [ ] USER_PROMPTS.md phản ánh đủ prompt đến hiện tại (đã fix Task 16 — verify nhanh).

---

## 4. Rủi ro đã biết từ lịch sử (seed — xác minh lại khi audit)

| # | Vấn đề | Bằng chứng | Cấp |
|---|---|---|---|
| K1 | `POST /api/agents/run` KHÔNG rate-limit → spam chi phí LLM | grep Task 17: không có guard 429/cooldown | **P1** — fix trong PHASE3 §4.3/4.4 |
| K2 | Doc Q4 ghi "Quote append-only" nhưng tick `quote.update` tại chỗ | grep Task 17 | P2 — sửa doc hoặc đổi hành vi |
| K3 | `.env` đang chứa PAT GitHub (GITHUB_PAT) theo yêu cầu người dùng | Task 16 | Chấp nhận có chủ đích — nhắc lại khi kết thúc app |
| K4 | Task ID 9–11 không có entry worklog | Task 16 ghi nhận | P3 |
| K5 | Stale Turbopack cache từng gây crash chuỗi (đã fix Task 8) | worklog | P3 — verify restart sạch |
| K6 | `setState during render` từng xảy ra footer/pulse (đã fix Task 13 bằng defer + useSyncExternalStore) | worklog | P3 — verify console sau 60s |
| K7 | Tick simulator drift về biên (đã fix mean-reversion Task 13) | worklog | P3 — verify sau chạy dài |
| K8 | market-engine single-instance, không supervisor tự khởi động lại | kiến trúc mini-service | P3 — vận hành |

---

## 5. Template báo cáo finding

```markdown
| ID | Vùng | Cấp | Mô tả | Bằng chứng (file:dòng / lệnh / ảnh) | Đề xuất | Trạng thái |
|----|------|-----|-------|--------------------------------------|---------|------------|
| F-01 | B2 /api/agents/run | P1 | Không rate-limit | src/app/api/agents/run/route.ts:1-50 grep "429" rỗng | Guard 60s như PHASE3 §4.3 | Mở |
```

Quy ước trạng thái: `Mở` → `Đang sửa` → `Đã sửa + verify` (kèm bằng chứng curl/browser sau fix) → `Đóng`.

---

## 6. Nghi thức hoàn tất audit

1. Chạy đủ A → I, ghi findings vào bảng template (file này sẽ nâng version 0.2.0 kèm bảng findings đầy đủ).
2. **P0/P1 phải sửa trước khi bắt đầu Giai đoạn 3** (PHASE3_BLUEPRINT §7.1); P2 sửa trong Giai đoạn 3; P3 backlog.
3. Mỗi fix: re-run đúng bước kiểm đã phát hiện lỗi (không chỉ "code nhìn đúng").
4. Cập nhật worklog (Task ID mới) + đồng bộ docs nếu finding đụng hành vi đã ghi tài liệu.
5. Commit + push GitHub bằng credential đã lưu.

---

## 7. Change Log

| Ngày | Thay đổi |
|---|---|
| 2026-10-06 | Tạo v0.1.0 — khung audit 9 vùng (A schema/seed · B API 17 endpoint · C lib 14 file · D frontend/hooks · E realtime/engine · F bảo mật · G hiệu năng · H nghiệp vụ tài chính · I docs/vận hành) + 8 rủi ro đã biết từ lịch sử + template findings + nghi thức hoàn tất. Chờ chạy audit. |
