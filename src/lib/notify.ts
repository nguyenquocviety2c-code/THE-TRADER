/**
 * src/lib/notify.ts — P2-1 KÊNH THÔNG BÁO S1 (phiên #62).
 * DATA_PLATFORM_BLUEPRINT v1.6 §5 P2-1: "S1 kênh webhook/email — pattern
 * pending-egress như finfo (sandbox chặn)".
 *
 * Mô hình hoạt động (đúng pattern finfo #34 trong fundamentals.ts):
 *   · S1 NotificationOfficer mỗi chu kỳ build bản tin digest → dispatchDigest()
 *     gửi qua các kênh ĐÃ cấu hình (AppSetting "notify").
 *   · Sandbox chặn egress → gửi webhook lỗi mạng → ghi row NotificationOutbox
 *     status PENDING_EGRESS (trung thực — không giả vờ đã gửi); máy chủ có
 *     egress → retryPendingOutbox() (piggyback mỗi chu kỳ S1 + POST /api/notify)
 *     tự phát hết backlog.
 *   · EMAIL: sandbox không có SMTP/egress → row PENDING_EGRESS ngay từ đầu
 *     với ghi chú rõ (chờ deploy máy chủ có egress + SMTP).
 *   · Phân biệt lỗi: MẠNG (fetch abort/DNS/ETIMEDOUT…) → PENDING_EGRESS;
 *     HTTP từ chối (4xx/5xx từ endpoint ĐẠT ĐƯỢC) → FAILED (endpoint sống
 *     nhưng từ chối — không phải lỗi egress); 2xx → SENT.
 *
 * Không kênh nào cấu hình → KHÔNG tạo row (trạng thái "SKIPPED" trong kết
 * quả trả về để S1 khai báo trung thực trong output).
 */

import { db } from "@/lib/db";

/* ─────────────────── Cài đặt kênh (AppSetting "notify") ─────────────────── */

const KEY_NOTIFY = "notify";

export interface NotifySettings {
  enabled: boolean;
  webhookUrl: string;
  emailTo: string;
}

const EMPTY_NOTIFY: NotifySettings = {
  enabled: false,
  webhookUrl: "",
  emailTo: "",
};

export async function getNotifySettings(): Promise<NotifySettings> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: KEY_NOTIFY } });
    if (!row) return { ...EMPTY_NOTIFY };
    const raw = JSON.parse(row.value) as Partial<NotifySettings>;
    return {
      enabled: raw.enabled === true,
      webhookUrl: typeof raw.webhookUrl === "string" ? raw.webhookUrl : "",
      emailTo: typeof raw.emailTo === "string" ? raw.emailTo : "",
    };
  } catch {
    return { ...EMPTY_NOTIFY };
  }
}

/**
 * Patch cài đặt notify: omit = giữ nguyên; chuỗi rỗng "" = xoá field.
 * (Cùng quy ước settings.ts — không dùng marker mask vì webhook/email
 * không phải secret hiển thị.)
 */
