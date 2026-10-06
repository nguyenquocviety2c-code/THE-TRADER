"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CircleCheck,
  CircleX,
  Cpu,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plug,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useApplyMarketDataMode,
  useSettings,
  useTestConnection,
  useUpdateSettings,
} from "@/hooks/use-settings";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import type { MarketDataMode, SettingsResponse } from "@/lib/types";

/**
 * Phiên #34 — workspace "Cài đặt": kết nối VNDIRECT (credentials masked),
 * nguồn dữ liệu thị trường (real-eod | realtime-vndirect | simulated) và
 * thông tin mô hình AI & đội agent (read-only).
 *
 * Form là local state (không controlled bởi server); PUT chỉ gửi field
 * người dùng nhập — chuỗi rỗng "" nghĩa là xoá. API /api/settings có thể
 * chưa sẵn sàng (backend song song) — error state + retry, không crash.
 */

/* ─────────────────── Form types ─────────────────── */

interface VndirectForm {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accountNumber: string;
}

const EMPTY_FORM: VndirectForm = {
  consumerKey: "",
  consumerSecret: "",
  accessToken: "",
  accountNumber: "",
};

const FORM_FIELDS: {
  key: keyof VndirectForm;
  label: string;
  secret: boolean;
  autoComplete: string;
}[] = [
  { key: "consumerKey", label: "Consumer Key", secret: true, autoComplete: "off" },
  { key: "consumerSecret", label: "Consumer Secret", secret: true, autoComplete: "off" },
  { key: "accessToken", label: "Access Token", secret: true, autoComplete: "off" },
  { key: "accountNumber", label: "Số tài khoản", secret: false, autoComplete: "off" },
];

/** Số % gọn: "40%" / "12,5%". */
function pctFmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
}

/* ─────────────────── Workspace ─────────────────── */

