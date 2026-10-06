"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiGet } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { AssessmentResponse, MarketAssessmentView } from "@/lib/types";

/**
 * Phiên #34 — data hooks cho module "Bộ tổng hợp Bayes" (workspace synthesis).
 *
 * - useAssessment: GET /api/assessment (bản mới nhất + lịch sử 30 bản).
 * - useSynthesizeNow: POST /api/assessment/synthesize — chạy lại thuật toán
 *   định lượng thuần (0 chi phí LLM), invalidate cache ["assessment"].
 *
 * API có thể chưa sẵn sàng (backend chạy song song) — mọi lỗi nổi thành
 * Error tiếng Việt để component render error state thay vì crash.
 */

/** Dùng chung cho mọi query assessment trên UI. */
export const ASSESSMENT_QUERY_KEY = ["assessment"] as const;

export function useAssessment() {
  return useQuery({
    queryKey: ASSESSMENT_QUERY_KEY,
    queryFn: () => apiGet<AssessmentResponse>("/api/assessment"),
    staleTime: 30_000,
  });
}

/**
 * POST /api/assessment/synthesize trả về bản assessment mới — tolerant cả 2
 * shape { assessment } lẫn trả thẳng view (hợp đồng types.ts chỉ chốt GET).
 */
function normalizeAssessment(data: unknown): MarketAssessmentView | null {
  if (data == null) return null;
  if (typeof data === "object" && "assessment" in data) {
    const inner = (data as { assessment?: unknown }).assessment;
    return (inner ?? null) as MarketAssessmentView | null;
  }
  return data as MarketAssessmentView;
}

export function useSynthesizeNow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<MarketAssessmentView | null> => {
      const res = await fetch("/api/assessment/synthesize", { method: "POST" });
      const data = (await res.json().catch(() => null)) as
        | (Record<string, unknown> & { error?: string; retryAfterSeconds?: number })
        | null;
      if (!res.ok || data == null) {
        if (res.status === 429) {
          const secs =
            typeof data?.retryAfterSeconds === "number" && data.retryAfterSeconds > 0
              ? data.retryAfterSeconds
              : 60;
          throw new Error(
            `${(data?.error as string) ?? "Đang bị giới hạn tần suất."} Thử lại sau khoảng ${Math.ceil(secs)} giây.`
          );
        }
        throw new Error((data?.error as string) ?? `Tổng hợp thất bại (${res.status})`);
      }
      return normalizeAssessment(data);
    },
    onSuccess: (assessment) => {
      void queryClient.invalidateQueries({ queryKey: ASSESSMENT_QUERY_KEY });
      toast.success("Đã tổng hợp lại nhận định thị trường", {
        description: assessment
          ? `Bản mới nhất lúc ${formatDateTime(assessment.createdAt)} · ${assessment.evidenceCount} bằng chứng`
          : "Thuật toán định lượng — 0 chi phí LLM",
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Không tổng hợp được nhận định.");
    },
  });
}
