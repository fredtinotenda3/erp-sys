# Operis Phase 2 — Costing & Currency

## 1. Existing architecture (found by audit, reused, not duplicated)
- **Estimate:** `job_cost_estimate` (+ per-currency lines) computed from the job's immutable BOM snapshot at creation; unpriced materials are recorded, never costed as zero.
- **Actual material:** derived on read from the append-only stock ledger (`production_consumption`/`material_return`) by `costing/actual-cost.ts`, using the cost stamped on each issue. **Actual labour:** `labour_record` (hours x typed rate x currency).
- **Currencies:** every amount carries its own currency; costs are grouped per currency and never summed across currencies.
- **Exchange rates:** `exchange_rate` (append-only, org-scoped, audited, DB trigger forbids UPDATE/DELETE, positive-rate CHECK), `exchange_rate:create` for Owner/Admin + Finance, read for Ops too.
- **Completion snapshot:** `job_cost_actual` (+ lines), written in the same transaction as the status change, protected by an immutability trigger; completed jobs can only move to `closed`.

## 2. Gaps found and what was done
| Gap | Fix |
|---|---|
| Margin was computed for in-progress jobs and for jobs with **no recorded cost** (nothing consumed => "profit = revenue") | Margin only for a completed job, with material recorded, labour recorded, no uncosted issues, single currency; otherwise withheld with named reasons. Revenue labelled **quoted**, not recognised. |
| Variance reported to-date on open jobs, no percentage, no comparability rules | `variance.comparable/percent/reason`: stated only for a completed job with a complete estimate and complete actuals. The old `variance.material` field is kept unchanged. |
| Ledger rows without a cost silently vanished from actuals (unknown became absent) | Counted and named (`uncosted_issues`); block margin and variance. |
| Conversion of a completed job used **today's latest rate** (history drifted as rates were added) | Rule-based: completed job = rate in force at completion **and already on record then**; open job = latest; explicit `asOf` = rate on that date. Basis and the cited rate row (id, effective date, source, recorded-at) are returned and shown. |
| Snapshot recorded no completeness/evidence; lines could be appended later; an issue/labour posting could race completion and be missing from it | `completeness` + `evidence` frozen in the snapshot; DB triggers: snapshot only for a completed job, lines only in the header's own transaction, no ledger/labour posting to a non-open job (shared advisory lock vs. completion's exclusive lock), no reopening. |
| No auditable way to correct a frozen job | `job_cost_adjustment`: append-only, signed, reasoned (>=10 chars), idempotent, audited, `cost:adjust` (Owner/Admin + Finance only). Effective actual = snapshot + adjustments; snapshot is never edited. |
| Variance not explained | Per-material usage vs price variance and over-issue quantity, only when single-currency, matching unit, priced. |
| No exchange-rate screen | `/costing/exchange-rates`: history, "in force" marking, record form with confirmation. |

## 3. Decisions to review
- **Incomplete costs never block completion** (operations must not wait on finance data). The gap is frozen into the snapshot and blocks margin/variance until closed by an explicit adjustment.
- **Reopening is not permitted** (state machine + DB trigger). Corrections are adjustments.
- **No FX conversion is frozen.** Snapshot lines stay in native currencies; conversion is derived by the as-of-completion rule, so the same question always returns the same row.
- **A completed job with no labour has no margin** until labour is adjusted in. Assumption: there is no "this job legitimately has no labour" flag yet (see §5).

## 4. Migration `20261015100000_costing_integrity` (no data rewritten)
Adds `completeness`/`evidence` columns to `job_cost_actual` (defaults mark existing rows `{"legacy": true}`), creates `job_cost_adjustment`, and six triggers/functions (snapshot requires completed job; lines only in the snapshot transaction; job-open check for ledger/labour inserts; no reopen; adjustments immutable and require a snapshot). Requires `prisma generate` afterwards. New capability `cost:adjust` (Owner/Admin, Finance) is code-only.

## 5. Unresolved assumptions
- Labour rates are still typed per record (no rate card); "valid rate" = positive, <=4dp, known currency.
- Overhead remains unavailable (no approved allocation method).
- A DB-rejected late posting (race with completion) surfaces as a generic 500 rather than a 409; the common case is caught earlier with a 409.
- Exchange-rate recording has no `clientRequestId`; duplicates are harmless (append-only, identical) but the UI warns after an unknown outcome.
- Existing completed jobs (legacy snapshots) are judged from their frozen lines; their evidence counts are unknown.

## 6. Run
```powershell
npm install
npx prisma generate
npx prisma migrate deploy      # applies 20261015100000_costing_integrity
npm run dev
npx tsc --noEmit ; npx eslint src app components lib
npx vitest run                 # needs .env + migrated DB
npm run test:ui                # no database needed
```
