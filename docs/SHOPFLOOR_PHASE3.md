# Operis Phase 3 — Shop-Floor Execution and Quality Control

## What was audited (and reused)
`production_job_stage`, `quality_record`, `production_stage_template` and the capabilities `stage:transition`, `quality:record`, `quality:read` already existed as **scaffolding with no service, route or UI**. The docs promised "a job cannot complete until its stages are done" but nothing enforced it. Labour is not stage-linked; `finished_goods_receipt` stock posting is unused. Phase 3 evolves those tables instead of creating parallel ones, reuses `findJobInScope` (org + branch scope), `recordAudit`, the Phase 2 job-open trigger and advisory-lock scheme, and the Phase 2 snapshot and adjustment mechanisms.

## Model
- **Stages** (`production_job_stage`): sequence, name, planned start/end, actual start/complete, work centre (free text; no work-centre master data), responsible operator, notes, `requires_inspection`, blocked reason. Strictly sequential. `pending -> in_progress -> completed` only; completed is final (DB trigger). A stage completes only with recorded output, no units left in rework, no undecided rejects, and — if flagged — an inspection covering every good unit. "Delayed" is derived (past planned end, not completed), never stored.
- **Output** (`production_output`, append-only): good / scrap / rework (+ `rework_good`, `rework_scrap` to close the rework loop), in the **product's own unit of measure** (a different explicit unit is rejected), idempotent via `clientRequestId`. Scrap/rework need a reason. Mistakes are reversed with a reasoned **void** (`production_output_void`, `production_job:update`), never edited.
- **Quality** (`quality_record` evolved into the inspection result, append-only): inspected / accepted / rejected, defect category, notes, evidence reference, inspector, time. Outcome pass iff nothing rejected. "Pending" is derived (a stage needing inspection with uninspected good units), not stored. **Dispositions** (`quality_disposition`, append-only, `quality:approve` only): scrap, rework or use-as-is (a recorded concession). Scrap/rework create a system output entry so quantities stay in one ledger.
- **Accounting rules** (`shopfloor-math.ts`, pure and unit-tested): effective good = good − reclassified; rework open = sent − returned good − returned scrap. With stages, **job-level good output is what left the last stage** (units pass through every stage, so stage goods are not summed), scrap sums, yield is stated only when every stage is complete, and a stage cannot account for more units than left the stage before it.
- **Capabilities added:** `output:record` (Owner, Ops, Production Manager, Operator) and `quality:approve` (Owner, Ops, Production Manager — *not* Operator). Nothing existing changed.

## Lifecycle and integrity
- Job completion now runs a readiness check **inside the Phase 2 completion transaction, under the job's exclusive lock**: every stage completed, no open rework, no undecided rejects. Jobs that use none of this are unaffected.
- All shop-floor writes take a per-job lock (cumulative rules are exact under concurrency) and the DB triggers refuse any stage/output/inspection/disposition write once the job is not open for work. A write racing completion is therefore either in the frozen summary or refused.
- Defence in depth: CHECK constraints (non-negative, subsets, reason required, no operator-set reclassification), immutability triggers, race-safe disposition cap, runtime role loses UPDATE/DELETE on `quality_record`.

## Costing (decision, as requested before implementing)
Output, scrap, rework and quality decisions **post no cost**. The cost of scrapped/reworked units is already inside issued material and recorded labour (Phase 2), so adding money here would count it twice. Instead the Phase 2 cost view gains quantities, yield and a **calculated cost per good unit** = (material + labour, snapshot + adjustments) ÷ good units, shown only when the existing margin gate passes (completed, complete, single currency); scrap therefore raises the unit cost. The shop-floor summary (quantities only) is frozen into the completion snapshot's `evidence`. Additional rework material or labour is issued through the normal flows while the job is open. **Nothing can be posted to a completed job; corrections after completion use the existing `cost:adjust` adjustments** (a separate correction workflow was not needed). No overhead rule, rate or currency conversion was invented.

## Migration `20261022100000_shopfloor_quality`
Adds stage columns, evolves `quality_record`, creates `production_output`, `production_output_void`, `quality_disposition`, plus triggers. No data rewritten; new CHECKs on the two pre-existing tables are `NOT VALID` (they bind new/updated rows only; those tables had no application code before). Apply, then regenerate the client.

## Run / verify
```powershell
npx prisma migrate deploy     # applies 20261022100000_shopfloor_quality
npx prisma generate
npx tsc --noEmit
npx eslint src app components lib
npx vitest run                # needs .env + migrated DB
npm run test:ui               # no database needed
```

## API (all under /api/v1/production-jobs/[id])
`GET|PUT stages` · `POST stages/[stageId]/transition` {start|complete|block|unblock} · `GET|POST output` · `POST output/[outputId]/void` · `GET|POST inspections` · `POST inspections/[inspectionId]/dispositions` · `GET readiness`. POSTs that can be retried take `clientRequestId` (201 first time, 200 + `replayed:true` after).

## Known limits / assumptions
- **Operator shell:** operators hold the API rights, but the app still shows them the "operator workspace not available" screen (separate shell, out of scope), so in the UI the stages/output/quality screens are used by managers.
- Finished-goods stock is **not** posted from output (that is a stock-valuation decision); labour is not linked to stages; no stage templates UI or work-centre master data (the template table exists, unused).
- A DB-rejected write that races completion surfaces as a generic server error rather than a clean 409; the common case is caught earlier with a 409.
- Dashboard (Command Centre) does not yet surface blocked stages or undecided rejects.
