import { randomUUID } from "node:crypto";
const BASE = process.env.BASE ?? "http://localhost:3000";
const { ORG_SLUG, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (!ORG_SLUG || !ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error("Set ORG_SLUG, ADMIN_EMAIL, ADMIN_PASSWORD");
const PW = "Operis-Demo-2026!";
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
let cookie = "";
async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j.error ?? j)}`);
  return j.data;
}
const r0 = await fetch(BASE + "/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationSlug: ORG_SLUG, email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
if (!r0.ok) throw new Error("Admin login failed: " + (await r0.text()));
cookie = r0.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

const branch = (await api("GET", "/api/v1/auth/me")).branches[0].id;
const codes = (await api("GET", "/api/v1/currencies")).map((c) => c.code);
for (const c of ["USD", "ZIG", "ZAR"]) if (!codes.includes(c)) throw new Error(`Currency ${c} missing: run scripts/seed-currencies.sql`);
if ((await api("GET", "/api/v1/items?search=RM-STL-3MM")).length) throw new Error("Already seeded (RM-STL-3MM exists). Run once only.");

// exchange rates (older first)
const rate = (b, q, r, d) => api("POST", "/api/v1/exchange-rates", { baseCurrency: b, quoteCurrency: q, rate: r, asOfDate: d, source: "MANUAL" });
await rate("USD", "ZIG", 26.5, day(-7));
for (const [b, q, r] of [["USD", "ZIG", 27.0], ["ZIG", "USD", 0.037], ["ZAR", "USD", 0.054], ["USD", "ZAR", 18.5]]) await rate(b, q, r, day(0));

// users
const U = {};
for (const [k, role] of [["manager", "PRODUCTION_MANAGER"], ["finance", "FINANCE_MANAGER"], ["inventory", "INVENTORY_MANAGER"], ["operator", "PRODUCTION_OPERATOR"], ["viewer", "VIEWER"]])
  U[k] = await api("POST", "/api/v1/users", { email: `${k}@operis.test`, fullName: `Demo ${k[0].toUpperCase() + k.slice(1)}`, role, password: PW, branchIds: [branch] });

// customers
const C = {};
for (const n of ["Kuwadzana Agri Supplies", "Harare Mining Services", "Bulawayo Pump & Engineering"]) C[n.split(" ")[0]] = await api("POST", "/api/v1/customers", { name: n });

// items
const I = {};
const raw = [["RM-STL-3MM", "Steel Plate 3mm", "kg", 1.8, "USD", 200], ["RM-BRG-6308", "Bearing 6308", "ea", 6.5, "USD", 20], ["RM-MTR-55", "Electric Motor 5.5 kW", "ea", 210, "USD", 2], ["RM-SHF-40", "Shaft Steel 40mm", "m", 14, "USD", 10], ["RM-PNT-GRY", "Grey Paint", "l", 110, "ZIG", 20], ["RM-SEAL-KIT", "Seal Kit", "ea", 3.2, "USD", 10], ["RM-FAST-KIT", "Fastener Kit", "ea", 4.5, "USD", 50]];
for (const [sku, name, uom, cost, cur, reorder] of raw) I[sku] = await api("POST", "/api/v1/items", { sku, name, uom, itemType: "raw_material", standardCost: cost, standardCostCurrency: cur, reorderThreshold: reorder });
const fg = [["FG-PUMP-55", "Slurry Pump 5.5kW", 1850, [["RM-STL-3MM", 40, "kg"], ["RM-BRG-6308", 2, "ea"], ["RM-MTR-55", 1, "ea"], ["RM-SHF-40", 1.2, "m"], ["RM-PNT-GRY", 3, "l"], ["RM-SEAL-KIT", 1, "ea"]]], ["FG-GUARD-01", "Conveyor Guard Panel", 240, [["RM-STL-3MM", 12, "kg"], ["RM-FAST-KIT", 1, "ea"]]], ["FG-FRAME-02", "Support Frame", 520, [["RM-STL-3MM", 55, "kg"], ["RM-PNT-GRY", 1.5, "l"]]]];
for (const [sku, name, price, lines] of fg) {
  I[sku] = await api("POST", "/api/v1/items", { sku, name, uom: "ea", itemType: "finished_good", isSellable: true, sellingPrice: price, sellingPriceCurrency: "USD" });
  const bom = await api("POST", `/api/v1/items/${I[sku].id}/boms`, { lines: lines.map(([s, q, u]) => ({ materialItemId: I[s].id, quantity: q, uom: u })) });
  await api("POST", `/api/v1/items/${I[sku].id}/boms/${bom.id}/activate`);
}

// warehouses + opening stock (receipts keep the ledger valid)
const main = (await api("POST", "/api/v1/warehouses", { branchId: branch, name: "Main Store" })).id;
const shop = (await api("POST", "/api/v1/warehouses", { branchId: branch, name: "Workshop Store" })).id;
const rcv = (wh, sku, quantity, unitCost, currency = "USD") => api("POST", "/api/v1/stock/receipts", { clientRequestId: randomUUID(), warehouseId: wh, itemId: I[sku].id, quantity, unitCost, currency });
await rcv(main, "RM-STL-3MM", 800, 1.8); await rcv(main, "RM-STL-3MM", 400, 2.0);
await rcv(main, "RM-BRG-6308", 40, 6.5); await rcv(main, "RM-MTR-55", 6, 210); await rcv(main, "RM-SHF-40", 30, 14);
await rcv(main, "RM-PNT-GRY", 90, 110, "ZIG"); await rcv(main, "RM-SEAL-KIT", 60, 3.2); await rcv(main, "RM-FAST-KIT", 200, 4.5);
await rcv(shop, "RM-PNT-GRY", 20, 110, "ZIG"); await rcv(shop, "RM-SEAL-KIT", 10, 3.2); await rcv(shop, "RM-FAST-KIT", 20, 4.5);

// jobs
const P = "/api/v1/production-jobs";
const job = (sku, qty, cust, quote, s, e) => api("POST", P, { branchId: branch, productItemId: I[sku].id, plannedQty: qty, customerId: C[cust].id, quotedAmount: quote, quotedCurrency: "USD", plannedStart: day(s), plannedEnd: day(e) });
const release = (j) => api("POST", `${P}/${j.id}/transition`, { status: "released" });
const issue = (j, sku, quantity, wh = main) => api("POST", `${P}/${j.id}/material-issues`, { clientRequestId: randomUUID(), materialItemId: I[sku].id, warehouseId: wh, quantity });
const labour = (j, hours, rate) => api("POST", `${P}/${j.id}/labour`, { clientRequestId: randomUUID(), hours, rate, rateCurrency: "USD" });
const stages = async (j, list) => (await api("PUT", `${P}/${j.id}/stages`, { stages: list })).stages;
const act = (j, st, action) => api("POST", `${P}/${j.id}/stages/${st.id}/transition`, { action });
const out = (j, st, body) => api("POST", `${P}/${j.id}/output`, { clientRequestId: randomUUID(), jobStageId: st.id, ...body });
const insp = (j, st, body) => api("POST", `${P}/${j.id}/inspections`, { clientRequestId: randomUUID(), jobStageId: st.id, ...body });

// J1: completed guard panels (costing demo)
const j1 = await job("FG-GUARD-01", 3, "Harare", 480, -14, -7);
const s1 = await stages(j1, [{ name: "Cut" }, { name: "Weld", requiresInspection: true }, { name: "Paint" }]);
await release(j1); await issue(j1, "RM-STL-3MM", 40); await issue(j1, "RM-FAST-KIT", 3); await labour(j1, 6, 4.5);
await act(j1, s1[0], "start"); await out(j1, s1[0], { goodQty: 3 }); await act(j1, s1[0], "complete");
await act(j1, s1[1], "start"); await out(j1, s1[1], { goodQty: 2, scrapQty: 1, reason: "damaged" }); await insp(j1, s1[1], { inspectedQty: 2 }); await act(j1, s1[1], "complete");
await act(j1, s1[2], "start"); await out(j1, s1[2], { goodQty: 2 }); await act(j1, s1[2], "complete");
await api("POST", `${P}/${j1.id}/complete`);

// J2: frames in progress, one failed inspection awaiting a decision
const j2 = await job("FG-FRAME-02", 4, "Bulawayo", 2080, -3, 6);
const s2 = await stages(j2, [{ name: "Cut" }, { name: "Weld", requiresInspection: true, operatorUserId: U.operator.id, workCentre: "Weld Bay 1" }, { name: "Finish" }]);
await release(j2); await issue(j2, "RM-STL-3MM", 220); await issue(j2, "RM-PNT-GRY", 6); await labour(j2, 8, 4.5);
await act(j2, s2[0], "start"); await out(j2, s2[0], { goodQty: 4 }); await act(j2, s2[0], "complete");
await act(j2, s2[1], "start"); await out(j2, s2[1], { goodQty: 4 });
await insp(j2, s2[1], { inspectedQty: 4, rejectedQty: 1, rejectReason: "wrong_dimensions", notes: "Bracket weld off-spec" });

// J3/J4 released (shortage + overdue), J5 planned
await release(await job("FG-PUMP-55", 5, "Harare", 9250, 0, 14));
await release(await job("FG-PUMP-55", 4, "Kuwadzana", 7400, -20, -5));
await job("FG-GUARD-01", 10, "Kuwadzana", 2400, 7, 21);
console.log("Seeded. Log in with e.g. manager@operis.test / " + PW);