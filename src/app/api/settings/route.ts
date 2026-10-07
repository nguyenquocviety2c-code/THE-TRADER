import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AGENT_ROSTER } from "@/lib/agent-roster";
import { llmStatus } from "@/lib/llm";
import type { SettingsResponse, UpdateSettingsPayload } from "@/lib/types";
import {
  getEffectiveMode,
  getVndirectSettings,
  isMarketDataMode,
  isVndirectConfigured,
  maskSecret,
  saveVndirectSettings,
  setMarketDataMode,
} from "@/lib/settings";
import { resetRiskQuantLimits } from "@/lib/risk/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET/PUT /api/settings — module Cài đặt (Phiên #34).
 *
 * GET: trả SettingsResponse — secret VNDIRECT đã mask (4 ký tự đầu + "·"×8;
 * accountNumber là định danh hiển thị nên KHÔNG che), mode dữ liệu hiệu lực,
 * trạng thái LLM/rủi ro/Bayes.
 *
 * PUT: body UpdateSettingsPayload — omit = giữ nguyên, "" = xoá (xem
 * lib/settings.ts); validate mode ∈ {real-eod, realtime-vndirect, simulated}.
 * Đổi sang realtime-vndirect khi chưa configured vẫn lưu — response trả về
 * effectiveMode "real-eod" kèm realtimeOk để UI cảnh báo.
 */

async function buildSettingsResponse(): Promise<SettingsResponse> {
  const [vndirect, eff, lastAssessment] = await Promise.all([
    getVndirectSettings(),
    getEffectiveMode(),
    db.marketAssessment
      .findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } })
      .catch(() => null),
  ]);

  // Risk limits — config của risk-manager (A6, có đủ 3 hạn mức), exposure (A7)
  // bổ sung sector/position khi risk-manager thiếu.
  const riskManager = AGENT_ROSTER.find((a) => a.code === "risk-manager")?.config ?? {};
  const exposure = AGENT_ROSTER.find((a) => a.code === "exposure")?.config ?? {};
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  return {
    vndirect: {
      consumerKey: maskSecret(vndirect.consumerKey),
      consumerSecret: maskSecret(vndirect.consumerSecret),
      accessToken: maskSecret(vndirect.accessToken),
      accountNumber: vndirect.accountNumber,
      configured: isVndirectConfigured(vndirect),
      lastTestAt: vndirect.lastTestAt,
      lastTestOk: vndirect.lastTestOk,
      lastTestMessage: vndirect.lastTestMessage,
    },
    marketData: {
      mode: eff.mode,
      effectiveMode: eff.effectiveMode,
      strictSession: process.env.MARKET_STRICT_SESSION !== "false",
      eodSyncAt: process.env.EOD_SYNC_AT ?? "15:45",
      realtimeOk: eff.realtimeOk,
      lastRealtimeAt: eff.lastRealtimeAt,
    },
    llm: llmStatus(),
    risk: {
      maxSectorWeightPct: num(
        riskManager.maxSectorWeightPct ?? exposure.maxSectorWeightPct,
        40
      ),
      maxPositionPct: num(riskManager.maxPositionPct ?? exposure.maxPositionPct, 25),
      maxDrawdownPct: num(riskManager.maxDrawdownPct, 15),
    },
    bayes: {
      enabled: true,
      lastAssessmentAt: lastAssessment?.createdAt?.toISOString() ?? null,
    },
    updatedAt: new Date().toISOString(),
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await buildSettingsResponse());
  } catch (err) {
    console.error("[api/settings:GET]", err);
    return NextResponse.json(
      { error: "Không tải được cài đặt hệ thống." },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => null)) as UpdateSettingsPayload | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Payload không hợp lệ — cần object JSON { vndirect?, marketData? }." },
        { status: 400 }
      );
    }

    // Validate TRƯỚC khi lưu (trạng thái không đổi khi có lỗi)
    const mode = body.marketData?.mode;
    if (mode !== undefined && !isMarketDataMode(mode)) {
      return NextResponse.json(
        {
          error:
            "Chế độ dữ liệu không hợp lệ — phải là real-eod | realtime-vndirect | simulated.",
        },
        { status: 400 }
      );
    }
    const vnd = body.vndirect;
    if (vnd && typeof vnd !== "object") {
      return NextResponse.json(
        { error: "Trường vndirect phải là object { consumerKey?, consumerSecret?, accessToken?, accountNumber? }." },
        { status: 400 }
      );
    }

    if (mode !== undefined) {
      await setMarketDataMode(mode);
    }
    if (vnd) {
      await saveVndirectSettings(vnd);
    }
    // Phiên #51 — CRB-7: nút reset thủ công Beta limit-learning (nghiệm thu
    // CRB-7.4) — prior Beta(1,99), ghi AuditLog minh bạch.
    if (body.riskQuantReset === true) {
      await resetRiskQuantLimits();
    }

    return NextResponse.json(await buildSettingsResponse());
  } catch (err) {
    console.error("[api/settings:PUT]", err);
    return NextResponse.json(
      { error: "Lưu cài đặt thất bại." },
      { status: 500 }
    );
  }
}
