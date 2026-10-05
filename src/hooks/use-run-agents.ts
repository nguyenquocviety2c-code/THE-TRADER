"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiPost } from "@/lib/api";
import type { RunCycleResponse } from "@/lib/types";

/**
 * Shared mutation for POST /api/agents/run (the full multi-agent cycle).
 * Used by both the Header button and the Agents panel, so the
 * "running" state and the invalidations stay consistent everywhere.
 */
export function useRunAgents() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => apiPost<RunCycleResponse>("/api/agents/run"),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["agent-messages"] });
      void queryClient.invalidateQueries({ queryKey: ["signals"] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      void queryClient.invalidateQueries({ queryKey: ["quotes"] });
      void queryClient.invalidateQueries({ queryKey: ["risk-alerts"] });

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
