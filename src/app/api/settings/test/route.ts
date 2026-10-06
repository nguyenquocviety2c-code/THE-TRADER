import { NextResponse } from "next/server";
import type { VndirectCreds } from "@/lib/vndirect";
import { testVndirect } from "@/lib/vndirect";
import { getVndirectSettings, updateVndirectTestResult } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/settings/test — kiểm tra kết nối VNDIRECT (Phiên #34).
 *
 * Body { vndirect?: Partial<VndirectCreds> }: field nào trong body KHÁC RỖNG
 * thì thắng giá trị đã lưu (merge — cho phép test key mới mà chưa lưu);
 * body rỗng/thiếu vndirect → test bằng creds ĐÃ LƯU. Khi test bằng creds đã
 * lưu → ghi lastTestAt/lastTestOk/lastTestMessage vào AppSetting; khi test
 * creds mới chưa lưu → KHÔNG đè kết quả test của creds đã lưu.
 */

const CRED_FIELDS = ["consumerKey", "consumerSecret", "accessToken", "accountNumber"] as const;

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = (await req.json().catch(() => null)) as
      | { vndirect?: Partial<Record<(typeof CRED_FIELDS)[number], unknown>> }
      | null;

    const saved = await getVndirectSettings();

    // Merge: body field (chuỗi khác rỗng, không phải giá trị masked) thắng saved
    const merged: VndirectCreds = {
      consumerKey: saved.consumerKey,
      consumerSecret: saved.consumerSecret,
      accessToken: saved.accessToken,
      accountNumber: saved.accountNumber,
    };
    let usedBodyCreds = false;
    const patchVnd = body?.vndirect;
    if (patchVnd && typeof patchVnd === "object") {
      for (const field of CRED_FIELDS) {
        const v = patchVnd[field];
        if (typeof v !== "string") continue;
        const clean = v.trim();
        if (clean === "" || v.includes("····")) continue;
        merged[field] = clean;
        usedBodyCreds = true;
      }
    }

    const result = await testVndirect(merged);

    // Chỉ ghi nhận kết quả test khi chạy bằng creds ĐÃ LƯU
    if (!usedBodyCreds) {
      await updateVndirectTestResult(result.ok, result.message);
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[api/settings/test]", err);
    return NextResponse.json(
      { error: "Kiểm tra kết nối VNDIRECT thất bại." },
      { status: 500 }
    );
  }
}
