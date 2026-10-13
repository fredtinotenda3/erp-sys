# Operis backend — API reference (for the frontend)

Base path `/api/v1`. All endpoints require the session cookie except `auth/login`
and `organizations/bootstrap`. Authorization is enforced server-side on every
call; the UI hides things for usability only.

## Conventions

- **Success:** `{ "data": ... }` (+ `balance`, `replayed` on stock/labour writes).
- **Error:** `{ "error": { "code", "message", "issues?" } }` with HTTP 400 (validation),
  401 (not signed in / bad login), 403 (missing capability or branch), 404 (not found —
  also used for "exists but you may not see it"), 409 (conflict / illegal state change).
- **Money and quantities are strings** (decimal-safe). Never parse them as floats for
  arithmetic; display only.
- **Currency:** every amount carries its own currency. The API NEVER sums across
  currencies. A blended total exists only behind `?convertTo=` and cites the exchange-rate
  row used.
- **Idempotent writes:** labour, material issue, receipts, adjustments require a
  client-generated `clientRequestId` (UUID). Generate it BEFORE the first network attempt
  and reuse it on every retry. Response is 201 the first time, **200 with `replayed:true`**
  on a retry. Reusing an id with different data is 409.
- **Labels (UX spec §5.2):** PLANNED = job dates, `expectedQty`; ACTUAL = recorded events,
  snapshot costs; CALCULATED = `actualBasis:"live"`, balances, remaining/available;
  ESTIMATED = `costEstimate`; UNAVAILABLE = any `null` labour/overhead cost, and `overhead:"unavailable"`.
- **Field visibility depends on capability**, not role name: customer fields need
  `customer:read`; quote, costs and unit costs need `cost:read`; stock balances need
  `stock:read`. Missing fields are simply absent — do not render empty placeholders.
- Call `GET /auth/me` once; it returns `capabilities[]` to drive navigation/buttons.

## Endpoints

### Auth / org
| Method | Path | Notes |
|---|---|---|
| POST | `auth/login` | `{ organizationSlug, email, password }` (UUID `organizationId` also accepted) |
| POST | `auth/logout` | idempotent |
| GET | `auth/me` | user, org, branches, `role`, `capabilities[]` |
| POST | `organizations/bootstrap` | first org + owner; optional `organizationSlug` |
| GET/POST | `branches`, PATCH `branches/[id]` | |
| GET/POST | `users`, PATCH `users/[id]`, POST/DELETE `users/[id]/branch-access` | |
| GET | `audit-log` | `entityType`, `entityId` filters |

### Catalog / customers
| Method | Path | Notes |
|---|---|---|
| GET/POST | `items`, GET/PATCH `items/[id]` | `reorderThreshold` optional (null clears) |
| GET/POST | `items/[id]/boms`, GET `items/[id]/boms/active`, POST `items/[id]/boms/[bomId]/activate` | versions are immutable once active |
| GET/POST | `customers`, GET/PATCH `customers/[id]` | soft delete via `status` |

### Production
| Method | Path | Notes |
|---|---|---|
| GET | `production-jobs` | `branchId`, `status`, `overdueOnly`, `limit` |
| POST | `production-jobs` | `branchId, productItemId, plannedQty`, optional dates, `customerId`, `quotedAmount`+`quotedCurrency`. Snapshots the active BOM; returns requirements + per-currency estimate |
| GET/PATCH | `production-jobs/[id]` | PATCH: dates, customer, quote only (product/qty/BOM are not editable) |
| POST | `production-jobs/[id]/transition` | `{ status, reason? }`; reason required for `on_hold`/`cancelled`; `completed` is NOT allowed here |
| POST | `production-jobs/[id]/complete` | managers only; freezes actual cost |
| POST | `production-jobs/[id]/labour` | `{ clientRequestId, hours, rate, rateCurrency }` |
| POST | `production-jobs/[id]/material-issues` | `{ clientRequestId, materialItemId, warehouseId, quantity }` |
| GET | `production-jobs/[id]/materials` | expected vs issued vs remaining/over-issued per material |
| GET | `production-jobs/[id]/cost` | estimate vs actual vs variance per currency; `?convertTo=USD&rateSource=` opt-in |

Job states: `planned → released → in_progress → completed → closed`; `on_hold` from
released/in_progress (resumes to where it came from); `cancelled` only before work starts.
The first labour record or material issue on a `released` job moves it to `in_progress`.

### Inventory
| Method | Path | Notes |
|---|---|---|
| GET/POST | `warehouses` | |
| POST | `stock/receipts` | `{ clientRequestId, warehouseId, itemId, quantity, unitCost, currency, note? }` |
| POST | `stock/adjustments` | signed `quantity`, `reason` required; positive needs cost+currency |
| GET | `stock/balances` | `itemId`, `warehouseId` |
| GET | `stock/movements` | the ledger: "why is stock N?" (`itemId`, `warehouseId`, `referenceId`, `limit`) |
| GET | `inventory/shortages` | per branch+item: on-hand, remaining requirement, status `shortage`/`low`/`ok`, drill-down `demand[]`; `hasStockRecord:false` = "No stock recorded" |

### Costing / reports
| Method | Path | Notes |
|---|---|---|
| GET/POST | `exchange-rates` | POST: Owner/Finance only. Org-scoped, append-only |
| GET | `exchange-rates/latest` | `baseCurrency`, `quoteCurrency`, `source?` (exact pair only; no inverse) |
| GET | `reports/job-costs` | per-job estimate + actual lines, for the job list |
| GET | `reports/profitability` | completed jobs; `from`,`to`,`branchId`,`customerId`,`productItemId` |

## Not built yet (frontend must show "coming later", never fake data)
Sales orders and order→job conversion · production stages / shop-floor routing · quality
records and reject reasons · stock returns and transfers · suppliers and purchasing ·
overhead allocation (always UNAVAILABLE) · dashboard "needs attention" tiles that depend on those.
