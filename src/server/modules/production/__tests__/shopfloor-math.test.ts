import { describe, it, expect } from "vitest";
import { Prisma } from "../../../../generated/prisma/client";
import { checkInvariants, jobCompletionBlockers, jobTotals, stageCompletionBlockers, startBlockers, totalsOf, type InspectionRow, type OutputRow, type StageState } from "../shopfloor-math";

const D = (v: number | string) => new Prisma.Decimal(v);
const row = (o: Partial<Record<keyof Omit<OutputRow, "jobStageId">, number>> & { stage?: string | null }): OutputRow => ({
  jobStageId: o.stage ?? "s1",
  goodQty: D(o.goodQty ?? 0),
  scrapQty: D(o.scrapQty ?? 0),
  reworkQty: D(o.reworkQty ?? 0),
  reworkGoodQty: D(o.reworkGoodQty ?? 0),
  reworkScrapQty: D(o.reworkScrapQty ?? 0),
  reclassifiedFromGoodQty: D(o.reclassifiedFromGoodQty ?? 0),
});
const ins = (o: { stage?: string; inspected: number; rejected?: number; dispositioned?: number }): InspectionRow => ({
  jobStageId: o.stage ?? "s1",
  producedQty: D(o.inspected),
  acceptedQty: D(o.inspected - (o.rejected ?? 0)),
  rejectedQty: D(o.rejected ?? 0),
  dispositionedQty: D(o.dispositioned ?? 0),
});
const stage = (o: Partial<StageState> = {}): StageState => ({ id: "s1", sequence: 1, name: "Weld", status: "in_progress", blocked: false, requiresInspection: false, ...o });

describe("totalsOf", () => {
  it("nets reclassification out of good and tracks open rework and yield", () => {
    const t = totalsOf([row({ goodQty: 10, scrapQty: 2, reworkQty: 3 }), row({ goodQty: 2, reworkGoodQty: 2 }), row({ scrapQty: 1, reclassifiedFromGoodQty: 1 })]);
    expect(t).toMatchObject({ grossGood: "12", effectiveGood: "11", scrap: "3", rework: "3", reworkOpen: "1", processed: "18" });
    expect(t.yieldPercent).toBe("61.1");
  });
  it("yield is null (not 0%) when nothing was processed", () => {
    expect(totalsOf([]).yieldPercent).toBeNull();
  });
  it("is exact on fractional quantities", () => {
    expect(totalsOf([row({ goodQty: 0.1 }), row({ goodQty: 0.2 })]).grossGood).toBe("0.3");
  });
});

describe("checkInvariants", () => {
  it("accepts consistent records", () => {
    expect(checkInvariants([row({ goodQty: 5, reworkQty: 2 }), row({ goodQty: 2, reworkGoodQty: 2 })], [ins({ inspected: 5 })])).toEqual([]);
  });
  it("flags more rework resolved than sent, more reclassified than good, and over-inspection", () => {
    expect(checkInvariants([row({ goodQty: 1, reworkGoodQty: 1 })], [])[0]).toMatch(/resolved from rework/);
    expect(checkInvariants([row({ scrapQty: 5, reclassifiedFromGoodQty: 5 })], [])[0]).toMatch(/reclassified/);
    expect(checkInvariants([row({ goodQty: 4 })], [ins({ inspected: 5 })])[0]).toMatch(/inspected than were reported good/);
  });
  it("judges each stage on its own", () => {
    expect(checkInvariants([row({ stage: "a", goodQty: 5 }), row({ stage: "b", goodQty: 1 })], [ins({ stage: "b", inspected: 3 })])).toHaveLength(1);
  });
});

