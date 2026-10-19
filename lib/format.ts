// Display formatting for values the API sends as strings.
//
// API_REFERENCE.md: "Money and quantities are strings (decimal-safe). Never
// parse them as floats for arithmetic; display only." These helpers therefore
// work on the decimal STRING directly (grouping thousands, trimming zeros) and
// never round-trip through Number, so a stored 12345678.1234 is shown exactly.

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

export function formatDecimal(
  value: string | number | null | undefined,
  opts: { minFraction?: number; maxFraction?: number } = {},
): string {
  if (value === null || value === undefined || value === "") return "—";
  const { minFraction = 0, maxFraction = 4 } = opts;
  const match = DECIMAL.exec(String(value).trim());
  if (!match) return String(value); // never invent a number from something unparseable
  const [, sign, intPart, fracRaw = ""] = match;
  let frac = fracRaw.slice(0, Math.max(maxFraction, minFraction));
  frac = frac.replace(/0+$/, "");
  while (frac.length < minFraction) frac += "0";
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const isZero = /^0*$/.test(intPart) && /^0*$/.test(frac);
  return `${isZero ? "" : sign}${grouped}${frac ? `.${frac}` : ""}`;
}

/** "USD 1,234.50", "-ZIG 31.50". The currency is always shown; amounts never appear bare. */
export function formatMoney(amount: string | number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const code = (currency ?? "").trim();
  const text = formatDecimal(amount, { minFraction: 2, maxFraction: 4 });
  if (!code) return text;
  return text.startsWith("-") ? `-${code} ${text.slice(1)}` : `${code} ${text}`;
}

export function formatQuantity(value: string | number | null | undefined, uom?: string | null): string {
  const text = formatDecimal(value, { minFraction: 0, maxFraction: 4 });
  return uom && text !== "—" ? `${text} ${uom}` : text;
}

/** Signed quantity for ledger rows: "+25", "−4.5". */
export function formatSignedQuantity(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const text = formatDecimal(value, { minFraction: 0, maxFraction: 4 });
  if (text.startsWith("-")) return `−${text.slice(1)}`;
  return text === "0" ? text : `+${text}`;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dateTimeUtcFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/** Calendar dates (planned/actual dates) are shown in UTC so they never shift a day. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}

/** Deterministic timestamp (UTC). The <LocalTime> component upgrades this to local time after hydration. */
export function formatDateTimeUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${dateTimeUtcFmt.format(d)} UTC`;
}

export function formatDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d);
}

export function humanize(value: string): string {
  return value
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
