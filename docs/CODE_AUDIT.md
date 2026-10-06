# The Trader — Kế hoạch rà soát code (Code Audit Checklist)

> **Project:** The Trader — Hệ thống giao dịch đa agent cho VNDIRECT
> **Document:** `docs/CODE_AUDIT.md` · **Version:** 0.3.0 (vòng lặp soát→fix→kiểm chứng→lặp ĐÃ HỘI TỤ — 33/33 findings đóng) · **Created/Executed:** 2026-10-06
> **Cross-refs:** [PHASE3_BLUEPRINT.md](./PHASE3_BLUEPRINT.md) (§7.1: audit chạy TRƯỚC khi triển khai Giai đoạn 3) · [TECHNICAL_BLUEPRINT.md](./TECHNICAL_BLUEPRINT.md) · [DB_SCHEMA.md](./DB_SCHEMA.md) · [DATA_SOURCES.md](./DATA_SOURCES.md)
> **Mục đích:** rà soát **toàn bộ code hiện tại** (v0.3 — sau Giai đoạn 1+2) tìm lỗi, vấn đề, thiếu sót trước khi xây Giai đoạn 3. Mỗi phần dưới đây liệt kê **chi tiết những gì phải kiểm, cách kiểm, tiêu chuẩn đạt**.
> **Kết quả vòng lặp (giao thức người dùng: soát → fix → kiểm chứng → lặp đến khi sạch):**
> - **Vòng 1** (~400 mục, Task 19-a/b/c + fix Task 20/21-a/21-b): 0 P0 · 5 P1 · 6 P2 · ~19 P3 — **sửa + verify hết 30/30**
> - **Vòng 2** (~130 mục vùng A/C/H do 22-a + B/D/E/F/G/I do 22-b): **100% PASS P0/P1/P2** + 3 P3 mới (F-302/303/304) — **sửa + verify 3/3**
> - **Kết luận:** lượt soát cuối **không còn lỗi mới nào** ở mọi cấp — 33/33 findings ĐÓNG — chi tiết §5/§6.

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
| API routes | 18 endpoint (16 file route + `/api/signals/[id]/convert` + `/api/orders/[id]/cancel`) | `src/app/api/**` |
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

### B. API Route Handlers (18 endpoint)

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

## 5. Bảng findings (kết quả audit 2026-10-06 — cập nhật sau vòng lặp 21/22)

**Quy ước trạng thái:** ✅ = Đã sửa + verify lại bằng đúng test phát hiện lỗi · 🔜 = backlog Giai đoạn 3 (PHASE3_BLUEPRINT) · ℹ️ = chấp nhận có chủ đích.

### 5.1 P1 — đã sửa hết (chặn điều kiện triển khai Giai đoạn 3)

| ID | Vùng | Mô tả | Bằng chứng khi phát hiện | Fix + bằng chứng verify | Trạng thái |
|----|------|-------|----------------------------|--------------------------|------------|
| F-101 | A4/H | Seed vi phạm dải ±7% (Q2): 6/30 quote `last` ngoài dải, 7 bar biến động ngày vượt ±7%, 3 `high`>trần, 4 `low`<sàn, 6 `open` ngoài dải — do ép close cuối = def.price không clamp | `prisma/seed.ts:143-149` tái lập từ Bar; sqlite đếm vi phạm | seed.ts clamp toàn bộ OHLC vào dải round100(prev±7%) + `scripts/fix-audit-findings.ts` migrate tại chỗ (7/30 quote + 7/2700 bar) → **verify: 0/2700 bar, 0/30 quote ngoài dải round100** | ✅ |
| F-102 | H5 | Header hiển thị equity snapshot seed 1.2843 tỷ trong khi tổng tài sản thực 1.567 tỷ (lệch 282,7 triệu ≈ 18%); run route sizing 5% NAV cũng dùng số cũ | `header.tsx:154` + `portfolio/route.ts:91` vs `:104` | portfolio route tính lại `equity = cash + GTTH`; run route tính `positionsMv` từ vị thế × giá hiện tại; migration ghi lại DB equity → **verify: account.equity == totals.totalEquity == 1.572.010.000** | ✅ |
| F-201 | B2.7/B2.10 | Order tạo từ API **không tính phí môi giới** — 6/6 lệnh do API tạo fee=0, vi phạm quy tắc 0,15% × notional | DB: lệnh HPG 1600×30.100 fee=0 kỳ vọng 72.240 | Thêm `fee: BigInt(round(0.0015×price×qty))` vào convert + run route → **verify: convert VCB fee 60.840 = chính xác; run VCB fee 112.680 = chính xác** | ✅ |
| F-202 | B2.7 | Convert dùng `targetPrice ?? last` **không clamp dải ±7%** — lệnh thật 30.100 > trần HPG 29.600 | Lệnh cmuwcxkrm… (HPG) ngoài dải | Clamp `price` vào `[floorPrice, ceilingPrice]` + round100 ở cả 2 route → **verify: target 200.000 → lệnh VCB @101.400 (đúng trần); run SELL VCB @93.900 trong dải** | ✅ |
| F-203 (K1) | B2.10 | `POST /api/agents/run` **KHÔNG rate-limit** → spam nút = chi phí LLM không giới hạn | grep 429/cooldown/throttle trong run route = rỗng | Guard 60s in-memory + 429 kèm `retryAfterSeconds` → **verify: chạy chu kỳ 200 (13s, 5 messages, order mới) → gọi lại ngay → 429 + retryAfterSeconds 47** | ✅ |

