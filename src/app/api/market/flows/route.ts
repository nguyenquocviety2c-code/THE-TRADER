import { NextResponse } from "next/server";
import { getForeignFlows } from "@/lib/flows";
import { toPlain } from "@/lib/serialize";

export const dynamic = "force-dynamic";

/**
 * GET /api/market/flows — S6 dòng khối ngoại ròng (DATA_SOURCES.md §4.4).
 * Trả về mode "live" | "simulated" để UI/phía agent khai báo rõ nguồn.
 */
export async function GET() {
  try {
    const flows = await getForeignFlows();
    return NextResponse.json(toPlain(flows));
  } catch (err) {
    console.error("[api/market/flows]", err);
    return NextResponse.json(
      { error: "Không tải được dòng khối ngoại." },
      { status: 500 }
    );
  }
}
