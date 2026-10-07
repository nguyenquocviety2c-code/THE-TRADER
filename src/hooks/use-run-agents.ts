"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiPost } from "@/lib/api";
import type { RunCycleResponse } from "@/lib/types";

/**
 * Mutation key CHIA SẺ — dùng kèm useIsMutating({ mutationKey }) để mọi nơi
 * (vd AgentsPanel) đếm được chu kỳ đang chạy dù nút chạy nằm ở Header
 * (phiên #47 — nút "Chạy agent" trên thanh bar trên cùng là DUY NHẤT).
 */
export const RUN_AGENTS_MUTATION_KEY = ["run-agents-cycle"] as const;

/**
 * Shared mutation for POST /api/agents/run (the full multi-agent cycle).
 * Used by the Header button, so the "running" state and the invalidations
 * stay consistent everywhere.
 */
export function useRunAgents() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: RUN_AGENTS_MUTATION_KEY,
    mutationFn: () => apiPost<RunCycleResponse>("/api/agents/run"),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["agent-messages"] });
      void queryClient.invalidateQueries({ queryKey: ["signals"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      void queryClient.invalidateQueries({ queryKey: ["quotes"] });
      void queryClient.invalidateQueries({ queryKey: ["risk-alerts"] });
      // Phiên #34: chu kỳ chạy đợt Bộ tổng hợp Bayes giữa Control & Chủ tịch —
      // làm mới nhận định thị trường sau mỗi chu kỳ.
      void queryClient.invalidateQueries({ queryKey: ["assessment"] });

      const secs = res.durationMs ? (res.durationMs / 1000).toFixed(1) : null;
      const signal = res.signals?.[0];
      const order = res.order;
      toast.success("Agent đã hoàn tất phân tích", {
        description: [
          `${res.messages?.length ?? 0} tin nhắn agent`,
          signal ? `Tín hiệu ${signal.direction} ${signal.symbol}` : null,
          order ? `Lệnh ${order.side === "BUY" ? "MUA" : "BÁN"} ${order.quantity.toLocaleString("vi-VN")} cp` : null,
          secs ? `${secs}s` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      });
    },
    onError: (err: Error) => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.error(err.message || "Chu kỳ phân tích thất bại.");
    },
  });
}