### 5.2 P2 — TẤT CẢ đã sửa + verify (6/6)

| ID | Vùng | Mô tả | Fix + bằng chứng verify | Trạng thái |
|----|------|-------|--------------------------|------------|
| F-205 | B2.10 | Nhánh 502 (cả 3 analyst lỗi) return sớm → strategist + executor kẹt `RUNNING` vĩnh viễn | `updateMany` reset IDLE trước khi return 502 (code-read verify) | ✅ |
| F-207 | B2.7/seed | Signal có Order FILLED nhưng `actedAt=null` → convert tạo **lệnh trùng**; guard chỉ check actedAt | Route: guard thêm "đã có Order theo signalId → 409"; migration set actedAt cho 2 tín hiệu → **verify: convert lần 2 → 409** | ✅ |
| F-204 (K2) | A/I | Doc Q4 ghi "Quote append-only" nhưng tick `update` tại chỗ (30 row cố định) | Đã sửa DATA_SOURCES.md Q4 → "update-in-place + retention roadmap"; DB_SCHEMA §4.3 làm rõ tương ứng | ✅ (doc) |
| F-206 | F8 | AuditLog thiếu 3/11 action doc hóa (ORDER_FILLED, ORDER_CANCELLED, RISK_ALERT_RAISED không có code path runtime) | **Đóng 100% trong vòng lặp:** RISK_ALERT_RAISED (flows + sources) · ORDER_FILLED (fill engine trong tick — verify 10/10 lệnh khớp, fee/tax đúng từng đồng) · ORDER_CANCELLED (POST /api/orders/[id]/cancel — verify 200/409/404 + nút Hủy UI E2E) · thêm ORDER_REJECTED (F-303) → **12/12 action runtime** | ✅ |
| F-103 | C8/H | Simulator **không EOD rollover**: volume lũy kế không reset, totalValue 391.188 tỷ (phiên thực ~20 nghìn tỷ) | Task 21-a: EOD rollover trong tick (ghi Bar OHLCV phiên cũ chỉ ngày giao dịch + refPrice/dải mới + volume reset + **ngân sách ngày 0,3–9,2tr cp FNV-1a theo (mã, ngày)**) + migration `scripts/fix-eod-reset.ts` — verify: SHB rollover volume 307tr→412, bands/Q5 đúng; tổng giá trị phiên 391.188 tỷ → ramp ngân sách thực tế; 30/30 quote volume ∈ [0, 9,2tr] | ✅ |
| F-105/F-106 | H5/A/I | `BrokerAccount.equity` policy mập mờ (snapshot seed tự mâu thuẫn định nghĩa doc); DATA_SOURCES §3.1 ghi "ép đúng giá tham chiếu" không đúng thực tế | equity = cash + GTTH chốt khi khớp lệnh (fill engine) + khi sang phiên mới (EOD rollover); `/api/portfolio` luôn tính live — verify: replay khớp EXACT + DB equity vs live drift 0,27% (snapshot semantics); doc §3.1 + DB_SCHEMA §6.2 ghi rõ chính sách | ✅ |

