// Command Centre. UX_UI_ARCHITECTURE.md §3.5 (interim landing page, agreed
// in the spec-approval round) says this should be the production job list
// with planned vs. actual dates and live cost vs. estimate — but
// ProductionJob has no service/route built yet (that's the next Phase 1.5
// module after Customers). Rendering fabricated rows or a static mockup
// here would violate the same rule the backend side follows throughout:
// never show a plausible-looking figure with no real row behind it
// (ARCHITECTURE.md §9). So this is the §5.2 UNAVAILABLE treatment applied
// to an entire page rather than a single figure — replace this file's body
// with the real job list once the Production module lands; nothing in the
// shell around it (layout, nav, top bar) needs to change when that happens.
export default function DashboardPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <h1 className="text-base font-semibold">Command Centre</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        This will show the production job list — planned vs. actual dates, live cost vs. estimate — once the Production
        module is built. No fabricated data is shown in the meantime.
      </p>
    </div>
  );
}
