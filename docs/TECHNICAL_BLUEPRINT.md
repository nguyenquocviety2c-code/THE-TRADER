# The Trader — Technical Blueprint

> **Project:** The Trader — Hệ thống giao dịch đa agent (Multi-Agent Trading System) cho VNDIRECT
> **Document:** `docs/TECHNICAL_BLUEPRINT.md` · **Version:** 0.8.0 · **Updated:** 2026-10-06
> **Cross-refs:** [DB_SCHEMA.md](./DB_SCHEMA.md) (data dictionary) · [DATA_SOURCES.md](./DATA_SOURCES.md) (nguồn dữ liệu & mapping)

---

## 1. System Overview

The Trader là một **trading workspace một trang** (single-page dashboard): trader quan sát thị trường VN30 realtime trên nền **lịch sử giá EOD THẬT** (90.785 bar 2013→nay từ VNDIRECT dchart — [DATA_SOURCES.md §3.3](./DATA_SOURCES.md)), đọc tin tức RSS thật, theo dõi danh mục VNDIRECT mô phỏng (đã rebase theo giá thật), và điều phối một **đội 23 AI agent chia 5 nhóm** (Nghiên cứu · Kiểm soát VETO · Điều hành · Nền tảng dữ liệu · Học máy — §5.1) phân tích — tổng hợp bằng **Bộ tổng hợp Bayes nhân quả (Đợt D — §5.3, phiên #34)** — ra tín hiệu — thực thi lệnh giấy (paper trading). Triết lý thiết kế:

1. **Paper-trading first** — toàn bộ luồng lệnh chạy nội bộ, không chạm tiền thật; live trading VNDIRECT chỉ bật sau feature flag (§9) — hiện đã có scaffold flag + cổng kiểm tra (S3, gateway thật còn pending).
2. **Mọi phân tích AI đều có audit trail** — mỗi lần chạy agent ghi `AgentRun` (token, chi phí, thời lượng) và mọi kết luận broadcast ghi `AgentMessage` (xem [DB_SCHEMA.md §6.6–6.9](./DB_SCHEMA.md)).
3. **Backend-only LLM qua lớp provider duy nhất** — `src/lib/llm.ts` chọn provider theo env (`LLM_PROVIDER=auto`): có `OPENCODE_ZEN_API_KEY` → **Opencode Zen** `space-bunny-free` (**Space Bunny Free** — free-tier $0, OpenAI-compatible REST, chạy được cả ngoài sandbox — môi trường local của trader; đây là backbone **mặc định cho toàn đội 23 agent**); không key → `z-ai-web-dev-sdk` GLM-4.6 (gateway nội bộ sandbox Z.ai). Model họ space-bunny là model reasoning nên mặc định gửi `reasoning_effort: low` (đo thực tế ~3.7s/call thay vì ~19s). Client không bao giờ thấy API key.
4. **Financial-grade conventions** — tiền VND integer, phí 0.15%, thuế TNCN 0.1% khi bán, dải trần/sàn ±7% HOSE ([DB_SCHEMA.md §8](./DB_SCHEMA.md)).
5. **Minh bạch nguồn dữ liệu** — mọi nguồn được gắn nhãn `live`/`real`/`simulated`/`fallback`/`paper` trong `DataSourceStatus` và hiển thị trên footer (nguồn `eod-history` mode `real` — dot xanh "EOD thật"); dữ liệu mô phỏng không bao giờ giả danh "live" (stale marking — [DATA_SOURCES.md §6](./DATA_SOURCES.md)).
6. **Realtime-first (tuỳ chọn)** — mini-service `market-engine` broadcast tick bảng giá, tin tức mới, kết quả EOD sync và kết quả chu kỳ agent qua WebSocket (§6); TanStack Query vẫn là cache layer duy nhất.
7. **Dữ liệu thật trước tiên (phiên #33)** — bar EOD THẬT VNDIRECT dchart (90.785 bar 2013→nay) làm nền cho mọi chỉ báo/prompt/backtest; những gì chưa có nguồn thật (intraday tick, dòng khối ngoại) được **mô phỏng quanh mức thật + gắn nhãn `simulated` minh bạch** — không bao giờ giả danh "live"; ngoài phiên bảng giá neo ở close thật (mode `real`).
8. **Tổng hợp định lượng deterministic (phiên #34)** — kết luận của đội agent không dừng ở văn bản LLM: **Bộ tổng hợp Bayes** (Đợt D của chu kỳ — §5.3) chạy log-odds naive Bayes 4 bậc nhân quả trên dữ liệu thật trong DB + assessment JSON có cấu trúc của 5 agent LLM — **0 LLM, $0**, kèm sensitivity (drivers) · disagreement · narrative tiếng Việt; VETO Ủy ban Kiểm soát vẫn là ràng buộc cứng.

### Tech Stack (thực tế trong `package.json` / `bun.lock`)

| Layer | Công nghệ | Phiên bản |
|---|---|---|
| Framework | Next.js (App Router, RSC) | 16.3.8 |
| UI runtime | React / React DOM | 19.2.8 |
| Ngôn ngữ | TypeScript | 5.9.3 |
| Styling | Tailwind CSS + `tw-animate-css` | 4.3.3 |
| Components | shadcn/ui (style **new-york**, theme **neutral**, primitives Radix) + `lucide-react` icons | — |
| ORM / DB | Prisma + `@prisma/client` → **Supabase Postgres** (schema `trader`, Supavisor session pooler `:5432` qua `DATABASE_URL`) — kho dữ liệu chính bền vững qua reset sandbox | 6.19.3 |
| Server state | TanStack Query | 5.104.1 |
| Local state | Zustand | 5.0.15 |
| Theming | `next-themes` (dark default) | 0.4.6 |
| Charts | Recharts | 3.10.1 |
| Toasts | Sonner | 2.0.8 |
| Date utils | date-fns | 4.4.0 |
| AI | `src/lib/llm.ts` — provider abstraction: **Opencode Zen** `space-bunny-free` (Space Bunny Free — free-tier $0, key `OPENCODE_ZEN_API_KEY`, `reasoning_effort: low` ≈ 3.7s/call) hoặc `z-ai-web-dev-sdk` GLM-4.6 (sandbox) — backend-only, mặc định cho 6 agent LLM của đội 23 | 0.0.18 |
| Quant & Bayes | `src/lib/quant` (OLS linreg · percentile NIST · entropy · Holt double exponential + CI80 · lexicon NLP tiếng Việt ~75 thuật ngữ · regime) + `src/lib/bayes` (log-odds 4 bậc nhân quả — §5.3) — thuần TypeScript, deterministic 0 LLM | — |
| Realtime client | `socket.io-client` (nối mini-service market-engine, §6) | 4.8.4 |
| RSS parser | `fast-xml-parser` (crawler tin tức S5) | 5.11.2 |
| Runtime | Bun | 1.3.14 |

---

## 2. Architecture

```mermaid
flowchart TB
    subgraph Browser["Trình duyệt (Trader)"]
        RSC["Next.js App Router — RSC shell"]
        DASH["Client Dashboard (React 19)\nWatchlist · Charts · News · Portfolio · Agents · Signals · Risk"]
        TQ["TanStack Query cache\n(server state)"]
        ZU["Zustand store\n(local UI state + realtime slice)"]
        WS["socket.io-client\nio('/?XTransformPort=3003')"]
    end

    subgraph Server["Next.js Server (Route Handlers — API-only backend)"]
        API["/api/market/* · /api/news · /api/system/status\n/api/portfolio · /api/agents/* · /api/signals\n/api/assessment · /api/settings\n/api/risk/alerts · /api/watchlist/toggle"]
        RUN["POST /api/agents/run\nChu kỳ 23 agents — 6 đợt A→F\n(6 LLM + 17 deterministic + Đợt D Bayes)\nprompt kèm newsBlock + flowsBlock + Bayes block"]
        TICK["POST /api/market/tick\nS4 tick engine: random-walk quanh ref THẬT\n+ mean-reversion 3% (Q1–Q5) — mutex in-process\nmode realtime-vndirect → giá cuối THẬT finfo\n(throttle ≥30s; lỗi → fallback real-eod an toàn)"]
        EOD["POST /api/market/eod-sync\nS7 — EOD THẬT VNDIRECT dchart\n90.785 bar 2013→nay (đã adjust)\nvalidate §5 + neo Quote vào close thật"]
        NEWS["POST /api/news\nS5 crawler RSS (fast-xml-parser)\ndedupe theo url, rate-limit 60s"]
        FLOWS["GET /api/market/flows\nS6 dòng khối ngoại\n(simulated deterministic)"]
        BAYES["src/lib/bayes — Đợt D: Bộ tổng hợp Bayes\nlog-odds 4 bậc nhân quả — 0 LLM\npersist MarketAssessment (cycle/manual)"]
        SETT["GET/PUT /api/settings · POST /api/settings/test\nAppSetting: mode dữ liệu runtime +\nVNDIRECT creds (masked 4 đầu + ····)"]
        SDK["src/lib/llm.ts — provider:\nSpace Bunny Free — Opencode Zen (có key, free-tier $0)\nz-ai glm-4.6 (sandbox)"]
        PRISMA["Prisma Client\n(src/lib/db.ts singleton)"]
    end

    subgraph Engine["mini-service market-engine — port 3003 (LIVE)"]
        SCHED["Scheduler\nTICK_MS 10s · NEWS_MS 15'\nEOD_SYNC_AT 15:45 ICT hằng ngày + boot\nAGENT_CYCLE_MINUTES (0 = TẮT)"]
        IOSRV["socket.io server — broadcast:\nquotes · news · eod · cycle · welcome"]
    end

    RSS[("5 feed RSS VN (S5 — live)\nVnEconomy · CafeF · VNExpress\nTuổi Trẻ · VietnamNet")]

    DCHART[("VNDIRECT dchart-api (S7 — public EOD)\n90.785 bar OHLCV đã adjust 2013→nay")]

    FINFO[("VNDIRECT finfo realtime + OAuth2 customer (S8)\nchờ egress — probe sandbox: DNS private 10.210.100.8")]

    DB[("Supabase Postgres — schema trader\nPrisma 6.19.3 (21 models — mới phiên #34:\nAppSetting · MarketAssessment)\nđám mây — sống qua reset sandbox")]

    subgraph Future["Lộ trình (planned)"]
        GW["VNDIRECT Gateway mini-service\nOrder placement · Account balance\n(behind LIVE_TRADING flag)"]
    end

    RSC --> DASH
    DASH --> TQ
    DASH --> ZU
    WS -- "WebSocket qua gateway (query XTransformPort=3003)" --> IOSRV
    TQ -- "fetch('/api/...') — relative path" --> API
    API --> PRISMA
    PRISMA --> DB
    SCHED -- "server-to-server POST (APP_URL)" --> TICK
    SCHED -- "POST /api/news" --> NEWS
    SCHED -- "POST /api/agents/run" --> RUN
    SCHED -- "POST /api/market/eod-sync (15:45 ICT + boot)" --> EOD
    EOD -- "fetch HTTPS (throttle 300ms, retry backoff)" --> DCHART
    EOD --> PRISMA
    IOSRV -- "broadcast quotes / news / eod / cycle" --> WS
    NEWS -- "fetch RSS (timeout 8s, UA TheTraderBot/1.0)" --> RSS
    RUN --> SDK
    SDK -- "HTTPS" --> LLM["Opencode Zen — space-bunny-free\n(fallback: Z.ai GLM-4.6)"]
    RUN --> BAYES
    BAYES --> PRISMA
    RUN --> PRISMA
    TICK --> PRISMA
    TICK -. "mode realtime-vndirect: giá cuối thật finfo (throttle ≥30s)" .-> FINFO
    FLOWS --> PRISMA
    GW -. planned .-> API
```

**Luồng dữ liệu:** Supabase Postgres (schema `trader`) → Route Handlers (JSON, `BigInt` → `Number`) → TanStack Query cache → React components; ngoài luồng pull này còn **luồng push** từ mini-service `market-engine` qua WebSocket ghi thẳng vào cache (§6). Mutations hiện tại: `POST /api/agents/run` (kích hoạt **chu kỳ 23 agents chạy 6 đợt A→F** — phiên #34 thêm **Đợt D Bộ tổng hợp Bayes nhân quả** giữa Control và Chủ tịch: 6 lượt LLM + 17 agent dịch vụ deterministic + 1 engine Bayes 0 LLM, sinh `AgentMessage`/`Signal` giấy/`MarketAssessment`), `POST /api/market/tick` (tick giá S4 quanh ref thật + khớp lệnh giấy + EOD rollover; **mode runtime `realtime-vndirect`** → giá cuối thật finfo — §6.5), `POST /api/market/eod-sync` (đồng bộ **bar EOD THẬT VNDIRECT dchart** + neo Quote), `POST /api/news` (crawler RSS S5), `POST /api/assessment/synthesize` (tổng hợp lại nhận định Bayes — 0 LLM, cooldown 10s), `PUT /api/settings` + `POST /api/settings/test` (module Cài đặt — cấu hình VNDIRECT + mode dữ liệu runtime), `POST /api/signals/[id]/convert`, `POST /api/watchlist/toggle`, `POST /api/orders/[id]/cancel` (hủy lệnh chờ khớp). Không dùng Server Actions — mọi đọc/ghi server đều qua Route Handler để tập trung validation + audit (§7).

---

## 3. Frontend Architecture

**Một trang duy nhất tại `/`** (App Router: RSC shell render layout, phần tương tác là client components). Từ phiên #34 trang này là **App Shell với 7 workspace** chuyển bằng Zustand (`activeWorkspace: "overview" | "market" | "portfolio" | "signals" | "agents" | "synthesis" | "settings"`, deep-link `?ws=` đọc 1 lần khi mount + validate) — KHÔNG thêm route; realtime socket sống ở cấp trang nên đổi workspace không đứt kết nối. Nav dạng `role="tablist"` 7 tab nằm dưới thanh logo trong Header (mobile: hàng cuộn ngang `overflow-x-auto` + snap-x + ẩn scrollbar, mọi tab flex-none ≥44px; phím mũi tên modulo 7; badge chấm live khi engine nối).

**Workspace "Tổng quan" (viết lại gọn từ phiên #34 — chỉ còn 4 khối):**

| Section | Nội dung | Nguồn dữ liệu |
|---|---|---|
| **Market summary** | VN-Index proxy (trung bình biến động VN30), số mã tăng/giảm/đứng giá, thanh khoản, top movers + **Market pulse bar**: dòng khối ngoại ròng (S6) · tin tức mới nhất (S5) · tuổi tick realtime | `GET /api/market/quotes` (trường `summary` nhúng), `GET /api/market/flows`, `GET /api/news`, Zustand `lastTickAt` |
| **AssessmentBrief** | Card nhận định **Bộ tổng hợp Bayes** rút gọn (§5.3): badge hướng (TĂNG/GIẢM/ĐI NGANG) + stacked bar 3 xác suất + 3 stat (độ tin cậy · bất đồng · số bằng chứng) + caption nguồn + link "Xem chi tiết" → workspace Tổng hợp; empty state "chưa chạy" + nút chạy chu kỳ; error state + Thử lại | `GET /api/assessment` |
| **Signals (compact)** | Feed tín hiệu gọn (`compact` + `limit=5`: badge + mã + điểm + rationale truncate + "Đã chuyển lệnh"), footer "Xem tất cả (N) →" sang workspace Tín hiệu | `GET /api/signals` |
| **AgentSystemBrief** | 23 agents 5 nhóm, mỗi nhóm 1 hàng (badge số lượng + chấm tổng ERROR/RUNNING/IDLE) + hàng cuối nút "Chạy chu kỳ 23 agents" (`useRunAgents`) + link "Xem đội agent →" + model LLM đang chạy | `GET /api/agents` |

Header (đồng hồ phiên ATO/liên tục/ATC · badge Live · chip tài khoản mask · chip Sức mua ước tính G3 §5.4 · nút Chạy agent) và sticky footer (chips trạng thái nguồn · chip chi phí AI G3 §5.5) là chrome dùng chung ở cấp trang. **6 workspace còn lại (phiên #34):**

- **Thị trường** — MarketSummary + QuotesTable (watchlist VN30 ⇄ danh mục theo dõi, tìm kiếm, cột sao, toggle cột mở rộng G3 §5.2 với dấu ⌃/⌄ trần/sàn) + PriceChart (**Nến Nhật** custom Bar shape wick+thân + volume histogram màu phiên + **panel RSI14 Wilder** ~96px guideline 30/70 + toggle Nến/Đường + SMA20 + range 30/60/90 + symbol picker) + NewsCard (12 tin + badge chế độ nguồn + nút Nạp tin) — header nhỏ "Bảng giá & biểu đồ VN30 — dữ liệu EOD thật VNDIRECT".
- **Danh mục** — PortfolioSection (tabs **Vị thế** P&L runtime + **cột % tỷ trọng** G3 §5.3 · **Lệnh** nút Hủy · **Giao dịch** + donut phân bổ ngành ≥ md + ô ghép Biến động ngày / Realized P&L).
- **Tín hiệu** — "vận hành tín hiệu": SignalsFeed đầy đủ (bảng Signal direction/confidence/score/target/SL/TP/rationale/expiresAt + trạng thái ACTIVE/ACTED/REJECTED/EXPIRED + nút Chuyển lệnh) + cột phải RiskAlerts (thẻ cảnh báo theo severity) + **AgentsPanel compact** (feed broadcast + nút ✅ Phê duyệt/⛔ Từ chối tín hiệu ACTIVE + AgentTask list; lưới 23 thẻ agent rút thành nút "Xem hồ sơ chi tiết 23 agents" → tab Đội Agent).
- **Đội Agent** — giữ nguyên cấu trúc Giai đoạn 3 (bảng dưới).
- **Tổng hợp (Bộ tổng hợp Bayes — §5.3)** — header card nhận định (badge hướng lớn TĂNG/GIẢM/ĐI NGANG + stacked probability bar 3 màu pUp/pFlat/pDown + 3 stat Độ tin cậy · Bất đồng · Số bằng chứng + caption nguồn "chu kỳ 23 agents" / "Tổng hợp lại thủ công") + narrative tiếng Việt italic + **banner VETO** destructive khi Ủy ban Kiểm soát PHỦ QUYẾT (kèm reason) + 3 card bậc nhân quả (Bậc 0 tiên nghiệm · Bậc 1 thị trường: breadth + regime + newsSentiment + netForeignFlow + forecast5d kèm CI · Bậc 2 nhóm ngành) + bảng Bậc 3 cổ phiếu (Mã · P(tăng)/P(giảm) · stance BUY/SELL/HOLD · z · RSI14 amber khi <30/>70 · momentum · dự báo 5p · 2 drivers) + bảng bằng chứng (agent · gen1 · cấp thị trường/cổ phiếu · hướng · trọng số · LR × · Δlog-odds signed màu + mini bar) + lịch sử (LineChart mini pUp% domain 0–100 + list 5 bản mới nhất); 2 nút header: **"Tổng hợp lại ngay"** (POST synthesize — 0 LLM, cooldown 10s) + **"Chạy chu kỳ đầy đủ"**.
- **Cài đặt** — 3 card: (1) **Kết nối VNDIRECT** — 4 input (consumer key/secret/access token có nút mắt hiện/ẩn + số tài khoản; placeholder "Đã lưu: <masked>") + nút Kiểm tra kết nối (probe thật — inline authOk/finfoOk/latency/sampleQuote) + Lưu cấu hình + Xoá cấu hình + dòng "Lần kiểm tra gần nhất" từ server; (2) **Nguồn dữ liệu thị trường** — radiogroup 3 mode theo WAI-ARIA (`real-eod` / `realtime-vndirect` / `simulated`; badge "Mặc định" · "Chưa kết nối" · "Fallback: EOD thật") + nút Áp dụng + footer strictSession (Phiên HOSE 09:15–15:00) + đồng bộ EOD 15:45 ICT + realtimeOk/lastRealtimeAt; (3) **Mô hình AI & đội agent** (read-only: model label + badge "Miễn phí" + "23 agents · 5 nhóm · chu kỳ 6 đợt" + 3 risk limit + thời điểm assessment cuối).

**Workspace "Đội Agent" (G3 §4.7):** header tổng quan đội (số agent · chi phí AI lũy kế · nút **Chạy chu kỳ đầy đủ (23 agents)**) + layout 2 cột xl: trái = **23 roster card chia 5 nhóm** theo `group` (research · control · executive · platform · ml — header nhóm sticky + cuộn dọc riêng ở desktop; nhóm control mang **badge VETO** amber; icon vai riêng từng role, health bar, status dot, stats mini, nút ▶ **Chạy riêng** — disabled kèm đếm ngược 429) · phải = **panel chi tiết** 5 tab (Hồ sơ / Hoạt động — bảng AgentRun + sparkline chi phí 7 ngày / Nhiệm vụ / Phát thanh + tín hiệu đang mở kèm nút duyệt-từ chối / **Chat** — thread USER↔AGENT, cảnh báo "~$0.006/tin", rate-limit 60s/agent hiển thị đếm ngược). Execution Manager không chat/chạy lẻ (409/400 + Card giải thích).

### State management

- **TanStack Query — server state:** query keys chuẩn `[resource, params]` (VD `['quotes']`, `['watchlist']`, `['bars', symbol, days]`, `['agents']`, `['news']`, `['system-status']`, `['assessment']`, `['settings']`); `staleTime` phân tầng: quote/watchlist 30s, agent messages/news/assessment/settings 30s, portfolio/orders/signals/risk/system-status 30–60s, bars 5 phút; sau `POST /api/agents/run` thành công thì `invalidateQueries` toàn bộ key `['agents']`/`['agent-messages']`/`['signals']`/`['orders']`/`['portfolio']`/`['quotes']`/`['risk-alerts']`/`['assessment']` (chu kỳ giờ chạy Đợt D Bayes giữa Control & Chủ tịch) để phản ánh kết quả chu kỳ mới (gộp trong hook dùng chung `useRunAgents`).
- **Zustand — local UI state** (`src/lib/store.ts`): `selectedSymbol`, `chartDays`, `portfolioTab`, `watchlistOnly`, **`activeWorkspace` (G3 B1 — mở rộng 7 giá trị từ phiên #34)**, **`chartMode` (G3 B3)**, **`quotesExpanded` (G3 B3)** + **slice realtime**: `realtimeConnected` (đèn Live/badge Realtime) và `lastTickAt` (tuổi tick cho Market pulse bar) — cập nhật từ hook `useRealtimeMarket` (§6). Không chứa dữ liệu server (tránh dual source of truth).

### Theming & design tokens

- `next-themes` với **dark mặc định** (`class` strategy), bảng màu **neutral oklch** của shadcn/ui new-york.
- **Màu semantic lên/xuống theo quy ước thị trường Việt Nam:** xanh = tăng, đỏ = giảm (ngược với quy ước Mỹ) — token `up`/`down` dùng xuyên suốt watchlist, chart, signals, PnL.
- **`tabular-nums`** cho mọi cột số — chữ số thẳng cột, bắt buộc với bảng tài chính; dấu phân cách hàng nghìn kiểu `vi-VN`, đơn vị VND rút gọn (tr/Tỷ/Tr).
- Skeleton loading (shadcn `Skeleton`) cho mọi section khi fetch lần đầu; empty states cho watchlist/signals trống.

---

## 4. API Surface

Tất cả route là **Route Handlers** trả JSON; lỗi trả `{ "error": string }` + status phù hợp (400/404/500). `BigInt` serialize thành `Number` (an toàn < 2^53). Client gọi bằng **relative path** (`fetch('/api/...')`).

| Method | Route | Mục đích | Response (tóm tắt) |
|---|---|---|---|
| GET | `/api/market/quotes` | Toàn bộ VN30 + quote mới nhất (volume desc) **+ summary** (VN-Index proxy, bề rộng, thanh khoản, top gainer/loser) **+ meta nguồn** (`mode`/`asOf` — S4 stale marking) | `{ quotes: QuoteRow[], summary, meta }` |
| POST | `/api/market/tick` | **Tick bảng giá S4** (engine mô phỏng quanh ref THẬT): random-walk + mean-reversion 3% trên quote mới nhất từng mã, tuân thủ Q1 (bội 100) · Q2 (dải ±7%) · Q3 · Q5; **EOD rollover** khi sang ngày ICT mới (REAL_EOD_MODE mặc định — **KHÔNG ghi bar synthetic**, bar EOD thuộc về nguồn thật S7; refPrice/dải/volume mới — ngân sách ngày 0,3–9,2tr cp); **khớp lệnh giấy** PENDING/PARTIALLY_FILLED khi giá vượt điều kiện (BUY `last ≤ giá đặt` · SELL `last ≥ giá đặt`) — cập nhật Trade/Position/tiền mặt/equity + audit `ORDER_FILLED`; lệnh SELL vượt điều kiện nhưng không đủ vị thế → **tự REJECTED 1 lần** + audit `ORDER_REJECTED` (không retry); **mutex in-process** (AUD-CODE #18 — mọi POST tuần tự, chống lost-update); `MARKET_STRICT_SESSION=true` (mặc định) thì chỉ chạy trong phiên (ngoài phiên trả `skipped: true` + đánh dấu nguồn mode `real` — bảng giá neo close thật); **phiên #34 — nhánh realtime:** mode runtime `realtime-vndirect` (AppSetting ghi đè env — §6.5) + trong phiên + đã cấu hình → fetch **giá cuối THẬT finfo** (`src/lib/vndirect.ts`, throttle ≥30s kèm cache module-level — tick 10s dùng cache; giá round100 + clamp dải ±7%, change/changePct từ ref EOD thật, volume/high/low dồn phiên thật); fetch fail → `markSource` mode `fallback` + lastError + tiếp tục random-walk như cũ (không bỏ tick); ok → mode `real` + meta provider `finfo-vndirect` | payload cùng shape `GET /api/market/quotes` + `ticked`/`rolled`/`fills` |
| POST | `/api/market/eod-sync` | **Đồng bộ EOD THẬT VNDIRECT dchart (S7 — `src/lib/eod-sync.ts`)**: kéo bar EOD đã adjust cho toàn bộ instrument active (body tuỳ chọn `{ days }` — lookback mặc định 10 ngày, clamp 2–365) → validate §5 Q1–Q9 → upsert `Bar` theo `@@unique([instrumentId, date])` → **neo `Quote` vào close thật** (ref/OHLC/volume/trần/sàn thật) → đánh dấu nguồn `eod-history` mode `real`; engine gọi 15:45 ICT hằng ngày + lúc boot; mutex tự nhiên qua throttle 300ms/request | `EodSyncOutcome { ok, symbolsOk[], symbolsEmpty[], symbolsFailed[{symbol, error}], barsUpserted, barsSkipped, lastTradeDate, durationMs, days }` · 502 khi mọi mã fail |
| GET | `/api/market/flows` | **Dòng khối ngoại ròng S6**: mode `simulated` — deterministic (FNV-1a hash theo mã+ngày), scale theo thanh khoản thật (2–80 tỷ VND); tổng bán ròng < −300 tỷ → RiskAlert WARNING `FOREIGN_FLOW_OUTFLOW` (dedupe 24h) | `{ mode, asOf, totalNet, totalBuy, totalSell, topNet[], topSell[], note }` |
| GET | `/api/news?limit=12` | 12 tin RSS mới nhất (S5) + meta nguồn cho stale marking | `{ items[], meta: { total, mode, lastSuccessAt, stale, ageMinutes, providers } }` |
| POST | `/api/news` | **Chạy crawler RSS 5 nguồn ngay** (rate-limit 60s giữa 2 lần nạp, audit `NEWS_INGESTED`) — nạp được thì `mode=live`, nguồn chết → `fallback` | `{ added, updated, total, mode, feeds[] }` · 429 nếu dồn lịch |
| GET | `/api/system/status` | Trạng thái toàn hệ thống cho footer/monitoring: gọi `escalateStaleSources()` (DATA_SOURCE_STALE WARNING khi stale >4h, dedupe 24h) trước khi đọc; **phiên #34: khối `market` thêm `effectiveMode` + `realtimeOk`** (mode runtime AppSetting) | `{ sources[], trading, market (effectiveMode, realtimeOk), counts, escalatedAlerts, serverTime }` |
| GET | `/api/settings` | **Module Cài đặt (phiên #34)**: cấu hình VNDIRECT (**secret mask** — 4 ký tự đầu + "····"; `configured`) + `marketData` (mode · effectiveMode · strictSession · eodSyncAt · realtimeOk · lastRealtimeAt) + `llm` (model runtime) + `risk` (3 limit) + `bayes` (enabled + lastAssessmentAt) | `{ vndirect, marketData, llm, risk, bayes, updatedAt }` |
| PUT | `/api/settings` | Lưu cấu hình — secret: **bỏ trống = giữ nguyên**, chuỗi `""` = xoá, giá trị chứa marker masked bị bỏ qua (chống echo UI làm hỏng secret đã lưu); mode validate ∈ {real-eod, realtime-vndirect, simulated} — sai → 400 tiếng Việt; realtime-vndirect chưa cấu hình vẫn lưu nhưng `effectiveMode` = real-eod | `SettingsResponse` (mới) · 400 |
| POST | `/api/settings/test` | **Probe kết nối THẬT**: OAuth2 `client_credentials` (auth.vndirect.com.vn) + finfo `/v4/lastprice`; test bằng creds đã lưu → ghi `lastTest` vào AppSetting; creds mới trong body → KHÔNG lưu, KHÔNG đè lastTest; `maxDuration` 30s; lỗi mạng → message tiếng Việt + gợi ý whitelist egress | `{ ok, authTried, authOk, finfoOk, latencyMs, sampleQuote, message }` |
| POST | `/api/watchlist/toggle` | Thêm/gỡ mã khỏi watchlist mặc định (body `{ symbol }`) + audit `WATCHLIST_ADDED`/`WATCHLIST_REMOVED` | `{ symbol, inWatchlist, count }` · 404 nếu mã/watchlist không có |
| GET | `/api/market/watchlist` | Watchlist mặc định + quote mới nhất mỗi mã (cùng dạng QuoteRow) | `{ watchlist: { name, count, quotes[] } }` |
| GET | `/api/instruments/bars?symbol=VCB&days=90` | Chuỗi OHLCV + SMA20 cho price chart (cap 90 ngày) | `{ symbol, name, last, change, changePct, bars[] }` |
| GET | `/api/portfolio` | Sổ tài khoản demo (**accountNumber đã mask**) + positions P&L runtime + totals | `{ account, positions[], totals }` |
| GET | `/api/orders` | 20 lệnh + 20 bút toán gần nhất (fee/tax dạng Number) | `{ orders[], trades[] }` |
| POST | `/api/orders/[id]/cancel` | **Hủy lệnh đang chờ khớp** (chỉ PENDING/PARTIALLY_FILLED — phần chưa khớp; lệnh đã kết thúc → 409; không có → 404) + audit `ORDER_CANCELLED`; chạy đua an toàn với fill engine trong tick (claim có điều kiện) | `{ order }` · 404/409 |
| GET | `/api/agents` | Trạng thái **23 agent** (config parse, pendingTaskCount, lastRun, **`group`/`groupLabel` — 5 nhóm research/control/executive/platform/ml**) + **stats mỗi agent (G3 §4.2**: runCount, successRate, totalTokensIn/Out, totalCostUsd, lastError, chatCount)** + **totals chi phí AI toàn đội** + 12 nhiệm vụ | `{ agents[] (kèm stats + group/groupLabel), tasks[], totals, llm }` |
| POST | `/api/agents/run` | **Chu kỳ phân tích đầy đủ 23 agents — 6 đợt A→F (phiên #34)** (A nền tảng 4 service song song → B nghiên cứu+học máy 8 service + 4 LLM tuần tự → C kiểm soát risk LLM + 2 service → **D Bộ tổng hợp Bayes nhân quả — §5.3, deterministic 0 LLM, chạy giữa Control và Chủ tịch** → E Chủ tịch tổng hợp 20 báo cáo + khối Bayes → F thực thi; 6 lượt LLM + 17 deterministic; xem §5.2; prompt kèm `newsBlock` + `flowsBlock`; **G3: tín hiệu BUY/SELL sinh ra ACTIVE chờ trader phê duyệt — không tự tạo lệnh**, audit `SIGNAL_CREATED`; cooldown chu kỳ 60s) | `{ runId, messages[], signals[], order: null, failures[], durationMs, assessment (assessmentSummary — phiên #34), waves { architecture, agentsRan, platform, researchAndMl, control, executive } }` |
| GET | `/api/assessment` | **Bộ tổng hợp Bayes (phiên #34 — §5.3)**: bản nhận định mới nhất (`source` = `cycle` \| `manual`, kèm `cycleRunId` gắn run Chủ tịch) + lịch sử 30 bản; chưa có → 200 với `assessment: null` | `{ assessment: MarketAssessmentView \| null, history[] }` |
| POST | `/api/assessment/synthesize` | **Tổng hợp lại ngay — 0 LLM, $0**: buildEvidenceBundle từ DB thật (30 mã × 260 bar EOD + prior 7.500 quan sát) + phiếu LLM gần nhất → synthesize → persist `source="manual"` (42 bằng chứng quant-only — đo ~1,5s); **cooldown 10s** (gọi dồn → 429 + header `Retry-After`); `maxDuration` 60 | `{ assessment: MarketAssessmentView }` · 429 |
| GET | `/api/agents/[id]` | **G3 §4.2 — hồ sơ chi tiết agent**: config parsed + stats + 20 runs + 12 tasks + **thread chat 1-1 (asc)** + 20 tin broadcast + signals ACTIVE của agent | `{ agent, runs[], tasks[], chat[], broadcastFeed[], signals[] }` · 404 nếu id rác |
| POST | `/api/agents/[id]/run` | **G3 §4.3 — chạy riêng 1 agent**: agent **LLM** (6 agent nhóm research/control/executive) gọi model như chu kỳ; agent **service (17)** chạy **deterministic từ DB qua `src/lib/agent-service-runs.ts` — 0 chi phí LLM**; rate-limit 60s/agent dựa trên AgentRun cuối — 429 kèm `retryAfterSeconds` + header Retry-After; execution-manager → 409; agent RUNNING → 400 | `{ agent, message, run }` · 404/400/409/429 |
| POST | `/api/agents/[id]/chat` | **G3 §4.4 — chat trực tiếp** (body `{message}` 2–500 ký tự; lưu tin USER ngay kể cả LLM lỗi; 10 tin history + bối cảnh dữ liệu compact; audit `AGENT_CHAT`; LLM lỗi → 200 reply null + error VN) | `{ userMessage, reply, run, threadLength, error? }` · 400/404/429 |
| GET | `/api/agents/messages?limit=30` | Feed tin broadcast gần nhất (kèm `direction`) | `{ messages[] }` join `fromAgent` |
| GET | `/api/signals?limit=` | Tín hiệu còn hiệu lực + gần nhất (kèm `status`/`rejectedAt`/`rejectNote` G3) | `{ signals[] }` join `Instrument` + `Agent` |
| POST | `/api/signals/[id]/convert` | Chuyển tín hiệu BUY/SELL thành lệnh PENDING (sizing budget 50tr/nửa vị thế — qua `src/lib/signal-execution.ts` chung với decision; giữ 409 nếu đã act); qua cổng S3 — `LIVE_TRADING` bật nhưng thiếu cấu hình → 503 + audit `LIVE_TRADING_BLOCKED`; đủ cấu hình mà chưa có gateway → 501 + audit `LIVE_ORDER_GATEWAY_UNAVAILABLE` | `{ order }` |
| POST | `/api/signals/[id]/decision` | **G3 §4.5 — phê duyệt / từ chối tín hiệu** (body `{action: APPROVE\|REJECT, note?}`): APPROVE → lệnh paper **sizing 5% NAV** + `status=ACTED` + audit `SIGNAL_APPROVED` (via decision) + `ORDER_CREATED`; REJECT → `status=REJECTED` + `rejectedAt`/`rejectNote` + audit `SIGNAL_REJECTED` (không tạo AgentMessage); guard 409 khi `status != ACTIVE`; SELL không vị thế → 400 | `{ signal, order? }` · 400/404/409 |
| GET | `/api/risk/alerts` | Cảnh báo rủi ro | `{ alerts[] }` sort severity + `createdAt` desc |

Tham chiếu field: mỗi response khớp định nghĩa model tại [DB_SCHEMA.md §6](./DB_SCHEMA.md); nguồn gốc dữ liệu của từng field tại [DATA_SOURCES.md §3–4](./DATA_SOURCES.md).

---

## 5. Multi-Agent Design

### 5.1 Đội 23 agents — 5 nhóm (kiến trúc Gen-1 DESIGN.md §4.1)

Nguồn duy nhất: **`src/lib/agent-roster.ts`** (thuần dữ liệu, không import — dùng chung bởi `prisma/seed.ts` · `prisma/expand-agents.ts` · API routes · UI). Mỗi agent có `group` (5 nhóm) và `kind`: **`llm`** — chu kỳ gọi model qua `src/lib/llm.ts` (prompt role trong `src/lib/agent-context.ts`) hoặc **`service`** — chạy deterministic từ DB (`src/lib/agent-service-runs.ts`, 0 chi phí LLM, ~0.2–1.5s).

| Nhóm (`group`) | Label UI | Agents (code · Gen-1) | kind |
|---|---|---|---|
| `research` (5) | Hội đồng Nghiên cứu | `market-analyst` (A2) · `fair-value` (A3) · `news-sentiment` (A4) · `liquidity` (A5) · `ml-forecast` (A15) | 4 LLM + 1 service |
| `control` (3) | Ủy ban Kiểm soát · VETO | `risk-manager` (A6) · `exposure` (A7) · `compliance` (A8) | 1 LLM + 2 service |
| `executive` (4) | Ban Điều hành | `portfolio-strategist` (A1 — **Chủ tịch**) · `execution-manager` (A10) · `settlement` (A11) · `cash-management` (A12) | 1 LLM + 3 service |
| `platform` (4) | Nền tảng Dữ liệu | `data-collector` (S0) · `notification-officer` (S1) · `feature-store` (S2) · `data-integrity` (A9) | 4 service |
| `ml` (7) | Phòng Học máy | `learning-rag` (A13) · `backtest` (A14) · `rl-gym` (S3) · `rl-policy` (A16) · `dl-trainer` (A17) · `rl-trainer` (A18) · `model-registry` (A19) | 7 service |

**6 agents chạy LLM mỗi chu kỳ** (market-analyst · fair-value · news-sentiment · liquidity · risk-manager · portfolio-strategist); **17 agents còn lại chạy deterministic từ DB** — 16 hàm trong `agent-service-runs.ts` + execution-manager do chu kỳ xử lý riêng vì cần `Signal` đầu vào. `config` JSON thật của từng agent xem `src/lib/agent-roster.ts` (roster cũng là nguồn cho `prisma/expand-agents.ts` — migrate DB 5 → 23 agents idempotent).

**Assessment JSON (phiên #34):** 5 agent LLM phân tích (market-analyst · fair-value · news-sentiment · liquidity · risk-manager) được yêu cầu trả thêm **phiếu assessment JSON có cấu trúc** `{direction, confidence, evidence[]}` (giữ nguyên `content`/`reasoning`/`sentiment` cũ; parse từ response, fallback theo `sentiment`) — mỗi phiếu trở thành **bằng chứng bầu** cho Bộ tổng hợp Bayes (§5.3) với LR = 1 + 0.8×confidence và trọng số theo `healthScore`/`successRate` của agent.

**Mô hình giao tiếp:** agents **broadcast** `AgentMessage` (`broadcast=true`, `toAgentId=null`) lên "bus"; **Ủy ban Kiểm soát (risk-manager · exposure · compliance) giữ quyền VETO — từ phiên #33 (AUD-CODE #6) VETO được HARD-ENFORCE trong orchestrator, không còn chỉ là cảnh báo**: `exposure` VETO (danh mục vượt hạn mức ngành/vị thế) → **chặn mọi tín hiệu MUA**; `compliance` VETO (biên margin âm / chế độ giao dịch chưa đạt) → **chặn mọi tín hiệu mới**; tín hiệu vi phạm bị **hạ về HOLD** kèm lý do trong `rationale`, và digest Chủ tịch được chèn khối "RÀNG BUỘC CỨNG TỪ ỦY BAN KIỂM SOÁT (VETO — bắt buộc tuân thủ)"; **Portfolio Strategist là Chủ tịch + điểm hợp lưu (consolidator)** — tổng hợp báo cáo của 20 agents trước nó (nghiên cứu · học máy · kiểm soát) **+ khối "BỘ TỔNG HỢP BAYES"** (pUp/pDown/pFlat % · hướng · confidence · disagreement · 3 driver · top-3 mã |pUp−pDown| + forecast CI · forecast5d · VETO — yêu cầu nhất quán với con số định lượng), chấm composite score và phát sinh `Signal`; **Execution Manager** là agent duy nhất được tạo `Order` (mặc định LIMIT, tách `sliceCount` lệnh con — và cũng chỉ khi trader phê duyệt).

### 5.2 Run cycle — `POST /api/agents/run` (chu kỳ 23 agents · 6 đợt)

```mermaid
sequenceDiagram
    participant U as Trader (UI)
    participant API as POST /api/agents/run
    participant DB as Prisma / Supabase Postgres
    participant LLM as src/lib/llm.ts (space-bunny-free | glm-4.6)

    U->>API: POST /api/agents/run
    API->>DB: 0. Snapshot: Quote, Bar(90d), Position, BrokerAccount, RiskAlert mở, NewsItem (S5), dòng khối ngoại (S6)
    rect rgb(235, 235, 245)
        note over API,DB: ĐỢT A · Nền tảng dữ liệu (4 service song song — 0 LLM)
        API->>DB: data-collector · notification-officer · feature-store · data-integrity
    end
    rect rgb(235, 245, 235)
        note over API,DB: ĐỢT B · Nghiên cứu + Học máy
        API->>DB: 8 service song song (ml-forecast · backtest · learning-rag · rl-gym · rl-policy · dl-trainer · rl-trainer · model-registry)
        loop 4 LLM tuần tự (market-analyst · fair-value · news-sentiment · liquidity)
            API->>LLM: Chat completion (role prompt + context thật)
            LLM-->>API: Phân tích (content, reasoning, sentiment + assessment JSON {direction, confidence, evidence})
            API->>DB: AgentMessage (broadcast) + AgentRun (tokens, cost, duration)
        end
    end
    rect rgb(245, 240, 225)
        note over API,DB: ĐỢT C · Ủy ban Kiểm soát (VETO)
        API->>LLM: risk-manager (Chat completion)
        API->>DB: exposure · compliance (service, song song với risk-manager)
    end
    rect rgb(228, 240, 250)
        note over API,DB: ĐỢT D · BỘ TỔNG HỢP BAYES (§5.3 — deterministic, 0 LLM)
        API->>DB: buildEvidenceBundle: 30 mã × 260 bar EOD + prior 7.500 quan sát + breadth/lexicon/flows/Holt/regime
        API->>DB: + phiếu bầu LLM (assessment JSON 5 agent — weight healthScore/100)
        API->>DB: synthesizeMarketAssessment → lưu MarketAssessment (source "cycle") + assessmentSummary
    end
    API->>LLM: ĐỢT E · portfolio-strategist (Chủ tịch) tổng hợp 20 báo cáo + khối "BỘ TỔNG HỢP BAYES" → mục tiêu phân bổ
    API->>DB: Ghi Signal (direction, confidence, score, target/stop, expiresAt) — ACTIVE chờ duyệt
    rect rgb(240, 235, 245)
        note over API,DB: ĐỢT F · Thực thi & hậu cần
        API->>DB: execution-manager ghi nhận Signal (không tự tạo lệnh) + settlement · cash-management
        API->>DB: AuditLog (SIGNAL_CREATED, AGENT_RUN_COMPLETED — architecture "23-agents" + assessment {pUp, marketDirection, evidenceCount})
    end
    API-->>U: { runId, messages[], signals[], assessment, waves, failures[], durationMs } — UI invalidateQueries + toast
```

Chu kỳ 6 đợt (phiên #34) là **contract của orchestrator** (đã implement đầy đủ trong `src/app/api/agents/run/route.ts`, cooldown 60s chống spam chi phí): **A** nền tảng (4 service song song) → **B** nghiên cứu + học máy (8 service song song + 4 LLM tuần tự) → **C** kiểm soát (risk-manager LLM + exposure/compliance service) → **D** Bộ tổng hợp Bayes nhân quả (§5.3 — deterministic 0 LLM; bọc try/catch nên lỗi Bayes không làm hỏng chu kỳ) → **E** Chủ tịch portfolio-strategist tổng hợp **20 báo cáo + khối Bayes** → **F** thực thi (execution-manager + settlement/cash-management). **Đầu mỗi chu kỳ chạy 2 sweep (AUD-CODE #1/#5):** `reapStaleAgentRuns()` reset AgentRun kẹt RUNNING quá 5 phút (watchdog — agent không bị chặn vĩnh viễn) + `expireDueSignals()` chuyển Signal quá hạn sang `EXPIRED` (không còn tín hiệu chết vào prompt Chủ tịch); guard chống chồng lấn giữa chu kỳ ↔ single-run (AUD-CODE #3/#4). Mọi lời gọi LLM đều có prompt chứa snapshot dữ liệu thật từ DB (kèm chỉ báo SMA20/50, RSI14, động lượng 5 phiên, KL/TL20 tính từ `Bar` EOD THẬT dchart; fair-value thêm `valuationBlock` z-price band, liquidity thêm `liquidityBlock`) — các khối build trùng nguồn với **single-run/chat** qua `src/lib/agent-context.ts` (ROLE_PROMPTS đủ 23 agents). 4 LLM nghiên cứu + risk + strategist chạy **tuần tự** (retry backoff 2.5s khi 429; một agent lỗi không kéo sập chu kỳ — bỏ vào `failures[]`); mọi kết quả đều persist (`AgentMessage`, `Signal`) kèm audit (`AgentRun` mỗi agent, `AuditLog`: SIGNAL_CREATED · AGENT_RUN_COMPLETED) — không có kết quả AI nào "bay lơ lửng" ngoài persisted state. **Execution Manager chạy xác định (không LLM): ghi nhận tín hiệu và thông báo chờ phê duyệt của trader** — chu kỳ **không tự tạo Order**; lệnh chỉ xuất hiện khi trader **APPROVE** qua `/api/signals/[id]/decision` (sizing 5% NAV, lô 100, LIMIT — `src/lib/signal-execution.ts`, claim trong transaction chống TOCTOU 2 lệnh — AUD-CODE #2) hoặc `convert` (budget 50tr). Response trả thêm khối **`waves`** (`architecture/agentsRan/platform/researchAndMl/control/executive`) + **`assessment`** (assessmentSummary — phiên #34) tổng kết các đợt đã chạy — đo thực tế với Space Bunny Free (`reasoning_effort: low`): 1 chu kỳ 23 agents ≈ **42s, 0 lỗi, $0**; trên **dữ liệu EOD thật** (phiên #33): 200 OK · **50,4s · 0 lỗi**; **phiên #34 (6 đợt, thêm Đợt D Bayes): 200 OK · 38,8s · 23 agents · 0 lỗi** — Đợt D cho assessment **46 bằng chứng** (8 agentsConsidered · pUp 0.194/pDown 0.710 → BEARISH), tín hiệu Chủ tịch trích nguyên "xác suất 72,1%" (khớp pDown 0.7209); AuditLog `AGENT_RUN_COMPLETED` giờ kèm `assessment {pUp, marketDirection, evidenceCount}`.

### 5.3 Bộ tổng hợp Bayes nhân quả — Đợt D (phiên #34)

**Vị trí trong chu kỳ:** chạy giữa **Ủy ban Kiểm soát (Đợt C)** và **Chủ tịch (Đợt E)** — mọi phiếu phân tích đã có mặt, kết quả định lượng đến tay Chủ tịch trước khi tổng hợp. Engine **deterministic — 0 LLM, $0** (`src/lib/bayes/synthesis.ts`); dữ liệu vào từ DB thật qua `src/lib/bayes/evidence.ts` (30 mã × 260 bar EOD mỗi mã, prior 7.500 quan sát mã×phiên) + phiếu assessment JSON của 5 agent LLM (llmVotes của chu kỳ ưu tiên, fallback AgentMessage broadcast 24h có sentiment — conf 0.6).

**Mô hình — log-odds naive Bayes, 4 bậc nhân quả:**

| Bậc | Nội dung | Nguồn thuật toán |
|---|---|---|
| **Bậc 0 — Tiên nghiệm** | logit base-rate lịch sử: **250 phiên thật · 7.500 quan sát mã×phiên** (đo thật: 40,2% tăng · 46,7% giảm · ngưỡng flat 0,15%) | `historicalBaseRates` — `src/lib/quant/statistics.ts` |
| **Bậc 1 — Thị trường** | breadth (LR 1+0.6·\|b\|, cap 2.2) · lexicon tin 24h (LR e^1.1·\|s\|, cap 2.5, \|s\|>0.05) · dòng khối ngoại ròng (cap 1.8, weight 0.5) · Holt rổ (cap 1.9) · regime BULL/BEAR (LR 1.5) + **phiếu bầu LLM** (LR 1+0.8×conf, weight healthScore/100) | `src/lib/quant/{sentiment,forecast,regime}.ts` + assessment JSON |
| **Bậc 2 — Ngành** | posterior thị trường dịch theo momentum nhóm ngành (LR ảo exp(0.4·\|mom\|), cap 1.6) | `src/lib/bayes/synthesis.ts` |
| **Bậc 3 — Cổ phiếu** | khởi từ **posterior thị trường** + evidence từng mã top-10 ADTV: RSI14 <30→UP 1.7 / >70→DOWN 1.5 · z90 ±1.5→LR 1.5 · MACD histogram 1.25 · KL ≥1.2×TB20 xác nhận hướng 1.3 · momentum 5 phiên 1.2 · Holt từng mã cap 1.8 | `src/lib/indicators.ts` (mở rộng MACD · Bollinger · ATR Wilder · OBV · Stochastic) |

Mỗi bằng chứng dịch log-odds **± weight × ln(LR)** trên L_up/L_down rồi chuyển ngược thành `pUp/pDown/pFlat` (pFlat = max(0, 1−…), chuẩn hoá = 1 — đo thật pUp+pDown+pFlat = 1.0 chính xác, 0 NaN). **Clamp an toàn:** LR ∈ [0.5, 3] · weight ∈ [0.3, 1] · |L| ≤ 4 — không một bằng chứng nào lấn át hoàn toàn tiên nghiệm.

**Đầu ra đi kèm:**

- **Confidence** = 1 − H/ln3 (entropy phân phối 3 hướng) · **Disagreement** = 1 − |Σw·dir|/Σw (chỉ trên phiếu agent LLM);
- **Sensitivity** — Δlog-odds = weight × ln(LR) từng bằng chứng → **drivers** top-12 (đo thật: driver mạnh nhất "Holt rổ −2,68%" Δ −0.42; chu kỳ thật: top driver llm-vote:market-analyst Δ −0.434);
- **Forecast5d** — trung bình trọng số ADTV của dự báo Holt từng mã + CI80 từ residual trung bình (±1.2816σ√h; Holt chuẩn `l_t = α·y_t + (1−α)(l+b)` · `b_t = β·(l_t − l_{t−1}) + (1−β)·b_{t−1}`, residual đo bằng dự đoán 1-bước-lùi);
- **Stance** BUY/SELL từng mã cần margin 0.12 **và** forecast đồng hướng — không đạt → HOLD;
- **Narrative tiếng Việt** 3–5 câu tự sinh (hướng + %, 2 driver, bất đồng, CI 5 phiên, VETO) — chat 1-1 với agent cũng được gắn dòng "Bộ tổng hợp Bayes gần nhất: …" khi assessment ≤6h.

**Persist & API:** bảng **`MarketAssessment`** (pUp/pDown/pFlat/marketDirection/confidence/disagreement/evidenceCount + detail JSON, index createdAt desc; `source` = `cycle` | `manual`; `cycleRunId` gắn run Chủ tịch sau Đợt E) — đọc qua `GET /api/assessment` (bản mới nhất + history 30), tổng hợp lại qua `POST /api/assessment/synthesize` (0 LLM, cooldown 10s → 429 + Retry-After, đo ~1,5s). Prompt Chủ tịch (Đợt E) nhúng khối "BỘ TỔNG HỢP BAYES (con số định lượng — hãy nhất quán)" và giữ digest 160 ký tự cũ. **VETO vẫn là ràng buộc cứng** — banner phủ quyết hiển thị ngay trên nhận định ở workspace Tổng hợp.

**Kết quả đo thật (phiên #34):** chu kỳ 6 đợt `POST /api/agents/run` — 200 OK · **38,8s · 23 agents · 0 lỗi**; Đợt D: **46 bằng chứng** (42 quant + 4–5 phiếu LLM) · 8 agentsConsidered · **pUp 0.194 / pDown 0.710 → BEARISH** · disagreement 62,4%; tín hiệu Chủ tịch trích nguyên "Thị trường nghiêng giảm trong 5 phiên tới với **xác suất 72,1%**" — khớp pDown 0.7209. Bản synthesize thủ công (source `manual`): pUp 35,3% / pDown 52,0% / pFlat 12,8% · 42 bằng chứng · forecast5d −1,20% (CI80 −9,23%…+6,82%) · top mã FPT SELL (pUp 26,6% · z90 −1.50 · dự báo −3,92%).

### 5.4 Health scoring

`Agent.healthScore` (Float 0–100, seed khởi điểm 88–100) — **cập nhật động sau mỗi AgentRun** (implement trong `src/lib/health.ts`):

- **Trừ điểm:** `AgentRun` FAILED → −12.
- **Cộng điểm:** chu kỳ COMPLETED thành công → +2; `durationMs` thấp hơn P50 của ≤ 10 run COMPLETED gần nhất → thêm +1.
- Clamp [0, 100]; hiển thị dạng progress bar trên multi-agent panel; agent dưới ngưỡng (< 60) được **highlight viền amber** để trader biết cần kiểm tra config hoặc tạm `PAUSED`.

---

## 6. Realtime & mini-service market-engine

Mini-service **`mini-services/market-engine`** (Bun + `socket.io`, chạy riêng ở **port 3003**) là realtime engine + scheduler của Giai đoạn 2. Nó **không chạm DB trực tiếp** — mọi dữ liệu đều lấy qua API của app Next.js (server-to-server `http://localhost:3000`, mặc định `APP_URL`) rồi broadcast kết quả cho client.

### 6.1 Scheduler (env vars)

| Biến env | Mặc định | Ý nghĩa |
|---|---|---|
| `TICK_MS` | `10000` (10s) | Nhịp gọi `POST /api/market/tick` — tick bảng giá S4 rồi broadcast `quotes` |
| `NEWS_MS` | `900000` (15 phút) | Chu kỳ gọi `POST /api/news` — crawler RSS S5 rồi broadcast `news` |
| `EOD_SYNC_AT` | `15:45` (ICT) | Giờ hằng ngày gọi `POST /api/market/eod-sync` (sau giờ chốt phiên 15:00 ICT) — đồng bộ **bar EOD THẬT dchart VNDIRECT** + neo Quote vào close thật rồi broadcast `eod`; chỉ chạy **1 lần/ngày** (kiểm tra mỗi 60s, so ngày ICT đã sync) |
| `EOD_SYNC_DISABLED` | `0` | `1` = tắt scheduler đồng bộ EOD thật trong market-engine |
| `AGENT_CYCLE_MINUTES` | `0` (TẮT) | Chu kỳ tự động gọi `POST /api/agents/run` rồi broadcast `cycle` — **mặc định tắt để tiết kiệm chi phí LLM**, trader bấm nút chạy thủ công |
| `APP_URL` | `http://localhost:3000` | Địa chỉ app Next.js cho các cuộc gọi server-to-server |

Khởi động: chạy ngay một vòng tick + news + **eod-sync lúc boot** để client có dữ liệu sớm (môi trường mới tự có giá thật, lookback 10 ngày), sau đó `setInterval` theo các nhịp trên. Các biến số được **validate qua `envMs`** (NaN/giá trị dưới min → fallback về mặc định — AUD-CODE #20, chống `setInterval(NaN)` dồn cục API); giờ `EOD_SYNC_AT` parse bằng `parseHhMm` (sai định dạng → fallback 15:45); tick engine của app cũng có **mutex in-process** chống lost-update (AUD-CODE #18).

### 6.2 Sự kiện broadcast (socket.io)

| Event | Payload | Client xử lý (hook `useRealtimeMarket`) |
|---|---|---|
| `quotes` | payload `POST /api/market/tick` (cùng shape `GET /api/market/quotes` + `meta`, `ticked`) | `setQueryData(['quotes'])` + patch `['watchlist']` — **defer `setTimeout(0)`** để tránh warning concurrent React; cập nhật `lastTickAt` |
| `news` | kết quả crawler `{ added, updated, mode, feeds… }` | `invalidateQueries(['news'], ['system-status'])` |
| `eod` | kết quả `POST /api/market/eod-sync` (`EodSyncOutcome`) — chạy 15:45 ICT hằng ngày + lúc boot | `invalidateQueries(['quotes'], ['watchlist'], ['bars'], ['portfolio'], ['system-status'])` — nến/chỉ báo/danh mục tự đổi sang **giá thật** |
| `cycle` | kết quả `POST /api/agents/run` | invalidate toàn bộ dữ liệu agent (`agents`, `agent-messages`, `signals`, `orders`, `portfolio`, `risk-alerts`) + toast |
| `welcome` | `{ ok, service, ts }` khi client kết nối | xác nhận kết nối (đèn Live) |

### 6.3 Pattern kết nối client — qua gateway

Client **không nối thẳng cổng 3003** mà đi qua gateway (Caddy, cổng 81) bằng query định tuyến:

```ts
io("/?XTransformPort=3003", {
  transports: ["polling", "websocket"],
  reconnection: true, // reconnectionDelay 3s → 15s, timeout 8s
});
```

Query `XTransformPort` được socket.io gắn vào mọi request engine.io (path mặc định `/socket.io`); gateway đọc query đó và định tuyến sang cổng 3003 — nên app vẫn deploy được dưới reverse-proxy mà không cần mở thêm cổng.

### 6.4 Health endpoint

`GET /` (hoặc `/health`) trên cổng 3003 trả JSON thống kê vận hành: `{ ok, service, port, eodSyncAt, startedAt, lastTickAt, lastTickError, ticks, lastNewsAt, newsRuns, lastEodSyncAt, lastEodSyncDate, lastEodSyncError, eodSyncRuns, lastCycleAt, cycles, clients }` — dùng để giám sát scheduler (kể cả EOD sync) mà không cần vào log.

### 6.5 Mode dữ liệu runtime — AppSetting ghi đè env (phiên #34)

Module Cài đặt + bảng **`AppSetting`** (key-value JSON — Prisma push Supabase cùng `MarketAssessment`) cho phép đổi cấu hình **không restart**: key `market-data` (`{mode, realtimeOk, lastRealtimeAt}`) **ghi đè env `MARKET_DATA_MODE`** (cache in-process 5s, invalidate khi set — `src/lib/settings.ts`), key `vndirect` lưu creds + kết quả test cuối. 3 mode dữ liệu:

| Mode | Hành vi |
|---|---|
| `real-eod` (mặc định) | Như phiên #33: tick mô phỏng intraday quanh ref EOD thật; ngoài phiên neo close thật (mode `real`); rollover KHÔNG ghi bar synthetic |
| `realtime-vndirect` | Trong phiên + đã cấu hình creds → tick kéo **giá cuối THẬT finfo VNDIRECT** (throttle ≥30s kèm cache module-level; giá round100 + clamp dải ±7%; change/changePct từ ref EOD thật; volume/high/low dồn phiên thật). `getEffectiveMode` tự tục về `real-eod` khi **chưa cấu hình** hoặc **lần fetch cuối fail** — fallback an toàn mặc định; fetch fail → markSource mode `fallback` + lastError + tiếp tục random-walk quanh ref EOD thật (tick không bỏ — paper matching vẫn chạy) |
| `simulated` | Tick tự ghi bar synthetic khi sang ngày mới (hành vi cũ) |

**API:** `GET/PUT /api/settings` (secret **mask 4 ký tự đầu + "····"**; bỏ trống = giữ, `""` = xoá, giá trị chứa marker masked bị bỏ qua chống echo; mode validate 400 tiếng Việt) · `POST /api/settings/test` (probe thật OAuth2 `auth.vndirect.com.vn` + finfo `/v4/lastprice`, `maxDuration` 30s; test bằng creds đã lưu → ghi `lastTest` vào AppSetting, creds mới → không lưu/không đè) · `GET /api/system/status` thêm `market.effectiveMode` + `market.realtimeOk`.

> **Thực tế egress sandbox (probe phiên #34):** `finfo-api.vndirect.com.vn` resolve DNS (kể cả DoH dns.google/cloudflare) về **10.210.100.8 — địa chỉ RFC1918 private** → HTTP 000 timeout mọi hình thức; `auth.vndirect.com.vn` → NXDOMAIN — sandbox chặn egress tới VNDIRECT; chỉ `dchart-api` (160.250.74.45) sống (HTTP 200, 0,3s). Realtime finfo cần **máy chủ có egress thật** khi deploy; tới đó hệ thống tự an toàn fallback `real-eod` (UI badge "Đang fallback: EOD thật"). Đơn vị giá finfo chưa đối chiếu trực tiếp được → `normalizePrice` heuristic (raw < 1.000 → nghìn VND ×1000; ≥ 1.000 → VND nguyên — VN30 không có mã dưới ~10.000 ₫ nên an toàn) — cần rà lại khi có egress thật.

---

## 7. Security

| Lĩnh vực | Chính sách |
|---|---|
| **PII** | Field đánh dấu PII theo [DB_SCHEMA.md §4.1](./DB_SCHEMA.md): `email`, `phone`, `passwordHash`, `accountNumber`. API không trả `passwordHash`; **`accountNumber` được mask tại API boundary** (`VD00••••1828`) trước khi xuống client; `phone` không nằm trong response nào. PII không log ra console/LLM prompt. |
| **Credential storage** | Mật khẩu chỉ lưu **hash** (`passwordHash`) — giá trị seed là placeholder demo, production dùng bcrypt/argon2 + salt riêng. Broker credential & khóa dịch vụ đặt trong `.env` phía server (`DATABASE_URL`, `OPENCODE_ZEN_API_KEY`, khóa `z-ai-web-dev-sdk`), không commit, không đưa vào client bundle. **Từ phiên #34:** cấu hình VNDIRECT customer (consumer key/secret/access token) nhập qua module Cài đặt lưu trong bảng `AppSetting` phía server — **mask tại API boundary** (4 ký tự đầu + "····") trước khi xuống client, guard chống echo giá trị masked, không log ra console/LLM prompt; số tài khoản để nguyên vì là định danh hiển thị. |
| **API-only backend** | **Không dùng Server Actions** — mọi đọc/ghi qua Route Handlers: một cửa duy nhất để validate payload, kiểm soát rate, và ghi `AuditLog`. |
| **Relative-path API calls** | Client chỉ `fetch('/api/...')` — không hard-code origin, tránh leak cross-origin và SSRF-style redirect; deploy được dưới bất kỳ reverse-proxy/domain nào. |
| **LLM backend-only** | Mọi cuộc gọi agent đi qua `src/lib/llm.ts`, chỉ import trong Route Handlers (`/api/agents/run`, `[id]/run`, `[id]/chat`) — provider (Opencode Zen / z-ai) không bao giờ nằm trong dependency graph của client components → API key không expose; model runtime hiển thị trên UI qua `GET /api/agents` → `llm`. |
| **Audit logging** | `AuditLog` ghi mọi hành động nhạy cảm: `ORDER_CREATED`, **`ORDER_FILLED`** (fill engine trong tick — khớp lệnh giấy, kèm phí/thuế), **`ORDER_CANCELLED`** (POST /api/orders/[id]/cancel), **`ORDER_REJECTED`** (fill engine từ chối lệnh SELL không đủ vị thế — F-303, audit 22-a), `SIGNAL_APPROVED`, `AGENT_RUN_COMPLETED`, `NEWS_INGESTED`, `WATCHLIST_ADDED`/`WATCHLIST_REMOVED`, `LIVE_TRADING_BLOCKED`, `LIVE_ORDER_GATEWAY_UNAVAILABLE`, `RISK_ALERT_RAISED` (runtime: flows khối ngoại + stale escalate) — đủ 12/12 action runtime (fix F-206 + F-303); `SIGNAL_REJECTED` sẽ thêm ở Giai đoạn 3 (kèm `before`/`after` JSON, `ip`). |
| **Soft delete** | User/BrokerAccount/Instrument chỉ soft delete (`deletedAt`) — bảo toàn tính truy vết (xem [DB_SCHEMA.md §4.2](./DB_SCHEMA.md)). |
| **SQL injection** | Toàn bộ truy vấn qua Prisma Client parameterized — không string-concat SQL. |

---

## 8. Performance

| Khu vực | Chiến lược |
|---|---|
| **Query strategy** | Dùng đúng composite indexes đã định nghĩa trong schema: `Bar @@index([instrumentId, date(sort: Desc)])` phục vụ cửa sổ 90 ngày; `Quote @@index([instrumentId, tradedAt])` cho quote mới nhất; `NewsItem @@index([publishedAt(sort: Desc)])` cho 10 tin mới nhất; `Signal/Order/AgentRun/AgentMessage` đều có index `(fk, createdAt desc)` cho feed "mới nhất trước" — mỗi truy vấn dashboard là index seek, không scan. Chi tiết: [DB_SCHEMA.md §6](./DB_SCHEMA.md). |
| **90-day bar window** | Route bars mặc định & cap `days=90` — payload giới hạn (~90 dòng/mã), đủ cho SMA20/SMA50/RSI14/MACD/BOLL và chart; dữ liệu cũ hơn chỉ dùng khi có mục đích backtest (roadmap). |
| **Realtime push** | Event WebSocket `quotes` ghi **thẳng vào cache TanStack Query** (`setQueryData`) — bảng giá cập nhật tức thì mà không tốn thêm request HTTP; patch watchlist từ cùng payload; `news`/`cycle` chỉ `invalidateQueries` (để route tự refetch đúng query). |
| **Bộ tổng hợp Bayes (Đợt D — phiên #34)** | Deterministic 0 LLM: `POST /api/assessment/synthesize` đo ~1,5s (42 bằng chứng — đọc song song 30 mã × 260 bar EOD bằng Promise.all); cooldown 10s chống spam (429 + Retry-After); trong chu kỳ 6 đợt tổng thời gian đo thật 38,8s · 23 agents · 0 lỗi. |
| **JSON serialization** | `BigInt` (VND) chuyển `Number` tại API boundary — mọi giá trị demo < 2^53 nên lossless; client không cần BigInt polyfill. |
| **Client caching** | TanStack Query `staleTime` phân tầng: quote/watchlist 30s, portfolio/orders/signals/risk/agents 30–60s, bars 5 phút; skeleton ngay lập tức từ cache cũ (stale-while-revalidate). |
| **Loading UX** | shadcn `Skeleton` cho mọi section trong lần fetch đầu; sonner toast cho mutation `POST /api/agents/run` (không block UI). |
| **DB footprint** | Supabase Postgres (schema `trader`) — kho chính bền vững qua reset sandbox (dữ liệu phân tích/telemetry không mất khi môi trường local bị reset); **bar EOD thật VNDIRECT dchart đã nạp vào schema `trader` (S7 — 90.785 bar 2013→nay, phiên #33)**; song song cùng project còn schema `public` Gen-1 với 95.259 bar EOD thật (đã dùng làm nguồn đối chiếu khi validate S7). Ops SQL qua `tools/db-console.mjs` (Management API). |

---

## 9. Non-Goals & Roadmap

**Non-goals ở v0.3** (chủ động không làm, không phải "chưa làm xong"):

- **Giao dịch tiền thật** — không đặt lệnh qua broker thật; mọi `Order` là paper order nội bộ.
- Đăng nhập/đa người dùng đầy đủ (schema `User.role` đã sẵn nhưng demo single-user).
- Backtesting engine, chiến lược ML tự huấn luyện.
- Mobile app / native notification.

**Roadmap** (thứ tự ưu tiên — cập nhật trạng thái sau Giai đoạn 2):

1. **VNDIRECT live trading** — ✅ scaffold xong feature flag `LIVE_TRADING` + cổng kiểm tra `src/lib/trading-mode.ts` (503 + audit `LIVE_TRADING_BLOCKED` khi thiếu cấu hình; 501 + audit `LIVE_ORDER_GATEWAY_UNAVAILABLE` khi gateway chưa có); **pending mini-service gateway thật**: xác thực broker, đặt/hủy lệnh thật, đồng bộ số dư; mọi lệnh thật vẫn đi qua Risk Manager veto (xem [DATA_SOURCES.md §4.1](./DATA_SOURCES.md)).
2. **WebSocket mini-service realtime** — ✅ done: `mini-services/market-engine` (port 3003) broadcast `quotes`/`news`/`eod`/`cycle`/`welcome` + scheduler (tick 10s · RSS 15' · EOD sync 15:45 ICT + boot), client nối qua gateway với query `XTransformPort=3003` (§6).
3. **Scheduler chu kỳ agent tự động** — ✅ done: có sẵn trong market-engine (`AGENT_CYCLE_MINUTES`), mặc định 0 (TẮT) để tiết kiệm chi phí LLM.
4. **Nguồn dữ liệu ngoài** — **EOD giá thật ✅ (phiên #33):** S7 `src/lib/eod-sync.ts` + `POST /api/market/eod-sync` — 90.785 bar EOD THẬT VNDIRECT dchart 2013→nay (public, đã adjust) + neo Quote vào close thật + scheduler 15:45 ICT; news S5 ✅ (crawler RSS live 5 nguồn VN: VnEconomy/CafeF/VNExpress/Tuổi Trẻ/VietnamNet, model `NewsItem` dedupe theo url); alternative data S6 ✅ (dòng khối ngoại simulated deterministic + RiskAlert `FOREIGN_FLOW_OUTFLOW`); **realtime finfo ✅ code xong (phiên #34 — chờ egress):** module Cài đặt + `src/lib/vndirect.ts` (OAuth2 `client_credentials` auth.vndirect.com.vn + finfo `/v4/lastprice` POST envelope + GET fallback + `normalizePrice` heuristic nghìn-VND) + tick route nhánh realtime (throttle ≥30s, clamp ±7%, fallback real-eod tự động) — sandbox chặn egress tới VNDIRECT (DNS finfo → 10.210.100.8 private, auth NXDOMAIN) nên cần **máy chủ có egress thật/whitelist** khi deploy; chi tiết [DATA_SOURCES.md §4.5](./DATA_SOURCES.md).
5. Mở rộng HNX/UPCOM (schema `Market` đã có sẵn), lịch nghỉ Tết chính thức (hiện là bảng ước lượng 2026 trong `src/lib/market-session.ts`), ATO/ATC simulation.
6. PostgreSQL migration + tách bảng archive cho `Quote`/`Bar`/`NewsItem` khi khối lượng tăng.

---

## 10. Change Log

| Ngày | Thay đổi |
|---|---|
| 2026-10-05 | Tái tạo tài liệu sau reset workspace; khớp stack thực tế `package.json`/`bun.lock` và schema `prisma/schema.prisma` |
| 2026-10-05 | **v0.2 — hoàn thiện blueprint:** (1) chu kỳ đa agent đầy đủ §5.2 (4 LLM call, Signal + Order giấy + AuditLog); (2) đồng bộ bảng API §4 với routes thực tế (thêm `/api/orders`, `/api/signals/[id]/convert`, `/api/market/watchlist`); (3) health scoring động §5.3 (`src/lib/health.ts`) + highlight agent < 60; (4) mask `accountNumber` tại API; (5) Zustand store `src/lib/store.ts` + staleTime phân tầng; (6) Watchlist API + Switch chế độ bảng giá; (7) footer trạng thái nguồn dữ liệu + last-updated; (8) nút Chạy agent ở Header (hook dùng chung `useRunAgents`) |
| 2026-10-06 | **v0.3 — Giai đoạn 2 (S3–S6 + realtime):** (1) mini-service `market-engine` LIVE (port 3003): WebSocket broadcast + scheduler, section mới §6; (2) 6 API route mới (`/api/news` GET/POST, `/api/market/tick`, `/api/market/flows`, `/api/system/status`, `/api/watchlist/toggle`) + `meta` nguồn cho `/api/market/quotes`; (3) schema 19 model: `NewsItem` (S5, dedupe url) + `DataSourceStatus` (S4 stale marking); (4) crawler RSS 5 nguồn VN kiểm chứng + newsBlock/flowsBlock trong prompt chu kỳ agent; (5) S3 flag `LIVE_TRADING` + cổng kiểm tra + audit; (6) frontend: News card, Market pulse bar, cột sao watchlist, badge Live/Realtime, chips trạng thái nguồn động; roadmap cập nhật trạng thái |
| 2026-10-06 | **v0.4 — Giai đoạn 3 (PHASE3_BLUEPRINT B1–B3, 23 route):** (1) **App shell**: nav tab workspace (Zustand `activeWorkspace`, `?ws=` deep-link) — tổng quan ⇄ đội agent không reload, realtime giữ nguyên; (2) **4 API mới** (`GET /api/agents/[id]`, `POST /api/agents/[id]/run`, `POST /api/agents/[id]/chat`, `POST /api/signals/[id]/decision`) + `/api/agents` thêm stats/totals chi phí; rate-limit 60s/agent (DB-backed) + header Retry-After; (3) **Workspace Đội Agent**: roster 5 card (stats chi phí), panel chi tiết 5 tab (Hồ sơ/Hoạt động+sparkline/Nhiệm vụ/Phát thanh/Chat), chat 1-1 với AgentMessage.direction, phê duyệt/từ chối tín hiệu trong feed + panel; (4) **Dashboard**: nến Nhật + volume + RSI14 Wilder panel (custom Bar shape), toggle Nến/Đường, cột mở rộng bảng giá (trần/sàn/TC/cao/thấp + dấu ⌃⌄), donut phân bổ ngành + cột % tỷ trọng, ô Realized P&L, chip Sức mua ước tính (tooltip công thức), chip chi phí AI footer; (5) **hành vi mới**: chu kỳ sinh signal ACTIVE chờ duyệt (không auto-order — human-in-the-loop), audit `SIGNAL_CREATED`/`SIGNAL_APPROVED`/`SIGNAL_REJECTED`/`AGENT_CHAT`; `signal-execution.ts` một nguồn duy nhất cho toán tạo lệnh; SELL nav5pct guard vị thế |
| 2026-10-06 | **v0.5 — LLM provider abstraction (`src/lib/llm.ts`):** (1) 2 provider chọn qua env `LLM_PROVIDER=auto`: **Opencode Zen** `space-bunny-free` (`https://opencode.ai/zen/v1/chat/completions`, Bearer `OPENCODE_ZEN_API_KEY`, free-tier $0, zero-retention — **chạy được ngoài sandbox**) hoặc `z-ai-web-dev-sdk` GLM-4.6 (gateway nội bộ sandbox); (2) 3 route agent (run/single-run/chat) refactor dùng một cổng chung — bỏ 3 bản callLlm/callChatLlm trùng lặp; costUsd theo bảng giá provider (`LLM_PRICE_*_MTOK` ghi đè được); (3) `GET /api/agents` trả khối `llm` + `AgentCard.model` = model runtime — UI (workspace/panel/footer tooltip) hiển thị model đang chạy từ nguồn duy nhất; (4) `.env`/`.env.example` + README section "Chạy trên máy local" (chỉ cần API key opencode.ai/zen, KHÔNG cần Opencode CLI) |
| 2026-10-06 | **v0.6 — Mở rộng 23 agents (5 nhóm, chu kỳ 5 đợt: 6 LLM + 17 deterministic) · Space Bunny Free làm backbone mặc định (free-tier, `reasoning_effort: low` ≈ 3.7s/call) · DB: `AgentRole` +18 enum (23 giá trị), `Agent.group` + index:** (1) kiến trúc 5 → **23 agents đúng thiết kế Gen-1 DESIGN.md §4.1** (4 dịch vụ S + 19 agent A) chia 5 nhóm research/control/executive/platform/ml — nguồn duy nhất `src/lib/agent-roster.ts` + 16 hàm deterministic `src/lib/agent-service-runs.ts` + script migrate idempotent `prisma/expand-agents.ts`; (2) chu kỳ `POST /api/agents/run` chạy **5 đợt A→E** (A nền tảng 4 service → B nghiên cứu+học máy 8 service + 4 LLM → C kiểm soát risk LLM + 2 service → D Chủ tịch tổng hợp 20 báo cáo → E thực thi), response thêm khối `waves`; (3) `POST /api/agents/[id]/run` thêm service path (17 agent deterministic, 0 LLM); `GET /api/agents` + `/api/agents/[id]` trả `group`/`groupLabel`; (4) `agent-context.ts`: ROLE_PROMPTS đủ 23 agents + `valuationBlock`/`liquidityBlock`; (5) UI: roster 5 nhóm + badge VETO (nhóm control) + cuộn dọc riêng; (6) `.env` đặt sẵn `OPENCODE_ZEN_API_KEY` → provider mặc định opencode-zen `space-bunny-free` free-tier $0 chạy được ngoài sandbox; env mới `OPENCODE_ZEN_REASONING_EFFORT` (mặc định `low` cho model họ space-bunny); (7) E2E: 1 chu kỳ 23 agents ≈ 42s · 0 lỗi · 0 failures · **$0** |
| 2026-10-06 | **v0.7.0 — Phiên #33: rà soát toàn diện (30 findings audit AUD-CODE) + NẠP DỮ LIỆU EOD THẬT VNDIRECT:** (1) **S7 eod-sync mới** — `src/lib/eod-sync.ts`: `fetchDchartHistory` (golden signature `t,o,h,l,c,v,s` · `s="ok"` · retry 5xx/429 backoff 1s→4s · throttle 300ms) → `toRealBars` (giá **nghìn VND ×1000** + round100, validate §5 Q1–Q9, `Bar.date` 15:00 UTC, bỏ T7/CN, chặn dải 500–5.000.000 ₫) → `syncEodFromDchart` (lookback 10 ngày, upsert idempotent + **neo Quote** vào EOD cuối: ref/OHLC/volume/trần/sàn thật) → `deepBackfillEod` (2013→nay); API mới **`POST /api/market/eod-sync`** (body `{days}` 2–365, response `EodSyncOutcome`); scheduler market-engine **15:45 ICT hằng ngày + boot** + broadcast event `eod` → hook `use-realtime` invalidate quotes/watchlist/bars/portfolio; nguồn mới `eod-history` (SourceMode **`real`** — footer dot xanh "EOD thật"); (2) **deep backfill + rebase** `prisma/import-real-eod.ts`: **30/30 mã OK · 90.785 bar thật 2013→2026-10-06 · 37,8s · 0 bar bỏ** (VCB 91.600→57.300 ₫) + rebase danh mục theo giá thật (`Position.avgPrice` = close ngày mở · Trade/Order giá thật + fee 0,15%/tax 0,1% · Signal ACTIVE scale quanh close thật · xoá 3 alert demo · equity = cash + Σ qty×close = 1.373.869.150 ₫); (3) **REAL_EOD_MODE mặc định** (`MARKET_DATA_MODE=real-eod`): tick chỉ mô phỏng intraday quanh ref thật — EOD rollover KHÔNG ghi bar synthetic, ngoài phiên Quote neo close thật + mode `real`, `MARKET_STRICT_SESSION` mặc định true, mutex tick in-process (AUD-CODE #18), `envMs` validate NaN (#20); (4) **30 fix audit (1 P1 + 9 P2 + 20 P3):** sweep `expireDueSignals` (GET signals + đầu chu kỳ + trước tạo lệnh — #1) · transaction claim atomic APPROVE chống TOCTOU 2 lệnh (#2) · guard chồng lấn chu kỳ ↔ single-run + atomic claim (#3/#4) · watchdog `reapStaleAgentRuns` 5 phút (#5) · **VETO hard-enforce** — exposure chặn MUA / compliance chặn mọi tín hiệu mới, hạ về HOLD kèm lý do (#6) · backtest NaN guard (#7) · `ZEN_TIMEOUT_MS` 45s + `maxDuration` 300s (#8) · seed agents IDLE (#9) · cooldown sau validate (#10–13) · feature-store 4 nhóm (#14) · buyingPower = cash + positionsMv×0,5 − marginUsed đồng bộ service-runs + header chip (#15) · messages feed chỉ broadcast (#23) · news bỏ tin không ngày (#29) · flows seed `vol|`/`dir|` (#26) · seed `Date.UTC` + bỏ ternary chết (#19/#27) · label "Trước phiên (ATO…)" (#30) · chat bỏ hardcode $0.006 (#25); (5) **E2E trên dữ liệu thật:** chu kỳ 23 agents 200 OK · 50,4s · 0 lỗi · chat agent trả lời bằng chỉ báo thật (PNJ dưới SMA20/50, RSI13, 5 phiên −29,37%) · engine boot eod-sync 30 mã 210 bar · tick ngoài phiên skipped · mobile 390px 0 tràn ngang · lint EXIT 0 · tsc 0 lỗi src |
| 2026-10-06 | **v0.8.0 — Phiên #34: 7 workspace · Bộ tổng hợp Bayes nhân quả (Đợt D) · module Cài đặt VNDIRECT:** (1) **UI 7 workspace** — Tổng quan viết lại gọn (MarketSummary + AssessmentBrief + Signals compact + AgentSystemBrief) + 4 workspace tách (Thị trường · Danh mục · Tín hiệu — SignalsFeed + RiskAlerts + AgentsPanel compact · Đội Agent giữ nguyên) + 2 mới (**Tổng hợp** — Bộ tổng hợp Bayes đầy đủ 4 bậc + drivers + lịch sử; **Cài đặt** — VNDIRECT creds + nguồn dữ liệu + AI read-only); nav 7 tab cuộn ngang mobile (snap, ẩn scrollbar, ≥44px) + deep-link `?ws=` 7 giá trị; Prisma thêm `AppSetting` + `MarketAssessment` (push Supabase — 21 models); (2) **chu kỳ 5 → 6 đợt A→F** — Đợt D **Bộ tổng hợp Bayes nhân quả** giữa Ủy ban Kiểm soát và Chủ tịch (§5.3): log-odds naive Bayes 4 bậc (Bậc 0 tiên nghiệm base-rate 250 phiên thật 7.500 quan sát → Bậc 1 thị trường breadth/lexicon NLP tiếng Việt/flows/Holt/regime + phiếu LLM → Bậc 2 ngành → Bậc 3 cổ phiếu kế thừa posterior), clamp LR [0.5,3] · weight [0.3,1] · \|L\|≤4, sensitivity Δlog-odds → drivers top-12, disagreement, narrative tiếng Việt, forecast5d Holt + CI80, persist `MarketAssessment` (source cycle/manual + cycleRunId); 5 ROLE_PROMPTS LLM thêm assessment JSON {direction, confidence, evidence}; API mới `GET /api/assessment` + `POST /api/assessment/synthesize` (0 LLM, cooldown 10s); **bộ thuật toán thật mới** `src/lib/quant/` (statistics: OLS linreg/percentile NIST/entropy/base-rates · forecast: Holt double exponential + CI80 ±1.2816σ√h · sentiment: lexicon NLP tiếng Việt ~75 thuật ngữ + phủ định n-gram · regime: classifyRegime VOLATILE/BULL/BEAR/SIDEWAYS) + `src/lib/indicators.ts` thêm MACD(12,26,9)/Bollinger(20,2)/ATR Wilder 14/OBV/Stochastic(14,3); chat prompt thêm dòng Bayes context khi assessment ≤6h; (3) **module Cài đặt + realtime finfo** — `src/lib/settings.ts` (AppSetting runtime, cache 5s, mask secret, guard chống echo) + `src/lib/vndirect.ts` (OAuth2 client_credentials + finfo POST envelope + GET fallback + normalizePrice heuristic nghìn-VND) + `GET/PUT /api/settings` + `POST /api/settings/test` (probe thật ghi lastTest, không đè creds mới); mode runtime AppSetting ghi đè env (real-eod \| realtime-vndirect \| simulated — §6.5); tick route nhánh realtime trong phiên (throttle ≥30s cache, round100 + clamp ±7%, KLGD dồn phiên, fail → fallback random-walk + markSource fallback); `GET /api/system/status` thêm effectiveMode/realtimeOk; **probe sandbox:** finfo/auth KHÔNG reachable (DNS finfo → 10.210.100.8 RFC1918 private, auth NXDOMAIN — chỉ dchart sống) → realtime cần máy chủ egress thật, hiện tự fallback real-eod an toàn; (4) **E2E:** chu kỳ 6 đợt 200 OK · **38,8s · 23 agents · 0 lỗi** · assessment chu kỳ **46 bằng chứng · 8 agents · pUp 0.194/pDown 0.710 → BEARISH** · Chủ tịch trích nguyên "xác suất 72,1%" trong tín hiệu (khớp pDown 0.7209); synthesize thủ công ~1,5s (source manual 42 bằng chứng; pUp 35,3%/pDown 52,0%/pFlat 12,8%; forecast5d −1,20% CI80 −9,23%…+6,82%); browser 7/7 workspace no-overflow desktop 1280 + mobile 390 · 0 console error · tự fix 4 bug format % (xác suất 0..1 chưa ×100) + 1 tràn cột AgentsPanel · nút "Tổng hợp lại ngay" + test kết nối VNDIRECT gọi thật báo lỗi mạng trung thực · đổi mode realtime-vndirect → badge "Đang fallback: EOD thật" |
