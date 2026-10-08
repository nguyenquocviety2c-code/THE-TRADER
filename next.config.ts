import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Phiên #57 — sandbox này truy cập dev server qua 127.0.0.1 (localhost
   * phân giải sang ::1 bị refused; market-engine + Agent Browser + curl đều
   * dùng 127.0.0.1). Next 16 mặc định CHẶN cross-origin dev resource (HMR)
   * từ origin ngoài localhost → client runtime chết (SSR shell không hydrate,
   * 0 API call — chẩn đoán #57). Cho phép 127.0.0.1 là official fix.
   */
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