export async function saveNotifySettings(
  patch: Partial<NotifySettings>
): Promise<NotifySettings> {
  const cur = await getNotifySettings();
  const next: NotifySettings = { ...cur };
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (typeof patch.webhookUrl === "string") next.webhookUrl = patch.webhookUrl.trim();
  if (typeof patch.emailTo === "string") next.emailTo = patch.emailTo.trim();
  await db.appSetting.upsert({
    where: { key: KEY_NOTIFY },
    create: { key: KEY_NOTIFY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  return next;
}

/* ─────────────────── Gửi đi (pending-egress pattern) ─────────────────── */

export type OutboxStatus = "PENDING_EGRESS" | "SENT" | "FAILED";

export interface DispatchResult {
  channel: "WEBHOOK" | "EMAIL";
  status: OutboxStatus | "SKIPPED";
  note: string;
}

export interface DigestInput {
  /** Tiêu đề ngắn (dòng đầu bản tin S1). */
  subject: string;
  /** Toàn văn bản tin digest S1. */
  body: string;
  /** Mức verdict A9 chu kỳ (nếu có) — đính kèm payload webhook. */
  level?: string | null;
}

const WEBHOOK_TIMEOUT_MS = 6_000;
const PENDING_NOTE =
  "pending-egress — sandbox/mạng chặn đầu ra, giữ hàng đợi tự retry (mỗi chu kỳ S1 + POST /api/notify)";

/** Ghi nhận 1 lần thử gửi vào row outbox (tạo mới hoặc cập nhật).
 * F-63B-04/#63: attempts tăng NGUYÊN TỐ ({increment: 1} — không đọc-trước-ghi
 * dễ mất đếm khi dispatch + retry chồng nhau) + optimistic-guard
 * `status: "PENDING_EGRESS"` (sender khác đã ghi SENT thì không ghi đè
 * xuống — chống gửi kép/downgrade). */
async function recordAttempt(
  row: { id: string } | null,
  channel: "WEBHOOK" | "EMAIL",
  target: string,
  subject: string,
  payload: string,
  status: OutboxStatus,
  error: string | null
): Promise<void> {
  const now = new Date();
  if (row) {
    await db.notificationOutbox.updateMany({
      where: { id: row.id, status: "PENDING_EGRESS" },
      data: {
        status,
        attempts: { increment: 1 },
        lastAttemptAt: now,
        lastError: error,
        sentAt: status === "SENT" ? now : null,
      },
    });
    return;
  }
  await db.notificationOutbox.create({
    data: {
      channel,
      target,
      subject,
      payload,
      status,
      attempts: 1,
      lastAttemptAt: now,
      lastError: error,
      sentAt: status === "SENT" ? now : null,
    },
  });
}

/** Thử POST webhook — phân loại lỗi MẠNG vs HTTP. */
async function attemptWebhook(
  url: string,
  payloadJson: string
): Promise<{ ok: boolean; status: OutboxStatus; error: string | null }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payloadJson,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.ok) return { ok: true, status: "SENT", error: null };
    // Endpoint ĐẠT ĐƯỢC nhưng từ chối → FAILED (không phải egress)
    return { ok: false, status: "FAILED", error: `HTTP ${res.status}` };
  } catch (err) {
    // Lỗi mạng (DNS/timeout/kết nối bị chặn) → PENDING_EGRESS
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: "PENDING_EGRESS", error: msg };
  }
}

/**
 * Phát bản tin digest S1 qua mọi kênh đã cấu hình. KHÔNG bao giờ throw
 * (S1 phải chạy tiếp dù notify chết) — mọi lỗi nằm trong kết quả từng kênh.
 */
