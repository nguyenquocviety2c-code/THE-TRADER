# GIAO THỨC FIXBUG — Quy trình rà soát & sửa lỗi triệt để theo vòng lặp

> **Project:** The Trader — Hệ thống giao dịch đa agent (VNDIRECT)
> **Document:** `Fixbug.md` · **Version:** 1.0 · **Created:** 2026-10-07 (phiên #43)
> **Status:** **CHUẨN HOÁ THÀNH GIAO THỨC VẬN HÀNH** — được kích hoạt bằng lời yêu cầu của user
> **Nguồn gốc:** chỉ thị user phiên #43 — *"khi tôi yêu cầu kích hoạt giao thức Fixbug phần nào đấy thì bạn sẽ tiến hành rà soát các lỗi ở phần đấy, nếu thấy lỗi thì fix lại, test kiểm định rồi tiến hành rà soát lại rồi tiếp tục fix nếu có, có đến khi rà soát lại và không tìm thấy lỗi nào nữa, mọi thứ phần đấy vận hành đúng và triệt để thì kết thúc vòng lặp và tiến hành báo cáo"*
> **Quy tắc nền tảng (vĩnh viễn, phiên #37):** phát hiện vấn đề là **VÁ NGAY, KHÔNG HỎI LẠI**.

---

## §1. Cách kích hoạt giao thức

User phát ngôn theo một trong các dạng sau (máy hiểu tự nhiên, không cần chính xác từng chữ):

| Mẫu câu | Ý nghĩa |
|---|---|
| *"Kích hoạt giao thức Fixbug phần **X**"* | Rà soát triệt để scope X theo vòng lặp §3 |
| *"Chạy Fixbug **X**"* | Tương tự — dạng rút gọn |
| *"Kích hoạt Fixbug **toàn hệ thống**"* | Scope = tất cả các phần trong §2 (chạy tuần tự từng scope, mỗi scope một vòng lặp riêng) |
| *"Fixbug **X** thêm một vòng nữa"* | Chỉ chạy đúng 1 vòng rà soát trên scope X rồi báo cáo (dù sạch hay bẩn) |

**Bắt buộc khi kích hoạt:** xác nhận lại với user ngay đầu reply — scope đã hiểu, các file/boundary thuộc scope, và rằng vòng lặp sẽ kết thúc chỉ khi §7 thoả mãn. **Không** hỏi thêm gì khác sau đó (quy tắc vá ngay không hỏi).

---

## §2. Danh mục scope chuẩn

| Scope | Bao phủ | Ghi chú rà soát đặc thù |
|---|---|---|
| `database` / `db` | `prisma/schema.prisma` · `src/lib/db.ts` · `prisma/*.ts` (seed/backup/expand) · dữ liệu trong DB | Kiểu dữ liệu vs schema thực; idempotent khi chạy lại script; **backup trước mọi db:push** |
| `api` | `src/app/api/**` (mọi route) | Mã HTTP đúng ngữ nghĩa; validate input; không lộ secret; thời gian phản hồi; lỗi try/catch không nuốt im lặng |
| `market-engine` | `mini-services/market-engine/**` | Scheduler tick đúng chu kỳ; **log chạy liên tục không đứt**; WS broadcast; uncaught exception trong timer callback (bài học #42); restart phải dùng pattern double-fork |
| `bayes-ml` | `src/lib/bayes/**` · `src/lib/ml/**` · `src/lib/consensus.ts` | Đếm kép bằng chứng; xác suất tổng = 1; deterministic khi cần; cổng đồng thuận đúng khoảng + epsilon; bandit settle đúng reward thật |
| `sync-data` | `src/lib/eod-sync.ts` · `src/lib/intl-eod.ts` · `src/lib/fundamentals.ts` · reprobe · UnitSpec | Null/split/adjclose Yahoo; đơn vị index vs cổ phiếu vs cents; không bịa dữ liệu — nguồn hỏng phải hiển thị trung thực |
| `frontend` | `src/components/dashboard/**` · `src/app/page.tsx` | Render thật trên desktop + mobile 390px; 0 console error; API fetch có loading/error state; sticky footer; dữ liệu hiển thị khớp API trả về |
| `agents` | `src/lib/agent-roster.ts` · agent-service-runs · agent-context | 23 agents chạy đủ 6 đợt; phiếu cử tri 6 nguồn không trùng; chu kỳ ≤ 180s |
| `docs` | `docs/**` · `README.md` · `Fixbug.md` | Khớp thực tế code (số endpoint/model/dòng); 0 typo encoding; số liệu tự nhất quán |
| `toàn hệ thống` / `full` | Mọi scope trên + E2E xuyên suốt | Chạy theo thứ tự: `database` → `sync-data` → `api` → `bayes-ml` → `agents` → `market-engine` → `frontend` → `docs` |

User có thể gọi scope ngoài danh mục (ví dụ *"Fixbug phần tab Bảng giá"*) — khi đó tự ánh xạ sang tập file/flow tương ứng và nêu rõ ranh giới đã hiểu.

---

## §3. Vòng lặp Fixbug (lõi của giao thức)

```
┌─────────────────────────────────────────────────────────────┐
│  VÒNG N (bắt đầu N = 1)                                      │
│                                                              │
│  1. RÀ SOÁT TOÀN SCOPE (§4)                                  │
│         │                                                    │
│         ▼                                                    │
│  2. Có findings? ──── KHÔNG ──►  4. VÒNG XÁC NHẬN (§7)      │
│         │                          │                         │
│        CÓ                        Sạch ──► 6. KẾT THÚC        │
│         │                          │        + BÁO CÁO (§9)   │
│         ▼                        Bẩn ──► quay lại bước 1    │
│  3. FIX (P0 → P1 → P2) → TEST KIỂM ĐỊNH (§5–6)              │
│         │                                                    │
│         ▼                                                    │
│    VÒNG N+1 (rà soát lại TỪ ĐẦU như chưa từng fix)          │
└─────────────────────────────────────────────────────────────┘
```

**Quy tắc vòng lặp:**

1. **Rà soát là rà soát lại toàn scope** — mỗi vòng mới quét lại toàn bộ phạm vi như chưa từng fix gì (chống mù điểm do "chỗ đó mới fix chắc ổn rồi"). Không được chỉ rà những chỗ từng sửa.
2. **Fix theo thứ tự ưu tiên** P0 → P1 → P2 (§6). Mỗi finding được đánh ID riêng dạng `F-<số phiên><vòng>-<số thứ tự>` (ví dụ `F-431-03` = phiên #43, vòng 1, finding 3).
3. **Sau mỗi fix phải test kiểm định ngay** (§5) — fix mà không kiểm định coi như chưa fix.
4. **Vòng lặp chỉ kết thúc khi** một vòng rà soát hoàn chỉnh trả về **0 finding mới** và mọi test kiểm định **pass toàn bộ** — khi đó chạy **Vòng Xác Nhận** (§7) độc lập lần cuối. Chỉ khi Vòng Xác Nhận cũng sạch thì scope được công nhận **TRIỆT ĐỂ** và giao thức kết thúc với báo cáo (§9).
5. **Không báo cáo giữa vòng** — chỉ báo cáo khi kết thúc (hoặc khi chạm giới hạn an toàn §8). Giữa chừng chỉ ghi tiến độ ngắn gọn vào worklog.

---

## §4. Phương pháp rà soát (bước 1 mỗi vòng)

Mỗi vòng phải ghép **cả 4 lớp rà soát** — thiếu lớp nào coi như vòng chưa hoàn chỉnh:

| Lớp | Công cụ / cách làm | Bắt được gì |
|---|---|---|
| **Tĩnh — code** | Đọc code đường chính + ngã rẽ; `bun run lint`; soi logic biên (null, chia 0, off-by-one, type assertion `!` không căn cứ) | Bug logic, type sai, assertion `!` trên giá trị có thể null (gốc bug #42) |
| **Tĩnh — dữ liệu** | Truy vấn DB (`bun -e` qua Prisma) đối chiếu schema; đếm bản ghi; kiểm tra giá trị bất thường (âm, 0 hàng loạt, ngày tương lai) | Dữ liệu lệch schema, seed hỏng, mã bị đếm kép |
| **Động — runtime** | Đọc `/home/z/my-project/dev.log` + `dev-engine.log` (chỉ phần log MỚI từ lúc vào vòng); gọi API thật bằng curl; xem timestamp log có **chảy liên tục** đúng chu kỳ scheduler | Lỗi 500, hydration, scheduler chết lặng, WS không broadcast |
| **Động — browser** | Agent Browser mở `/` (desktop + mobile 390px): click/đổi tab, xem payload thật, đếm console error | Trang trắng, layout vỡ, fetch treo, nút chết |

**Chú ý môi trường sandbox** (phân biệt trước khi tính là finding):
- Tiến trình nền phải sống qua tool-call boundary — nếu chết không lỗi trong log → **environment reaper**, restart bằng pattern double-fork `(env -u DATABASE_URL setsid nohup … &)` rồi mới đánh giá tiếp (bài học #42 + worklog #593).
- Shell có thể còn `DATABASE_URL=file:…` cũ → mọi tiến trình nền phải `env -u DATABASE_URL`.
- Yahoo/nguồn ngoài bị 429/502 theo IP sandbox → **không phải bug code**; đúng thiết kế là im lặng + hiển thị trung thực + job hằng ngày tự phục hồi. Không bịa dữ liệu thay thế.

---

## §5. Test kiểm định (bước 3 mỗi vòng)

Dự án **không viết test suite mới** — kiểm định bằng cách **chạy thật và soi kết quả**:

1. **Kiểm định chỗ fix** (spot): tái hiện đúng điều kiện từng gây bug → xác nhận hành vi mới đúng. Ví dụ bug #42: đợi > 60s xem scheduler tick mà không TypeError.
2. **Kiểm định hồi quy scope** (regression): phần khác của scope vẫn hoạt động như trước fix — gọi lại các API/flow chính của scope, so sánh kết quả.
3. **Kiểm định E2E tối thiểu** khi scope chạm frontend/engine: trang `/` load 200 · 0 console error · luồng chính tương tác được · log runtime sạch (không có dòng lỗi mới xuất hiện sau lúc fix).
4. **Idempotency** với mọi thứ ghi DB/sync: chạy 2 lần → lần 2 không tạo trùng lặp (trừ dữ liệu mới hợp lệ như bar phiên mới).

Kết quả mỗi test phải có **bằng chứng cụ thể** (HTTP code, dòng log, số liệu, screenshot khi liên quan UI) — bằng chứng ghi vào báo cáo, **tuyệt đối không khẳng định suông**.

---

## §6. Phân loại findings & nguyên tắc fix

| Mức | Định nghĩa | Xử lý |
|---|---|---|
| **P0** | Sập chức năng / dữ liệu sai / treo vĩnh viễn / sai số tiền xác suất quyết định | Fix NGAY trong vòng hiện tại, ưu tiên tuyệt đối |
| **P1** | Chức năng lệch thiết kế nhưng còn chạy; hiệu năng xấu rõ rệt; hiển thị sai thông tin | Fix trong vòng hiện tại, sau P0 |
| **P2** | Cosmetics, doc lệch, code smell không gây hành vi sai | Fix nếu rảnh trong vòng; nếu để lại phải ghi rõ vào báo cáo phần "còn treo" |

**Nguyên tắc fix:**
- Vá **nguyên nhân gốc**, không vá triệu chứng (VD #42: vá regex + fail-safe + try/catch scheduler, chứ không chỉ đổi default env).
- Xoá/dọn helper phải `rg` toàn bộ usage trước khi xoá (bài học stdOf #38).
- Thêm guard null ở nơi tiêu thụ **và** sửa nguồn phát null nếu có thể.
- Mỗi fix commit-able riêng khi khả thi (fix nhỏ gọn, message nêu root cause).
- **Fix ngoài scope:** nếu phát hiện lỗi P0 nằm ngoài scope đang chạy → vẫn vá ngay (quy tắc vĩnh viễn) nhưng ghi tách bạch trong báo cáo mục "phát hiện ngoài phạm vi". P1/P2 ngoài scope → ghi vào "còn treo" để user quyết định chạy Fixbug scope khác.

---

## §7. Điều kiện dừng — Vòng Xác Nhận

Một vòng rà soát **hoàn chỉnh** (đủ 4 lớp §4) trả về:
- 0 finding mới, và
- toàn bộ test kiểm định từ các vòng trước vẫn pass

→ chuyển sang **Vòng Xác Nhận**: một lượt rà soát cuối **độc lập** (không dựa kết luận cũ), ưu tiên góc nhìn khác lần trước (ví dụ vòng trước nặng code-reading thì vòng này nặng runtime + browser), kèm E2E đầy đủ.

- Vòng Xác Nhận sạch → **KẾT THÚC**: scope đạt trạng thái **TRIỆT ĐỀ** — mọi thứ phần đó vận hành đúng.
- Vòng Xác Nhận phát hiện lỗi (kể cả P2) → trở lại vòng lặp (finding mới được fix như thường), sau đó phải có Vòng Xác Nhận mới.

---

## §8. Giới hạn an toàn

1. **Trần 8 vòng.** Nếu sau 8 vòng scope vẫn chưa sạch → **DỪNG**, báo cáo trung thực trạng thái còn sót + nguyên nhân (thường là bug tái tạo do môi trường sandbox, không phải code). Không được tuyên "sạch" khi chưa sạch — **báo cáo sai còn tệ hơn bug**.
2. **Không sửa chệch thiết kế đã chốt** trong các blueprint (v1.1). Nếu finding đòi đổi thiết kế (không phải lỗi mà là quyết định kiến trúc) → không tự ý vá theo ý mình; ghi vào báo cáo phần "cần quyết định user" kèm phương án đề xuất.
3. **Không phá dữ liệu thật** — mọi thao tác nguy hiểm với DB (db:push, bulk write) phải backup trước (`db/backup-*`) theo đúng quy trình B1.
4. **Không tự tăng scope** giữa vòng — mở rộng phạm vi phải ghi rõ và chỉ được khi scope cũ đã sạch.

---

## §9. Báo cáo kết thúc (bắt buộc khi thoả §7 hoặc chạm §8)

Template báo cáo cho user:

```markdown
## Kết quả Fixbug — <scope> (phiên #<số>)

- **Trạng thái:** TRIỆT ĐỂ / DỪNG Ở VÒNG <N> (nguyên nhân)
- **Số vòng rà soát:** <k> vòng fix + 1 vòng xác nhận sạch
- **Findings:** <x> (P0: <a> · P1: <b> · P2: <c>)

| ID | Mức | Mô tả | Nguyên nhân gốc | Cách vá | Bằng chứng kiểm định |
|----|-----|-------|------------------|---------|----------------------|
| F-… | … | … | … | … | HTTP/log/screenshot … |

- **Test kiểm định đã chạy:** <danh sách + kết quả từng test>
- **Phát hiện ngoài phạm vi:** <danh sách hoặc "không có">
- **Còn treo (P2/ý kiến):** <danh sách hoặc "không có">
- **Commit:** <hash> · **Worklog:** Task ID `<số>-FIXBUG-<scope>`
```

Đồng thời **luôn luôn** trước khi báo cáo: append worklog (`/home/z/my-project/worklog.md`) theo đúng mẫu chung (`--- / Task ID / Agent / Task / Work Log / Stage Summary`), Task ID dạng `<số phiên>-FIXBUG-<scope>` (ví dụ `43-FIXBUG-market-engine`), rồi **commit + push**. Work Log phải liệt kê từng vòng: findings → fix → test → kết quả.

---

## §10. Nguyên tắc vàng (rút từ các sự cố thật của dự án)

1. **Assertion `!` phải được kiểm bằng input thật.** `parseWeekly("SUN:04:00")!` vẫn null nếu regex sai — fallback sai thì `!` chỉ chuyển null thành crash lúc chạy xa nhất (bug #42: engine chết lặng ~2h).
2. **Timer callback phải try/catch.** Một uncaught exception trong `setInterval` làm chết cả event loop — tiến trình vẫn "sống" trong `ps` nhưng không làm gì. Triệu chứng nhận diện: log ngừng chảy đúng chu kỳ.
3. **Log phải chảy theo chu kỳ đã khai báo** — tick 10s/news 15 phút/eod 15:45 ICT. Log đứt đoạn = engine chết, dù không có dòng lỗi nào.
4. **Tiến trình nền: double-fork subshell `(env -u DATABASE_URL setsid nohup … &)`** — `setsid nohup … &` trần trụi bị reaper giết ngầm 2–4 phút sau, không dấu vết.
5. **Probe lỗi cũng phải log rõ** — `try/catch` nuốt lỗi thành "probe trống" che mất ReferenceError thật (bài học #38: shorthand import sai tên biến).
6. **Không bịa dữ liệu, không bịa kết quả test.** Nguồn hỏng → hiển thị trung thực trạng thái chờ. Báo cáo "sạch" khi chưa sạch là vi phạm nghiêm trọng nhất của giao thức này.
7. **Vá xong phải tái hiện điều kiện gây bug** để chứng minh hết bệnh — không chỉ thấy không crash.