### 5.3 P3 — TẤT CẢ đã sửa + verify (19/19 vòng 1)

| ID | Mô tả | Fix (vòng lặp 21-a/21-b) | Trạng thái |
|----|-------|--------------------------|------------|
| F-107 | news 429 hardcode mode "live" | Guard đọc mode thật từ DataSourceStatus — verify runtime mode động | ✅ |
| F-108 | Atom feed không parse được link | atomParser riêng giữ attribute `href` + linkHref/firstLink đủ nhánh — 14/14 test thuần | ✅ |
| F-109/F-212 | flows scale cố định 3% ≠ doc 0,5–6%; ranh giới ngày UTC | pct = 0,005 + unit×0,055 theo thanh khoản + dateIso = vnDateIso (ICT) — 11/11 test | ✅ |
| F-110 | Lịch Giỗ Tổ 2026 sai ngày (10/04 thay vì 26/04 CN) | 2026-04-10 → 2026-04-27 (nghỉ bù thứ Hai) — 21/21 mốc test | ✅ |
| F-111 | sessionPhase biên theo phút (không tới giây) | biên theo GIÂY (09:15:00/11:30:00/13:00:00/14:45:00/15:00:00) — 10 mốc biên đúng | ✅ |
| F-112 | format.ts isMarketOpen bỏ qua lịch lễ | delegate isTradingSession (market-session pure) — 10/10 test kể lễ 27/04 | ✅ |
| F-113 | P50 health tự tham chiếu run vừa tạo | excludeRunId (health.ts + call-site truyền run.id) | ✅ |
| F-114 | toPlain không guard circular/Map-Set | WeakSet guard + Map→object/Set→array — 13/13 test | ✅ |
| F-115 | seed chỉ deterministic cùng ngày | Doc DATA_SOURCES §3 ghi rõ phạm vi deterministic theo ngày chạy (chủ đích giữ dữ liệu "tươi") | ✅ (doc) |
| F-116 | AgentMessage feed cần index createdAt | `@@index([createdAt])` + db:push — EXPLAIN QUERY PLAN dùng index (22-a verify) | ✅ |
| F-117 | meta.mode hardcode "simulated"; ternary chết seed | meta.mode từ DataSourceStatus + dọn ternary seed — verify runtime | ✅ |
| F-118 | rsi chuỗi phẳng trả 100 | flat → null (Wilder giữ 100/0 cho tăng/giảm thuần) — 13/13 test | ✅ |
| F-119 | escalate dedupe global theo code (không theo nguồn) | dedupe theo (code + metricKey source.xxx) — từng nguồn có alert riêng | ✅ |
| F-208 | bars cap 250 ≠ doc 90 | đã sửa từ Task 20 (verify lại vòng 2: days=999 → 90) | ✅ |
| F-209 | Quote high/low seed ngoài dải | đã clamp từ migration Task 20 (22-a verify lại 0 vi phạm) | ✅ |
| F-210 | 429 thiếu header Retry-After | news + run route đều có Retry-After (verify runtime: header `retry-after: 4`) | ✅ |
| F-211 | flows asOf wall-clock (không deterministic tuyệt đối) | asOf = 15:00 ICT của ngày tính — verify 2 lần gọi IDENTICAL | ✅ |
| F-301 | Ô tìm kiếm bảng giá thiếu aria-label | aria-label đầy đủ (21-b) | ✅ |

### 5.3b P3 vòng 2 (22-a phát hiện) — đã sửa + verify (3/3)

| ID | Vùng | Mô tả | Fix + bằng chứng verify | Trạng thái |
|----|------|-------|--------------------------|------------|
| F-302 | H | Audit ORDER_FILLED `before.status` hardcode "PENDING" — sai sự thật khi lệnh là PARTIALLY_FILLED | FillSnapshot thêm `status`; before ghi trạng thái thật — verify: lệnh PARTIALLY 100/400 khớp nốt → before=`{"status":"PARTIALLY_FILLED"}` | ✅ |
| F-303 | B/H | Run route tạo SELL không kiểm vị thế → fill engine throw + **retry mỗi tick vĩnh viễn** (VIB 3100 cp không vị thế) | Fill engine pre-check trong tx: SELL không đủ cp → tự REJECTED đúng 1 lần + ORDER_REJECTED audit (reason INSUFFICIENT_POSITION) — verify: VIB → REJECTED 1 lần; lệnh chưa vượt điều kiện giá nằm chờ hợp lệ, không spam log | ✅ |
| F-304 | I | DB_SCHEMA §10 Change Log thiếu dòng v0.3 | Đã thêm dòng thay đổi v0.3 (Task 21/22) | ✅ |

