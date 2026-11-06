# Operis Demo Presentation Guide — Mavuno Packaging Industries (Pvt) Ltd

A 16-step, 20–30 minute walkthrough against the real records created by `npm run seed:demo -- --apply` (see `DEMO_SEED_MANIFEST.md` for exact setup, and `DEMO_DATA_CATALOGUE.md` for the full dataset reference). Every screen, number, and status named below is something the seed actually creates through this application's real services — nothing here is staged separately from what you can reproduce yourself.

**Before you start:** job numbers, PO numbers, and SO numbers are assigned by the application at creation time, not chosen by the seed script, so this guide identifies each record by its **business characteristics** (product, quantity, customer/supplier) rather than a specific number. Have `/production/jobs`, `/purchasing/orders`, and `/orders` open in separate tabs and sort/filter by product or customer name to find the exact record quickly — the table below in Step 1 gives you the lookup key for everything referenced later.

**Reminder as you present:** "Mavuno Packaging Industries (Pvt) Ltd" and everyone in it are entirely fictional — say so if anyone asks, the same way the seed data's own header comments do.

| If you need... | Look for... |
|---|---|
| Job A1 | Job: product WIP-PET-PFM-2L / Preform, planned qty 2,000 |
| Job A2 | Job: product FG-PET-BTL-2000 / PET Bottle 2L, planned qty 1,800 |
| Job A3 | Job: product WIP-PET-PFM-2L / Preform, planned qty 2,500 |
| Job B1 | Job: product FG-PP-CAP-28, planned qty 50,000 |
| Job B2 | Job: product FG-PP-CAP-38, planned qty 20,000, status **in progress** |
| Job C1 | Job: product FG-HDPE-BTL-500D, planned qty 19,700 |
| SO1 | Sales order: customer Delta Beverages Bottling, 1,730 × PET Bottle 2L |
| SO3 | Sales order: customer Sunshine Home Care Products, 19,700 × HDPE Detergent Bottle 500ml |

---

### Step 1 — Sign in and orient (2 min)
Sign in as **owner@mavunopackaging.test**. Land on the Command Centre (`/dashboard`). Point out that this dashboard has no canned numbers — everything on it is read live from whatever's been seeded, the same as it would be for a brand-new customer org with nothing in it yet. Open `/settings/industry-profile` and show the organization is on the **plastics** profile with all 6 plastics modules enabled — this is what unlocks moulds, plastics specs, process detail, and regrind tracking for the rest of the demo.

### Step 2 — Eight people, five real roles (2 min)
`/settings/users`. Walk through the 8 named personas and point out they map onto only **5** of the application's 7 real roles — nothing was invented to make the org chart look nicer. Call out the two Purchasing/Warehouse personas sharing `INVENTORY_MANAGER`, and the three shop-floor personas (Supervisor, Operator, Quality Inspector) sharing `PRODUCTION_OPERATOR` — then flag the one thing that differs between them *within* that shared role: stage transitions (Supervisor), material issue/labour/output (Operator), and inspections (Quality) are all separate capabilities that role happens to hold together, not three different roles.

