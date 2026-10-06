"use client";

import { PortfolioSection } from "@/components/dashboard/portfolio-section";

/**
 * Phiên #34 — workspace "Danh mục": tách khỏi module Tổng quan cũ.
 * Component PortfolioSection giữ nguyên — chỉ bọc tabpanel + tiêu đề.
 */
export function PortfolioWorkspace() {
  return (
    <div
      role="tabpanel"
      id="workspace-panel-portfolio"
      aria-labelledby="workspace-tab-portfolio"
      className="flex flex-col gap-6"
    >
      <h2 className="sr-only">Danh mục — tài khoản, vị thế, lệnh &amp; giao dịch</h2>
      <PortfolioSection />
    </div>
  );
}