### 5.4 K-items §4 — trạng thái sau vòng lặp

| # | Vấn đề | Kết quả |
|---|--------|--------|
| K1 | run route không rate-limit | **→ F-203: ĐÃ SỬA + verify ✅** (60s + 429 + Retry-After header — F-210) |
| K2 | doc Quote append-only vs update | **→ F-204: ĐÃ SỬA doc ✅** (DATA_SOURCES Q4 + DB_SCHEMA §4.3) |
| K3 | .env chứa PAT theo yêu cầu người dùng | ℹ️ chấp nhận có chủ đích (sẽ thu hồi khi kết thúc app) |
| K4 | worklog thiếu Task 9–11 | ℹ️ đã ghi nhận Task 16 (chấp nhận lịch sử) |
| K5 | stale cache từng crash | ✅ verify restart sạch (dev.log 0 lỗi sau audit vòng 1 + vòng 2; engine restart giữa session không để lại lỗi) |
| K6 | setState-during-render footer | ✅ console 0 error/warning desktop + mobile (verify lại vòng 2) |
| K7 | tick drift biên | ✅ mean-reversion + 0 quote ngoài dải (22-a verify lại sau EOD reset) |
| K8 | engine single-instance | ℹ️ vận hành — chấp nhận (đã verify đúng 1 tiến trình + restart sạch) |

### 5.5 Template báo cáo finding (giữ làm quy ước)

```markdown
| ID | Vùng | Cấp | Mô tả | Bằng chứng (file:dòng / lệnh / ảnh) | Đề xuất | Trạng thái |
|----|------|-----|-------|--------------------------------------|---------|------------|
```

Quy ước trạng thái: `Mở` → `Đang sửa` → `Đã sửa + verify` (kèm bằng chứng curl/browser sau fix) → `Đóng`.

---

## 6. Nghi thức hoàn tất audit — VÒNG LẶP ĐÃ HỘI TỤ (2026-10-06)

Giao thức người dùng: *"Rà soát lỗi → Fix lỗi nếu có → Kiểm chứng → Xác định còn lỗi thì fix tiếp đến khi lặp lại bước soát lỗi mà không còn lỗi nào nữa thì dừng lại báo cáo và push code."*

1. ~~Chạy đủ A → I, ghi findings~~ — **Vòng 1 ĐÃ CHẠY** (19-a/19-b/19-c): ~400 mục → 30 findings (0 P0 · 5 P1 · 6 P2 · 19 P3).
2. ~~P0/P1 phải sửa trước khi bắt đầu Giai đoạn 3~~ — ✅ 5 P1 sửa + verify (Task 20).
3. **Vòng 1 fix mở rộng (Task 21-a/21-b):** sửa nốt toàn bộ P2 + P3 (kể cả F-103 EOD rollover + F-206 fill engine được lên sớm khỏi backlog Giai đoạn 3) + verify từng fix bằng đúng test phát hiện lỗi (curl / sqlite-replay / browser / test thuần 48/48).
4. **Vòng 2 — soát lại TỪ ĐẦU (Task 22-a vùng A/C/H ~130 mục + 22-b vùng B/D/E/F/G/I):** 100% PASS P0/P1/P2; phát hiện 3 P3 mới (F-302/303/304) → **fix ngay + verify lại từng fix**.
5. **Lượt soát cuối:** static (tsc 0 lỗi src/, lint EXIT 0) + 18 endpoint curl + edge cases + browser E2E desktop/mobile (console 0 lỗi, golden path 5/5 agent COMPLETED, nút Hủy E2E, VLM 2 cảnh báo đều chứng minh false positive bằng đo DOM) + engine health + secret sweep + tick latency 47ms — **KHÔNG CÒN LỖI MỚI NÀO** → dừng vòng lặp theo giao thức.
6. Cập nhật CODE_AUDIT v0.3.0 + worklog (Task 21-a/21-b/22-a/22-b) + docs đồng bộ (DB_SCHEMA v0.3, TECHNICAL_BLUEPRINT, DATA_SOURCES, README) + commit & push GitHub.