describe("stage rules", () => {
  it("start: only a pending stage, only after all earlier stages complete", () => {
    const all = [stage({ id: "a", sequence: 1, status: "in_progress" }), stage({ id: "b", sequence: 2, status: "pending", name: "Paint" })];
    expect(startBlockers(all[1], all)[0]).toMatch(/must be completed first/);
    expect(startBlockers(stage({ status: "completed" }), [stage()])[0]).toMatch(/already been completed/);
    expect(startBlockers(stage({ status: "pending" }), [stage({ status: "pending" })])).toEqual([]);
  });
  it("complete: needs output, no open rework, no open rejects, and inspection when required", () => {
    expect(stageCompletionBlockers(stage(), [], []).join()).toMatch(/No output/);
    const good = [row({ goodQty: 10 })];
    expect(stageCompletionBlockers(stage(), good, [])).toEqual([]);
    expect(stageCompletionBlockers(stage({ requiresInspection: true }), good, []).join()).toMatch(/requires an inspection/);
    expect(stageCompletionBlockers(stage({ requiresInspection: true }), good, [ins({ inspected: 6 })]).join()).toMatch(/4 good unit/);
    expect(stageCompletionBlockers(stage({ requiresInspection: true }), good, [ins({ inspected: 10, rejected: 3, dispositioned: 1 })]).join()).toMatch(/2 rejected unit/);
    expect(stageCompletionBlockers(stage(), [row({ goodQty: 5, reworkQty: 2 })], []).join()).toMatch(/2 unit\(s\) are still in rework/);
    expect(stageCompletionBlockers(stage({ blocked: true }), good, []).join()).toMatch(/blocked/);
  });
  it("job: every stage completed, no open rework or rejects; no stages and no records means ready", () => {
    expect(jobCompletionBlockers([], [], [])).toEqual([]);
    expect(jobCompletionBlockers([stage({ status: "pending" })], [], []).join()).toMatch(/not completed/);
    expect(jobCompletionBlockers([stage({ status: "completed" })], [row({ goodQty: 1, reworkQty: 1 })], [ins({ inspected: 1, rejected: 1 })])).toHaveLength(2);
  });
});

describe("jobTotals (units pass through every stage)", () => {
  const stages = [
    { id: "a", sequence: 1, status: "completed" },
    { id: "b", sequence: 2, status: "completed" },
  ];
  it("good output is the last stage's; scrap sums; yield only once every stage is complete", () => {
    const rows = [row({ stage: "a", goodQty: 9, scrapQty: 1 }), row({ stage: "b", goodQty: 7, scrapQty: 2 })];
    expect(jobTotals(stages, rows)).toMatchObject({ effectiveGood: "7", grossGood: "7", scrap: "3", processed: "10", yieldPercent: "70" });
    expect(jobTotals([stages[0]!, { ...stages[1]!, status: "in_progress" }], rows).yieldPercent).toBeNull();
  });
  it("without stages it is just the sum", () => {
    expect(jobTotals([], [row({ stage: null, goodQty: 5 }), row({ stage: null, goodQty: 3 })]).effectiveGood).toBe("8");
  });
});

describe("stage-flow invariant", () => {
  const order = [{ id: "a", sequence: 1, name: "Cut" }, { id: "b", sequence: 2, name: "Weld" }];
  it("a stage can't account for more units than left the previous one", () => {
    const ok = [row({ stage: "a", goodQty: 8, scrapQty: 2 }), row({ stage: "b", goodQty: 6, scrapQty: 2 })];
    expect(checkInvariants(ok, [], order)).toEqual([]);
    const bad = [row({ stage: "a", goodQty: 8 }), row({ stage: "b", goodQty: 9 })];
    expect(checkInvariants(bad, [], order)[0]).toMatch(/Weld.*9.*only 8 left "Cut"/);
  });
  it("units in rework count once, so a rework loop is not double-counted", () => {
    const rows = [row({ stage: "a", goodQty: 8 }), row({ stage: "b", goodQty: 5, reworkQty: 3 }), row({ stage: "b", goodQty: 3, reworkGoodQty: 3 })];
    expect(checkInvariants(rows, [], order)).toEqual([]); // 8 good at Weld = 8 that left Cut
  });
  it("is not applied when no routing is supplied", () => {
    expect(checkInvariants([row({ stage: "b", goodQty: 99 })], [])).toEqual([]);
  });
});
