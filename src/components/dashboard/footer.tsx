"use client";

import { ExternalLink, FileText } from "lucide-react";

export function Footer() {
  return (
    <footer className="mt-auto border-t bg-background/60">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col items-center justify-between gap-2 px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] text-center text-xs text-muted-foreground sm:flex-row sm:px-6 sm:text-left">
        <p>
          The Trader — Hệ thống giao dịch đa tác tử · VNDIRECT · Chỉ dùng cho mục
          đích minh họa
        </p>
        <nav aria-label="Liên kết chân trang" className="flex items-center gap-4">
          <a
            href="https://www.vndirect.com.vn"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1 transition-colors hover:text-foreground sm:min-h-0"
          >
            <ExternalLink className="size-3" aria-hidden="true" />
            VNDIRECT
          </a>
          <a
            href="#"
            className="inline-flex min-h-11 items-center gap-1 transition-colors hover:text-foreground sm:min-h-0"
            onClick={(e) => e.preventDefault()}
          >
            <FileText className="size-3" aria-hidden="true" />
            Tài liệu hệ thống
          </a>
        </nav>
      </div>
    </footer>
  );
}
