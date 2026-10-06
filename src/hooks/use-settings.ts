"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiGet, apiPostJson } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type {
  MarketDataMode,
  SettingsResponse,
  SettingsTestResponse,
  UpdateSettingsPayload,
  VndirectSettings,
} from "@/lib/types";

/**
 * Phiên #34 — data hooks cho module "Cài đặt" (workspace settings).
 *
 * - useSettings: GET /api/settings (đã mask secrets).
 * - useUpdateSettings: PUT /api/settings — chỉ gửi field người dùng nhập;
 *   chuỗi rỗng "" nghĩa là xoá field đó.
 * - useTestConnection: POST /api/settings/test — body là credentials đang
 *   nhập trong form (nếu có) hoặc creds đã lưu (body rỗng).
 *
 * API có thể chưa sẵn sàng (backend chạy song song) — lỗi nổi thành Error
 * tiếng Việt, UI render error state thay vì crash.
 */

export const SETTINGS_QUERY_KEY = ["settings"] as const;

/** PUT JSON — api.ts chỉ có GET/POST nên tự viết helper nội bộ. */
async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || data == null) {
    throw new Error(data?.error ?? `Yêu cầu thất bại (${res.status})`);
  }
  return data;
}

export function useSettings() {
  return useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => apiGet<SettingsResponse>("/api/settings"),
    staleTime: 30_000,
  });
}

/** PUT /api/settings — invalidate + toast thành công/thất bại ở nơi gọi. */
export function useUpdateSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: UpdateSettingsPayload) =>
      apiPut<SettingsResponse>("/api/settings", payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    },
  });
}

/**
 * POST /api/settings/test. Truyền creds form đang nhập (nếu ít nhất 1 field
 * khác rỗng) — ngược lại gửi body rỗng để backend dùng creds đã lưu.
 */
export function useTestConnection() {
  return useMutation({
    mutationFn: (creds: Partial<VndirectSettings> | null) =>
      apiPostJson<SettingsTestResponse>(
        "/api/settings/test",
        creds && Object.values(creds).some((v) => v != null && v !== "")
          ? { vndirect: creds }
          : {}
      ),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success("Kết nối VNDIRECT hoạt động", {
          description: `${res.message} · ${res.details.latencyMs}ms`,
        });
      } else {
        toast.error("Kiểm tra kết nối thất bại", { description: res.message });
      }
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không kiểm tra được kết nối.");
    },
  });
}

/** Caption "Lần tổng hợp gần nhất" cho card AI (null-safe). */
export function formatLastAssessmentAt(iso: string | null | undefined): string {
  if (!iso) return "Chưa có lần tổng hợp nào";
  return `Lần tổng hợp gần nhất: ${formatDateTime(iso)}`;
}

/** Chọn mode dữ liệu thị trường — PUT marketData.mode + toast. */
export function useApplyMarketDataMode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (mode: MarketDataMode) =>
      apiPut<SettingsResponse>("/api/settings", { marketData: { mode } }),
    onSuccess: (res, mode) => {
      void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      const label =
        mode === "real-eod"
          ? "EOD thật VNDIRECT (dchart)"
          : mode === "realtime-vndirect"
            ? "Realtime VNDIRECT (finfo)"
            : "Mô phỏng";
      toast.success("Đã áp dụng nguồn dữ liệu thị trường", {
        description: `${label}${res.marketData.effectiveMode !== mode ? " · hiện đang fallback về EOD thật" : ""}`,
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không áp dụng được nguồn dữ liệu.");
    },
  });
}