export function SettingsWorkspace() {
  const { data, isLoading, isError, error, refetch } = useSettings();

  return (
    <div
      role="tabpanel"
      id="workspace-panel-settings"
      aria-labelledby="workspace-tab-settings"
      className="flex flex-col gap-6"
    >
      <h2 className="sr-only">Cài đặt hệ thống — kết nối VNDIRECT &amp; nguồn dữ liệu</h2>

      {isLoading ? (
        <SettingsSkeleton />
      ) : isError || !data ? (
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-base">Không tải được cấu hình</CardTitle>
            <CardDescription>
              {error?.message ??
                "API /api/settings chưa phản hồi — backend có thể đang triển khai."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" className="min-h-11 gap-2" onClick={() => void refetch()}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Thử lại
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <VndirectCard settings={data} />
          <MarketDataCard settings={data} />
          <LlmCard settings={data} />
        </>
      )}
    </div>
  );
}

/* ─────────────────── 1. Kết nối VNDIRECT ─────────────────── */

function VndirectCard({ settings }: { settings: SettingsResponse }) {
  const update = useUpdateSettings();
  const test = useTestConnection();

  const [form, setForm] = React.useState<VndirectForm>(EMPTY_FORM);
  const [reveal, setReveal] = React.useState<Record<string, boolean>>({});

  const saved = settings.vndirect;
  const hasTyped = (Object.keys(form) as (keyof VndirectForm)[]).some(
    (k) => form[k].trim() !== ""
  );
  const busy = update.isPending || test.isPending;

  function setField(key: keyof VndirectForm, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /** Body cho POST test: creds form đang nhập (nếu có), ngược lại rỗng → backend dùng creds đã lưu. */
  function typedCreds(): Partial<VndirectForm> {
    const creds: Partial<VndirectForm> = {};
    for (const k of Object.keys(form) as (keyof VndirectForm)[]) {
      if (form[k].trim() !== "") creds[k] = form[k].trim();
    }
    return creds;
  }

  function handleTest() {
    const creds = typedCreds();
    test.mutate(Object.keys(creds).length > 0 ? creds : null);
  }

  function handleSave() {
    const creds = typedCreds();
    if (Object.keys(creds).length === 0) {
      toast.info("Chưa nhập thông tin nào để lưu", {
        description: "Điền ít nhất một trường rồi bấm Lưu cấu hình.",
      });
      return;
    }
    update.mutate(
      { vndirect: creds },
      {
        onSuccess: () => {
          toast.success("Đã lưu cấu hình VNDIRECT", {
            description: `${Object.keys(creds).length} trường được cập nhật (hiển thị đã che).`,
          });
          setForm(EMPTY_FORM);
        },
        onError: (err: Error) => toast.error(err.message || "Không lưu được cấu hình."),
      }
    );
  }

  function handleClear() {
    update.mutate(
      {
        vndirect: {
          consumerKey: "",
          consumerSecret: "",
          accessToken: "",
          accountNumber: "",
        },
      },
      {
        onSuccess: () => {
          toast.success("Đã xoá cấu hình VNDIRECT");
          setForm(EMPTY_FORM);
        },
        onError: (err: Error) => toast.error(err.message || "Không xoá được cấu hình."),
      }
    );
  }

  const testResult = test.data;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
          Kết nối VNDIRECT
        </CardTitle>
        <CardDescription>
          Nhập thông tin từ VNDIRECT customer portal để bật dữ liệu realtime
          &amp; API khách hàng. Thông tin lưu trong DB, hiển thị đã che (masked).
        </CardDescription>
        {saved.configured && (
          <CardAction>
            <Badge variant="outline" className="border-up/40 text-up">
              Đã cấu hình
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {FORM_FIELDS.map((f) => {
            const masked = saved[f.key];
            return (
              <div key={f.key} className="flex flex-col gap-1.5">
                <Label htmlFor={`vndirect-${f.key}`} className="text-xs">
                  {f.label}
                </Label>
                <div className="relative">
                  <Input
                    id={`vndirect-${f.key}`}
                    type={f.secret && !reveal[f.key] ? "password" : "text"}
                    autoComplete={f.autoComplete}
                    value={form[f.key]}
                    onChange={(e) => setField(f.key, e.target.value)}
                    placeholder={
                      masked ? `Đã lưu: ${masked}` : "Chưa cấu hình"
                    }
                    className={cn("min-h-11 pr-10", f.secret && "font-mono text-sm")}
                  />
                  {f.secret && (
                    <button
                      type="button"
                      aria-label={
                        reveal[f.key]
                          ? `Ẩn ${f.label}`
                          : `Hiện ${f.label}`
                      }
                      onClick={() =>
                        setReveal((r) => ({ ...r, [f.key]: !r[f.key] }))
                      }
                      className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {reveal[f.key] ? (
                        <EyeOff className="size-4" aria-hidden="true" />
                      ) : (
                        <Eye className="size-4" aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Kết quả kiểm tra kết nối */}
        {testResult && (
          <div
            role="status"
            className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3 text-xs"
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <span className="flex items-center gap-1.5">
                {testResult.details.authOk ? (
                  <CircleCheck className="size-3.5 text-up" aria-hidden="true" />
                ) : (
                  <CircleX className="size-3.5 text-down" aria-hidden="true" />
                )}
                Auth {testResult.details.authOk ? "OK" : "lỗi"}
              </span>
              <span className="flex items-center gap-1.5">
                {testResult.details.finfoOk ? (
                  <CircleCheck className="size-3.5 text-up" aria-hidden="true" />
                ) : (
                  <CircleX className="size-3.5 text-down" aria-hidden="true" />
                )}
                Finfo {testResult.details.finfoOk ? "OK" : "lỗi"}
              </span>
              <span className="tabular-nums text-muted-foreground">
                Độ trễ {testResult.details.latencyMs.toLocaleString("vi-VN")} ms
              </span>
              {testResult.details.sampleQuote && (
                <Badge variant="outline" className="tabular-nums text-[10px]">
                  {testResult.details.sampleQuote.symbol}{" "}
                  {testResult.details.sampleQuote.last.toLocaleString("vi-VN")} ₫ ·{" "}
                  <span
                    className={cn(
                      testResult.details.sampleQuote.changePct >= 0 ? "text-up" : "text-down"
                    )}
                  >
                    {testResult.details.sampleQuote.changePct >= 0 ? "+" : "−"}
                    {Math.abs(testResult.details.sampleQuote.changePct).toLocaleString("vi-VN", {
                      maximumFractionDigits: 2,
                    })}
                    %
                  </span>
                </Badge>
              )}
            </div>
            {(testResult.details.authMessage || testResult.details.finfoMessage) && (
              <p className="text-muted-foreground">
                {[testResult.details.authMessage, testResult.details.finfoMessage]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            <p className={cn("font-medium", testResult.ok ? "text-up" : "text-down")}>
              {testResult.message}
            </p>
          </div>
        )}

        {/* Lần test gần nhất từ server */}
        {saved.lastTestAt && !testResult && (
          <p className="text-xs text-muted-foreground">
            Lần kiểm tra gần nhất: {formatDateTime(saved.lastTestAt)} —{" "}
            <span
              className={cn(
                "font-medium",
                saved.lastTestOk ? "text-up" : "text-down"
              )}
            >
              {saved.lastTestOk ? "thành công" : "thất bại"}
            </span>
            {saved.lastTestMessage ? ` · ${saved.lastTestMessage}` : ""}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={handleTest}
            disabled={busy}
            className="min-h-11 gap-2"
          >
            {test.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plug className="size-4" aria-hidden="true" />
            )}
            Kiểm tra kết nối
          </Button>
          <Button
            onClick={handleSave}
            disabled={busy}
            className="min-h-11 gap-2"
            title={hasTyped ? "Lưu các trường đã nhập" : "Chưa nhập trường nào"}
          >
            {update.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="size-4" aria-hidden="true" />
            )}
            Lưu cấu hình
          </Button>
          <Button
            variant="outline"
            onClick={handleClear}
            disabled={busy || !saved.configured}
            className="min-h-11 gap-2 border-down/40 text-down hover:bg-down/10 hover:text-down"
            title="Xoá toàn bộ credentials VNDIRECT khỏi DB"
          >
            {update.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="size-4" aria-hidden="true" />
            )}
            Xoá cấu hình
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────── 2. Nguồn dữ liệu thị trường ─────────────────── */

const MODES: {
  id: MarketDataMode;
  title: string;
  description: string;
}[] = [
  {
    id: "real-eod",
    title: "EOD thật VNDIRECT (dchart)",
    description: "Bar lịch sử giá thật, tick trong phiên mô phỏng quanh mức tham chiếu thật",
  },
  {
    id: "realtime-vndirect",
    title: "Realtime VNDIRECT (finfo)",
    description: "Cần kết nối VNDIRECT phía trên. Tick trong phiên lấy giá thật từ finfo",
  },
  {
    id: "simulated",
    title: "Mô phỏng",
    description: "Toàn bộ giá mô phỏng (dev)",
  },
];

function MarketDataCard({ settings }: { settings: SettingsResponse }) {
  const apply = useApplyMarketDataMode();
  const [selected, setSelected] = React.useState<MarketDataMode | null>(null);

  const md = settings.marketData;
  const effectiveSelected = selected ?? md.mode;
  const fallbackActive = md.effectiveMode !== md.mode;

  function handleApply() {
    if (effectiveSelected === md.mode) return;
    apply.mutate(effectiveSelected);
  }

  function handleRadioKeyDown(e: React.KeyboardEvent, idx: number) {
    // WAI-ARIA radio: mũi tên di chuyển focus + chọn theo focus.
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "ArrowUp" && e.key !== "ArrowDown") {
      return;
    }
    e.preventDefault();
    const next = (idx + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1) + MODES.length) % MODES.length;
    setSelected(MODES[next].id);
    document.getElementById(`mode-${MODES[next].id}`)?.focus();
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="size-4 text-muted-foreground" aria-hidden="true" />
          Nguồn dữ liệu thị trường
        </CardTitle>
        <CardDescription>
          Chế độ feed giá cho bảng giá, biểu đồ &amp; chỉ báo — ghi đè env MARKET_DATA_MODE
        </CardDescription>
        {fallbackActive && (
          <CardAction>
            <Badge
              variant="outline"
              className="border-amber-500/40 text-amber-600 dark:text-amber-400"
            >
              Đang fallback: EOD thật
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div role="radiogroup" aria-label="Chế độ nguồn dữ liệu thị trường" className="flex flex-col gap-2.5">
          {MODES.map((mode, idx) => {
            const isSelected = effectiveSelected === mode.id;
            const isSaved = md.mode === mode.id;
            return (
              <div key={mode.id} className="flex flex-col gap-1">
                <button
                  type="button"
                  role="radio"
                  id={`mode-${mode.id}`}
                  aria-checked={isSelected}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => setSelected(mode.id)}
                  onKeyDown={(e) => handleRadioKeyDown(e, idx)}
                  className={cn(
                    "flex min-h-14 w-full flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition-colors sm:min-h-11 sm:flex-row sm:items-center sm:gap-3",
                    isSelected
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-accent"
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        isSelected ? "border-primary" : "border-muted-foreground/50"
                      )}
                      aria-hidden="true"
                    >
                      {isSelected && <span className="size-2 rounded-full bg-primary" />}
                    </span>
                    <span className="text-sm font-medium">{mode.title}</span>
                  </span>
                  <span className="pl-6 text-xs text-muted-foreground sm:pl-0">
                    {mode.description}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5 pl-6 sm:pl-0">
                    {mode.id === "real-eod" && isSaved && (
                      <Badge variant="secondary" className="text-[10px]">
                        Mặc định
                      </Badge>
                    )}
                    {mode.id === "realtime-vndirect" && !settings.vndirect.configured && (
                      <Badge variant="destructive" className="text-[10px]">
                        Chưa kết nối
                      </Badge>
                    )}
                    {mode.id === "realtime-vndirect" &&
                      settings.vndirect.configured &&
                      fallbackActive && (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400"
                        >
                          Fallback: EOD thật
                        </Badge>
                      )}
                    {isSaved && <span className="sr-only">(đang dùng)</span>}
                  </span>
                </button>
                {/* Giải thích realtime khi configured nhưng đang fallback */}
                {mode.id === "realtime-vndirect" &&
                  settings.vndirect.configured &&
                  fallbackActive && (
                    <p className="pl-6 text-xs text-muted-foreground sm:pl-7">
                      {md.realtimeOk == null
                        ? "Chưa có lần fetch realtime nào thành công"
                        : md.realtimeOk
                          ? `Lần fetch realtime cuối OK lúc ${formatDateTime(md.lastRealtimeAt)}`
                          : `Lần fetch realtime cuối lỗi lúc ${formatDateTime(md.lastRealtimeAt) ?? "—"} — tick đang dùng bar EOD thật quanh tham chiếu`}{" "}
                      — kiểm tra lại credentials phía trên.
                    </p>
                  )}
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={handleApply}
            disabled={apply.isPending || effectiveSelected === md.mode}
            className="min-h-11 gap-2"
          >
            {apply.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-4" aria-hidden="true" />
            )}
            Áp dụng
          </Button>
          <p className="text-xs text-muted-foreground">
            Hiện đang dùng:{" "}
            <span className="font-medium text-foreground">
              {MODES.find((m) => m.id === md.mode)?.title ?? md.mode}
            </span>
            {fallbackActive && " (fallback EOD thật)"}
          </p>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {md.strictSession && (
            <Badge variant="outline" className="text-[10px]">
              Phiên HOSE 09:15–15:00
            </Badge>
          )}
          <span>Đồng bộ EOD hằng ngày lúc {md.eodSyncAt || "15:45"} ICT</span>
          {md.realtimeOk != null && (
            <span className="flex items-center gap-1.5">
              <span
                className={cn("size-2 rounded-full", md.realtimeOk ? "bg-up" : "bg-down")}
                aria-hidden="true"
              />
              Realtime lần cuối {md.realtimeOk ? "OK" : "lỗi"}
              {md.lastRealtimeAt ? ` lúc ${formatDateTime(md.lastRealtimeAt)}` : ""}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────── 3. Mô hình AI & đội agent (read-only) ─────────────────── */

function LlmCard({ settings }: { settings: SettingsResponse }) {
  const llm = settings.llm;
  const risk = settings.risk;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Cpu className="size-4 text-muted-foreground" aria-hidden="true" />
          Mô hình AI &amp; đội agent
        </CardTitle>
        <CardDescription>Thông tin runtime — chỉ đọc</CardDescription>
        {llm.free && (
          <CardAction>
            <Badge variant="outline" className="border-up/40 text-up">
              Miễn phí
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
          <span className="font-medium">{llm.modelLabel}</span>
          <span className="font-mono text-xs text-muted-foreground">{llm.model}</span>
          {llm.runsOutsideSandbox && (
            <Badge variant="secondary" className="text-[10px]">
              Chạy được ngoài sandbox
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          23 agents · 5 nhóm · chu kỳ 6 đợt (nền tảng → nghiên cứu + học máy →
          kiểm soát VETO → Bộ tổng hợp Bayes → chủ tịch → thực thi)
        </p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-[11px] text-muted-foreground">Ngành tối đa</p>
            <p className="tabular-nums text-lg font-semibold">{pctFmt(risk.maxSectorWeightPct)}</p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-[11px] text-muted-foreground">Vị thế tối đa</p>
            <p className="tabular-nums text-lg font-semibold">{pctFmt(risk.maxPositionPct)}</p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-[11px] text-muted-foreground">Drawdown tối đa</p>
            <p className="tabular-nums text-lg font-semibold">{pctFmt(risk.maxDrawdownPct)}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "flex items-center gap-1.5",
              settings.bayes.enabled ? "text-up" : "text-muted-foreground"
            )}
          >
            <span
              className={cn("size-2 rounded-full", settings.bayes.enabled ? "bg-up" : "bg-muted-foreground")}
              aria-hidden="true"
            />
            Bộ tổng hợp Bayes {settings.bayes.enabled ? "bật" : "tắt"}
          </span>
          <span>
            Lần tổng hợp gần nhất:{" "}
            {settings.bayes.lastAssessmentAt
              ? formatDateTime(settings.bayes.lastAssessmentAt)
              : "chưa có"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────── Skeleton ─────────────────── */

function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Đang tải cấu hình">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {i === 0 ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, j) => (
                  <div key={j} className="flex flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-24" />
                    <Skeleton className="h-11 w-full" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                {Array.from({ length: 3 }).map((_, j) => (
                  <Skeleton key={j} className="h-14 w-full rounded-lg" />
                ))}
              </>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