### Step 3 — A real catalog item, with version history (2 min)
`/catalog/items`, open the **PET Bottle 2L** finished good. Show its plastics product spec (capacity, weight, neck finish, and the closure it's compatible with — FG-PP-CAP-38). Then open the **2L PET Preform** (WIP) item instead and show its BOM: point out it has **two versions** — v1 (100% virgin PET) and the currently-active v2 (a 70/30 virgin/rPET blend) — and that v1 is still on record, not deleted, because a job created before the switch keeps its original snapshot.

### Step 4 — Purchasing: a PO at every stage of its life (3 min)
`/purchasing/orders`. In one screen, show all five real statuses this demo seeded on purpose: a fully **received** PO (virgin PET + rPET resin from Harare Polymers), a **partially received** one (spares, where screw/barrel sets are still outstanding), a **confirmed**-but-not-yet-received one, a **draft** nobody has confirmed yet, and a **closed** one. Open the partially-received PO and show the line-level accepted-vs-ordered split. Mention who did what: the Purchasing Officer drafted every one of these; the Owner confirmed each — because confirming a PO is a capability `INVENTORY_MANAGER` deliberately does not hold.

### Step 5 — Goods receipt and real lot genealogy (2 min)
From that same received PO, open its goods receipt, then follow the link to the `MaterialLot` it created (`/inventory/lots`). Show the lot's traceability tab is empty so far — nothing has consumed from it yet — and say that's about to change in Step 6.

### Step 6 — Sales orders, every real status (2 min)
`/orders`. Show the same range-of-statuses idea on the sales side: two **draft** orders nobody's confirmed, one **confirmed**-but-not-yet-produced order (100,000 PP closures for Mukuru Foods), one **cancelled** order with its real cancellation reason attached (a closure neck-size spec change), and the two orders that are fully fulfilled — SO1 and SO3, which the rest of this demo will trace end to end.

### Step 7 — Job A1: making the preform (2 min)
Open **Job A1**. Walk its one stage (Injection Moulding, machine INJ-01, mould MLD-PFM-2L, 4 cavities). Show the material issue (90kg virgin PET), the labour entry (attributed to the Machine Operator, not the Owner — because `recordLabour` always stamps whoever is actually logged in), the plastics process detail (target 16s cycle vs. actual 17.4s — a real, operator-typed number, not a sensor reading), and the output: 1,960 good, 40 scrap, with a real reason ("short shots during start-of-run warm-up"). Job A1 is complete and its 1,960 preforms are now sitting in the Production WIP Store.

### Step 8 — Job A2: the bottle, and a real QA rejection (3 min)
Open **Job A2** — note it's linked to **SO1** right on the job header, a real `salesOrderLineId` link, not a coincidence of naming. It consumes Job A1's preforms (1,830kg-equivalent issued from WIP Store), runs on the ISBM-01 stretch-blow moulder, and produces 1,750 good / 50 scrap. Then open its inspection: 20 of those 1,750 were rejected for under-spec wall thickness, with real measured values against the PET Bottle 2L inspection plan's characteristics (41.8g weight, 0.26mm wall — below the 0.28mm minimum). Show the **disposition**: scrap, 20 units, recorded by the Production Manager — *not* the Quality Inspector who flagged it, because deciding what happens to a reject needs `quality:approve`, which the Inspector's role doesn't hold. 1,730 bottles are received into Finished Goods — exactly SO1's ordered quantity.

### Step 9 — Where the scrap actually goes (2 min)
`/inventory/lots`, filter to the Regrind and Recycled Materials Store. Show the regrind lot: ~2.9kg, created from Job A2's combined scrap and QA-rejected units (70 units total), and — the point worth pausing on — it's recorded as a lot of **RM-PET-VIRGIN**, the exact same item the original resin was, not a separate "regrind" SKU. Open its traceability and show `sourceJobId` pointing straight back to Job A2.

### Step 10 — Job A3: closing the loop (3 min)
Open **Job A3** — same product as Job A1 (the 2L preform) but created after BOM v2 went active, so its material requirement comes from the blend recipe, not the virgin-only one. Show the **three separate material issues**: virgin PET from the Raw Materials Warehouse, approved rPET from the same warehouse, and the *entire* regrind lot from Step 9, from the Regrind Store. Make the point explicit: three different warehouse sources feeding the same job, each retaining its own cost basis (virgin at standard cost, rPET at its own lower cost, regrind at $0.70/kg) — nothing here blends into a single average that would hide where the material, or the cost, actually came from. This is the full arc of Scenario D: scrap → regrind → re-issued into real production, with the genealogy intact at every step.

### Step 11 — Job B1: high-cavity closures and a rework decision (2 min)
Open **Job B1** (PP closures, 50,000 planned). Show the process detail: 16 cavities, 15 good — cavity 7 was under-performing, flagged in the output notes. Show the inspection (300 of 48,500 rejected for gate flash) and this time a **different** disposition: **rework**, not scrap — a second real disposition kind, shown deliberately against the same Scenario B job so a viewer sees more than just "scrap" exists.

### Step 12 — Job B2: a live, unresolved decision (2 min)
Open **Job B2** (PP 38mm closures) and point out its status: **in progress**, not completed — on purpose. Its inspection (150 of 19,600 rejected for an undersized sealing lip) has **no disposition recorded yet**. This is the moment to say plainly: this is what a real, live, unresolved QA decision looks like in this system — not a demo artifact, the actual state the application is in right now for this job, exactly as it would be if the Production Manager simply hadn't gotten to it yet.

### Step 13 — Job C1: a different process, a clean result (2 min)
Open **Job C1** (HDPE detergent bottles, extrusion blow moulding on EBM-01 — a different machine and process type than anything shown so far). Linked to **SO3**. Show its inspection: full pass, zero rejected — deliberate status variation against A2/B1's rejects, so the demo doesn't look like every batch has a problem.

### Step 14 — Fulfilling SO1: partial dispatch and a cross-branch transfer (3 min)
`/orders`, open SO1. Show the **first dispatch** (1,000 of 1,730 units, delivered). Then switch to `/inventory/finished-goods`, find the remaining batch, and show the **transfer** that moved 730 units from the Harare Finished Goods Warehouse to the Bulawayo Finished Goods Store — a real cross-branch stock movement, not a second production run. Back on SO1, show the **second dispatch**, shipped *from Bulawayo*, and that the order is now fully delivered.

### Step 15 — Fulfilling SO3: the simple case, for contrast (1 min)
Open SO3's single dispatch — one warehouse, one shipment, delivered. Worth showing right after Step 14 specifically because it's simpler: not every fulfilment needs a transfer, and the system doesn't force one.

### Step 16 — Reports: everything above, rolled up (2 min)
`/reports/job-costs` — open Job A2 or B1 and show its actual material/labour cost against its planned figure, computed from the exact material issues and labour entries shown in Steps 7–13, not a separate number. `/reports/wip-valuation` and `/reports/fg-valuation` — show the value currently sitting in WIP (Job A3's in-flight preforms) and Finished Goods. Close on the point that matters most for a buyer evaluating this system: every number on every one of these reports came from a real transaction a real (if fictional, for today) person entered through the real screens you just walked through — there is no separate, hand-maintained KPI table anywhere in this application.

---

**Total: ~30 minutes at a comfortable pace, ~20 minutes tight.** If you're short on time, the minimum viable cut is Steps 1, 3, 4, 8, 9, 10, 12, 14, 16 — it still covers all 5 scenarios (A/B/C/D/E) and the one live pending-decision state, just with one example per idea instead of two.
