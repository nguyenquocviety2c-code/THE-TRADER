#!/usr/bin/env node
/**
 * tools/db-console.mjs — Chạy 1 câu SQL (read-mostly) qua Supabase Management API
 * Nguồn thiết kế: docs/DB_SCHEMA.md §12 (checklist S1–S12) · TB §3.4
 *
 * Cách chạy:
 *   node tools/db-console.mjs "select count(*) from public.symbols"
 *   node tools/db-console.mjs --file path/to/query.sql
 *
 * ⚠️ KHÔNG in secrets. Dùng cho ops/verify — migration chính thức vẫn qua apply-migrations.mjs.
 * Env cần: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF (trong .env)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) throw new Error('Không tìm thấy .env');
  const env = {};
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const REF = env.SUPABASE_PROJECT_REF;
const TOKEN = env.SUPABASE_ACCESS_TOKEN;
if (!REF || !TOKEN) {
  console.error('❌ Thiếu SUPABASE_PROJECT_REF hoặc SUPABASE_ACCESS_TOKEN trong .env');
  process.exit(1);
}
const API = `https://api.supabase.com/v1/projects/${REF}/database/query`;

async function runSql(query) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}:\n${text.slice(0, 1500)}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

async function main() {
  const arg = process.argv[2] || '';
  if (!arg) {
    console.error('Cách dùng: node tools/db-console.mjs "<sql>" | --file <path.sql>');
    process.exit(1);
  }
  const sql = arg === '--file' ? readFileSync(process.argv[3], 'utf8') : arg;
  const rows = await runSql(sql);
  if (Array.isArray(rows)) {
    console.table ? console.table(rows) : console.log(rows);
    if (!rows.length) console.log('(0 dòng)');
  } else {
    console.log(rows);
  }
}

main().catch((err) => { console.error(String(err).slice(0, 2000)); process.exit(1); });