export async function dispatchDigest(input: DigestInput): Promise<{
  results: DispatchResult[];
  pendingCount: number;
}> {
  const settings = await getNotifySettings().catch(() => ({ ...EMPTY_NOTIFY }));
  const results: DispatchResult[] = [];
  const payloadJson = JSON.stringify({
    subject: input.subject,
    body: input.body,
    level: input.level ?? null,
    sentAt: new Date().toISOString(),
    source: "the-trader S1 notification-officer",
  });

  if (!settings.enabled) {
    return {
      results: [
        {
          channel: "WEBHOOK",
          status: "SKIPPED",
          note: "kênh thông báo ĐANG TẮT (AppSetting notify.enabled=false)",
        },
        // F-63B-10/#63 — đối xứng 2 kênh (trước fix chỉ có dòng WEBHOOK)
        {
          channel: "EMAIL",
          status: "SKIPPED",
          note: "kênh thông báo ĐANG TẮT (AppSetting notify.enabled=false)",
        },
      ],
      pendingCount: await countPending().catch(() => 0),
    };
  }

  // ── WEBHOOK ──
  if (settings.webhookUrl) {
    try {
      const r = await attemptWebhook(settings.webhookUrl, payloadJson);
      await recordAttempt(
        null,
        "WEBHOOK",
        settings.webhookUrl,
        input.subject,
        payloadJson,
        r.status,
        r.status === "SENT" ? null : r.error
      );
      results.push({
        channel: "WEBHOOK",
        status: r.status,
        note:
          r.status === "SENT"
            ? "đã POST tới webhook (2xx)"
            : r.status === "PENDING_EGRESS"
              ? `${PENDING_NOTE}. Chi tiết: ${r.error}`
              : `webhook từ chối — ${r.error} (endpoint sống, kiểm tra URL/secret)`,
      });
    } catch (err) {
      // DB lỗi khi ghi outbox — không chặn S1, khai báo trong kết quả
      results.push({
        channel: "WEBHOOK",
        status: "FAILED",
        note: `ghi outbox lỗi: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    results.push({
      channel: "WEBHOOK",
      status: "SKIPPED",
      note: "chưa cấu hình webhookUrl",
    });
  }

  // ── EMAIL ──
  if (settings.emailTo) {
    try {
      // Sandbox: không SMTP + egress chặn → thẳng PENDING_EGRESS trung thực
      // (đúng chữ blueprint "pattern pending-egress như finfo")
      await recordAttempt(
        null,
        "EMAIL",
        settings.emailTo,
        input.subject,
        payloadJson,
        "PENDING_EGRESS",
        "chờ máy chủ có egress + SMTP (sandbox không gửi được email)"
      );
      results.push({
        channel: "EMAIL",
        status: "PENDING_EGRESS",
        note: `bản tin vào hàng đợi gửi tới ${settings.emailTo} — ${PENDING_NOTE}`,
      });
    } catch (err) {
      results.push({
        channel: "EMAIL",
        status: "FAILED",
        note: `ghi outbox lỗi: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    results.push({
      channel: "EMAIL",
      status: "SKIPPED",
      note: "chưa cấu hình emailTo",
    });
  }

  return { results, pendingCount: await countPending().catch(() => 0) };
}

/* ─────────────────── Quét lại backlog pending ─────────────────── */

async function countPending(): Promise<number> {
  return db.notificationOutbox.count({ where: { status: "PENDING_EGRESS" } });
}

export interface RetryOutcome {
  retried: number;
  sent: number;
  stillPending: number;
  errors: string[];
  /** F-63B-05/#64 — ghi chú khi retry tự động bị skip vì kênh đang TẮT. */
  note?: string;
}

/**
 * Quét tối đa `limit` row PENDING_EGRESS WEBHOOK cũ nhất, thử gửi lại
 * (EMAIL giữ pending — sandbox/máy chủ chưa có SMTP; số phận backlog EMAIL
 * chờ quyết định user, xem fixbug #63 F-63B-01). Piggyback mỗi chu kỳ S1 và
 * POST /api/notify (nút "Thử gửi lại" trong UI Cài đặt).
 *
 * F-63B-01/#63: filter `channel: "WEBHOOK"` đặt TRONG where — trước fix
 * take-N-oldest-toàn-cục rồi mới skip EMAIL, nên backlog EMAIL dead-letter
 * (không có đường gửi nào) dần chiếm hết slot oldest → webhook starve,
 * mâu thuẫn lời hứa blueprint "máy chủ có egress → tự phát hết backlog".
 *
 * F-63B-05/#64 (quyết định thay user): retry TỰ ĐỘNG (piggyback S1 — opts.manual
 * không đặt) tôn trọng notify.enabled — người dùng TẮT kênh nghĩa là NGỪNG bắn
 * ra ngoài ngay lập tức; backlog giữ nguyên PENDING_EGRESS để bật lại thì tự
 * cạn (không FAILED — không đánh lừa "đã thử và hỏng"). Nút "Thử gửi lại"
 * (POST /api/notify → opts.manual=true) là ý định tường minh của người bấm —
 * vẫn bắn kể cả khi kênh đang TẮT (đúng ngữ nghĩa nút).
 *
 * F-63B-11/#63: prune piggyback SENT/FAILED cũ hơn 30 ngày (best-effort —
 * PENDING_EGRESS KHÔNG prune: backlog chờ egress phải sống qua restart).
 *
 * F-63B-09/#63: DB lỗi ở đây NÉM lên (POST route → 500 trung thực; S1
 * piggyback đã .catch(() => null) tại call-site — không chặn chu kỳ).
 */
export async function retryPendingOutbox(
  limit = 5,
  opts?: { manual?: boolean }
): Promise<RetryOutcome> {
  // F-63B-05/#64 — retry tự động chỉ chạy khi kênh đang BẬT
  // F-65B-02/#65 — bỏ .catch(() => null) chết: getNotifySettings nuốt lỗi
  // nội bộ (catch → EMPTY enabled:false) nên không bao giờ reject. DB đọc
  // lỗi → EMPTY → skip (fail-closed đúng như #64 đã live; đường DB chết hẳn
  // thì countPending() dưới sẽ ném → 500 trung thực, F-63B-09).
  if (!opts?.manual) {
    const settings = await getNotifySettings();
    if (!settings.enabled) {
      return {
        retried: 0,
        sent: 0,
        stillPending: await countPending(),
        errors: [],
        // F-65B-09/#65 — note chính xác số phận backlog: chỉ WEBHOOK tự cạn
        // khi bật lại; EMAIL không có đường gửi trong môi trường này (chờ
        // SMTP trên máy chủ có egress) — hứa "tự cạn" cho mọi kênh là sai.
        note: "kênh thông báo đang TẮT (hoặc cài đặt đọc không được) — retry tự động bị bỏ qua (F-63B-05); bật lại thì backlog WEBHOOK tự cạn, EMAIL giữ pending chờ SMTP",
      };
    }
  }
  await db.notificationOutbox
    .deleteMany({
      where: {
        status: { in: ["SENT", "FAILED"] },
        createdAt: { lt: new Date(Date.now() - 30 * 86_400_000) },
      },
    })
    .catch((err) => console.error("[notify] prune outbox (không chặn retry):", err));
  const rows = await db.notificationOutbox.findMany({
    where: { status: "PENDING_EGRESS", channel: "WEBHOOK" },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(50, limit)),
  });
  let sent = 0;
  const errors: string[] = [];
  for (const row of rows) {
    const r = await attemptWebhook(row.target, row.payload);
    await recordAttempt(
      { id: row.id },
      "WEBHOOK",
      row.target,
      row.subject ?? "",
      row.payload,
      r.status,
      r.error
    ).catch(() => undefined);
    if (r.status === "SENT") sent++;
    // F-65B-04/#65 — mask target trong errors[]: trước đây slice(0,40) để lộ
    // full URL (kèm ?token=… nếu ≤40 ký tự) trong cùng response POST mà GET
    // đã mask (F-63B-12).
    else if (r.error) errors.push(`${maskTarget(row.target)}: ${r.error.slice(0, 80)}`);
  }
  return {
    retried: rows.length,
    sent,
    stillPending: await countPending(),
    errors: errors.slice(0, 3),
  };
}

/* ─────────────────── Đọc outbox cho UI/API ─────────────────── */

export interface OutboxRowView {
  id: string;
  channel: string;
  target: string;
  subject: string | null;
  status: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export async function listOutbox(limit = 20): Promise<OutboxRowView[]> {
  // F-63B-09/#63 — KHÔNG nuốt lỗi DB: GET /api/notify phải 500 trung thực
  // thay vì trả [] + pendingCount 0 giả vờ "không có bản tin" khi DB chết.
  const rows = await db.notificationOutbox.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(100, limit)),
  });
  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    target: maskTarget(r.target),
    subject: r.subject,
    status: r.status,
    attempts: r.attempts,
    lastAttemptAt: r.lastAttemptAt?.toISOString() ?? null,
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null,
  }));
}

