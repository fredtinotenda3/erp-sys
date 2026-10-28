import { NextRequest } from "next/server";
import { listJobCosts } from "../../../../../../src/server/modules/costing/cost-service";
import { requireSession } from "../../../../../../src/server/modules/iam/session-guard";
import { errorResponse } from "../../../../../../src/server/shared/http";
import { csvResponse, toCsv } from "../../../../../../lib/csv";

// CSV of exactly what the job-costs report API returns; the service enforces production_job:read,
// cost:read and branch scope, so the export can never show more than the screen.
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession(req);
    const p = req.nextUrl.searchParams;
    const jobs = (await listJobCosts(session, { branchId: p.get("branchId") ?? undefined, status: p.get("status") ?? undefined, limit: 500 })) as Awaited<ReturnType<typeof listJobCosts>>;
    const rows = jobs.flatMap((j) =>
      j.lines.length === 0
        ? [[j.jobNumber, j.status, j.actualBasis, "", "", "", "", ""]]
        : j.lines.map((l) => [j.jobNumber, j.status, j.actualBasis, l.currency, l.estimated.material, l.actual.material, l.variance.material, l.actual.labour]),
    );
    return csvResponse("job-costs.csv", toCsv(["Job", "Status", "Actual basis", "Currency", "Estimated material", "Actual material", "Material variance (actual - estimate)", "Actual labour"], rows));
  } catch (err) {
    return errorResponse(err);
  }
}
