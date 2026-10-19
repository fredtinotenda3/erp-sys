// Usability-only input checks. The server re-validates everything with zod and
// is the authority; these just give instant, specific feedback and turn the
// text a user typed into the JSON number the API contract requires.

export type ParsedNumber = { ok: true; value: number } | { ok: false; message: string };

export function parseDecimalInput(
  raw: string,
  opts: { maxDecimals: number; min?: "positive" | "nonnegative" | "any"; label?: string },
): ParsedNumber {
  const label = opts.label ?? "Value";
  const text = raw.trim();
  if (text === "") return { ok: false, message: `${label} is required.` };
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, message: `${label} must be a number, like 12 or 12.5.` };
  const decimals = text.includes(".") ? text.split(".")[1]!.length : 0;
  if (decimals > opts.maxDecimals) {
    return { ok: false, message: `${label} can have at most ${opts.maxDecimals} decimal place${opts.maxDecimals === 1 ? "" : "s"}.` };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, message: `${label} is too large.` };
  const min = opts.min ?? "any";
  if (min === "positive" && !(value > 0)) return { ok: false, message: `${label} must be greater than zero.` };
  if (min === "nonnegative" && value < 0) return { ok: false, message: `${label} can't be negative.` };
  return { ok: true, value };
}

export function requireText(raw: string, label: string, opts: { min?: number; max?: number } = {}): string | null {
  const t = raw.trim();
  if (t === "") return `${label} is required.`;
  if (opts.min && t.length < opts.min) return `${label} must be at least ${opts.min} characters.`;
  if (opts.max && t.length > opts.max) return `${label} must be at most ${opts.max} characters.`;
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);
