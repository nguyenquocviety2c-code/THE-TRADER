"use client";

import * as React from "react";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            // Perf #64 — staleTime 15s → 30s: mọi dialog/card mở LẠI trong 30s
            // render tức thì từ cache (0 network); dữ liệu nóng (bảng giá) vẫn
            // realtime qua WS push use-realtime ghi thẳng setQueryData — không
            // phụ thuộc staleTime; dữ liệu chu kỳ agent được invalidate chủ động
            // qua sự kiện WS "cycle". stale chỉ quyết định "mở lại có refetch
            // nền hay không" — không ảnh hưởng độ tươi của dữ liệu đang hiện.
            staleTime: 30_000,
            // gcTime 5 phút: query unmount (đóng dialog/đổi tab) vẫn giữ cache
            // — mở lại tab sau vài phút vẫn instant + refetch nền.
            gcTime: 300_000,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem={false}
        disableTransitionOnChange
      >
        {children}
      </ThemeProvider>
    </QueryClientProvider>
  );
}