/**
 * F-63B-12/#64 (quyết định thay user): mask đích webhook khi hiển thị trong
 * bảng outbox — query string của URL có thể nhúng token (?key=…, ?token=…)
 * và một webhook URL đăng ký trên dịch vụ public thường là bí mật; giữ origin
 * + path (đủ nhận diện endpoint), che phần ?… → trailing. Trường CÀI ĐẶT
 * (input webhookUrl người dùng tự nhập/sửa) KHÔNG mask. Email giữ nguyên
 * (không phải bí mật trong ngữ cảnh này). Payload digest chưa từng lộ (đã
 * kiểm chứng #63) — giữ nguyên.
 */
function maskTarget(target: string): string {
  if (/^https?:\/\//i.test(target)) {
    try {
      const u = new URL(target);
      // F-65B-01/#65 — u.host (không phải u.hostname) để GIỮ SỐ CỔNG: 2
      // webhook khác port phải hiển thị khác nhau để operator phân biệt row
      // pending trỏ endpoint nào. (u.host cũng loại user:pass@ — an toàn hơn.)
      return `${u.protocol}//${u.host}${u.pathname}${u.search ? "?••••" : ""}`;
    } catch {
      // URL hỏng — rơi về truncate
    }
  }
  return target.length > 48 ? `${target.slice(0, 45)}…` : target;
}

/** Trạng thái tóm tắt cho UI Cài đặt (kèm bản tin SENT cuối).
 * F-63B-09/#63 — lỗi DB NÉM lên (route catch → 500) thay vì báo 0 giả. */
export async function notifyStatus(): Promise<{
  pendingCount: number;
  sentCount: number;
  lastSentAt: string | null;
}> {
  const [pendingCount, sentCount, lastSent] = await Promise.all([
    db.notificationOutbox.count({ where: { status: "PENDING_EGRESS" } }),
    db.notificationOutbox.count({ where: { status: "SENT" } }),
    db.notificationOutbox.findFirst({
      where: { status: "SENT" },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    }),
  ]);
  return {
    pendingCount,
    sentCount,
    lastSentAt: lastSent?.sentAt?.toISOString() ?? null,
  };
}