**KẾT LUẬN CHỐT: 33/33 findings ĐÓNG (5 P1 + 6 P2 + 19 P3 vòng 1 + 3 P3 vòng 2). Còn lại đúng 4 mục ℹ️ chấp nhận có chủ đích: K3 (PAT theo yêu cầu người dùng — tự thu hồi khi kết thúc app) · K4 (worklog lịch sử Task 9–11) · K8 (engine single-instance) · SIGNAL_REJECTED (thuộc phạm vi Giai đoạn 3 theo PHASE3_BLUEPRINT — không phải lỗi của giai đoạn hiện tại). Hệ thống đủ điều kiện triển khai Giai đoạn 3.**

---

## 7. Change Log

| Ngày | Thay đổi |
|---|---|
| 2026-10-06 | Tạo v0.1.0 — khung audit 9 vùng (A schema/seed · B API 17 endpoint · C lib 14 file · D frontend/hooks · E realtime/engine · F bảo mật · G hiệu năng · H nghiệp vụ tài chính · I docs/vận hành) + 8 rủi ro đã biết từ lịch sử + template findings + nghi thức hoàn tất. Chờ chạy audit. |
| 2026-10-06 | **v0.2.0 — ĐÃ CHẠY AUDIT:** ~400 mục kiểm (19-a: A+C+H ~130 · 19-b: B+F ~135 · 19-c: D+E+G + tsc/lint sạch). Kết quả: **0 P0 · 5 P1 · 6 P2 · ~19 P3**. Toàn bộ 5 P1 đã sửa + verify (F-101 seed dải ±7% + migration tại chỗ 7 quote/7 bar; F-102 equity tính lại khớp tổng 1.572 tỷ; F-201 fee 0,15% — verify 2 lệnh 60.840/112.680 chính xác; F-202 clamp giá — target 200.000→101.400 trần VCB; F-203 rate-limit 60s — 429 + retryAfterSeconds 47). P2 sửa ngay: F-205 reset RUNNING nhánh 502 · F-207 guard lệnh trùng (verify 409) · F-204 sửa doc Q4 · F-206 thêm RISK_ALERT_RAISED runtime. Còn lại backlog Giai đoạn 3 (F-103 EOD rollover quan trọng nhất). Bảo mật sạch 100%. |
| 2026-10-06 | **v0.3.0 — VÒNG LẶP HỘI TỤ:** theo giao thức người dùng "soát→fix→kiểm chứng→lặp đến khi sạch". Task 21-a: EOD rollover + ngân sách khối lượng ngày (đóng F-103/F-105 — tổng giá trị phiên 391.188 tỷ → ramp ngân sách thực tế 0,3–9,2tr cp/mã/ngày) + **paper matching engine** (đóng F-206 100%: khớp lệnh tự động trong tick + POST /api/orders/[id]/cancel + nút Hủy UI + 12/12 action audit runtime) + index AgentMessage (F-116) + meta.mode động (F-117) + lịch lễ/biên-giây phiên (F-110/111) + migration fix-eod-reset. Task 21-b: 10 fix lib thuần (F-107/108/109/112/113/114/118/119/210/211/212/301) — 48/48 test thuần PASS. Task 22-a (soát lại A/C/H từ đầu): ~130 mục **100% PASS P0-P2**, fill engine chứng minh đúng tiền tuyệt đối (cash replay 0 ₫ lệch từ AuditLog: 486.500.000 + ΣΔ = 475.411.270; 4/4 vị thế replay khớp qty/avg/realized) + 3 P3 mới. Task 22-b: fix F-302/303/304 + verify + vùng B/D/E/F/G/I sạch (18 endpoint + edge 404/409/429, browser E2E desktop/mobile console 0 lỗi + golden path 5/5 agent COMPLETED + nút Hủy E2E, VLM 2 cảnh báo = false positive chứng minh bằng đo DOM, secret sweep sạch, tick 47ms). **33/33 findings đóng — lượt soát cuối không còn lỗi mới — ĐỦ ĐIỀU KIỆN TRIỂN KHAI GIAI ĐOẠN 3.** |
