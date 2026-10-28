import { NextRequest } from "next/server";
import { getProfitabilityReport } from "../../../../../../src/server/modules/costing/cost-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";
import { csvResponse, toCsv } from "../../../../../../lib/csv";

// Same data and permissions as GET /api/v1/reports/profitability. "Revenue" is the job's QUOTE, and
// profit excludes overhead; both are stated in the header so a spreadsheet can't mislabel them.
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const report = await getProfitabilityReport(session, {
      from: p.get("from") ?? undefined,
      to: p.get("to") ?? undefined,
      branchId: p.get("branchId") ?? undefined,
      customerId: p.get("customerId") ?? undefined,
      productItemId: p.get("productItemId") ?? undefined,
    });
    const rows = report.rows.map((r) => {
      const pr = r.profit;
      return [
        r.jobNumber,
        r.completedAt ? new Date(r.completedAt).toISOString().slice(0, 10) : "",
        r.product.sku,
        r.product.name,
        "customer" in r ? (r.customer?.name ?? "") : "",
        pr.available ? pr.currency : "",
        pr.available ? pr.revenue : "",
        pr.available ? pr.actualCost : "",
        pr.available ? pr.grossProfit : "",
        pr.available ? (pr.marginPercent ?? "") : "",
        pr.available ? "" : pr.reason,
        r.adjusted ? "yes" : "no",
      ];
    });
    return csvResponse("profitability.csv", toCsv(["Job", "Completed", "SKU", "Product", "Customer", "Currency", "Quoted amount (not recognised revenue)", "Actual cost (excl. overhead)", "Gross profit (excl. overhead)", "Margin %", "Why profit is unavailable", "Cost corrected by adjustment"], rows));
  } catch (err) {
    return errorResponse(err);
  }
}
