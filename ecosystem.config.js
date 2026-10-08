// PM2 ecosystem — The Trader
// Duy trì dev server Next.js (port 3000) + market-engine mini-service (port 3003).
//
// Khởi động :  pm2 start ecosystem.config.js && pm2 save
// Kiểm tra  :  pm2 list · pm2 logs the-trader
// Dừng      :  pm2 stop all && pm2 kill
//
// LƯU Ý env: shell sandbox có thể nhiễm DATABASE_URL cũ (sqlite) — file này
// tự đọc .env của project lúc nạp và TRUYỀN XUỐNG đè biến nhiễm, đảm bảo app
// luôn dùng đúng database (Supabase postgres) bất kể môi trường shell.
//
// File CJS theo mặc định PM2 (package.json không khai báo "type": "module")
// — tắt rule require của eslint cho đúng ngữ cảnh công cụ.

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");

function parseEnv(path) {
  const out = {};
  if (!fs.existsSync(path)) return out;
  for (const raw of fs.readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

// Env thật của app — đọc từ .env (không hardcode secret vào file này)
const appEnv = parseEnv("/home/z/my-project/.env");

module.exports = {
  apps: [
    {
      name: "the-trader",
      cwd: "/home/z/my-project",
      script: "/usr/local/bin/bun",
      args: "run dev", // next dev → port 3000 (Turbopack, HMR)
      watch: false, // next dev tự HMR, PM2 chỉ canh crash
      autorestart: true,
      max_restarts: 50,
      min_uptime: "15s",
      restart_delay: 3000,
      kill_timeout: 8000,
      merge_logs: true,
      output: "/home/z/my-project/dev.log",
      error: "/home/z/my-project/dev.log",
      env: appEnv, // đè mọi biến nhiễm bằng giá trị .env chuẩn
    },
    {
      name: "market-engine",
      cwd: "/home/z/my-project/mini-services/market-engine",
      script: "/usr/local/bin/bun",
      args: "--hot index.ts", // hot-reload khi sửa file + PM2 canh crash
      watch: false,
      autorestart: true,
      max_restarts: 50,
      min_uptime: "15s",
      restart_delay: 3000,
      kill_timeout: 8000,
      merge_logs: true,
      output: "/home/z/my-project/dev-engine.log",
      error: "/home/z/my-project/dev-engine.log",
      env: {
        // engine gọi app qua gateway nội bộ — mặc định an toàn, không cần .env
        APP_URL: "http://127.0.0.1:3000",
      },
    },
  ],
};
