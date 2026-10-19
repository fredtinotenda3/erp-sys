// Client-side half of the backend's idempotency contract (API_REFERENCE.md):
//
//   "Generate clientRequestId BEFORE the first network attempt and reuse it on
//    every retry. 201 the first time, 200 with replayed:true on a retry.
//    Reusing an id with different data is 409."
//
// IdempotentRequest owns one logical submission. Rules:
//   * the id is created lazily on the first prepare() and kept until the
//     submission succeeds, so a retry of the SAME payload always reuses it;
//   * if the user edits the form after a definite rejection (validation error,
//     4xx), nothing was written, so a fresh id is issued for the new payload;
//   * if the last attempt's outcome is UNKNOWN (network failure / 5xx) the
//     server may have recorded it. Sending different data under the same id
//     would 409, and sending it under a new id could double-post, so changed
//     data is blocked until the user retries unchanged.

export type Outcome = "success" | "rejected" | "unknown";

export type Prepared = { ok: true; clientRequestId: string } | { ok: false; reason: string };

export function generateUuid(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // randomUUID only exists in secure contexts (https / localhost). Fall back to getRandomValues.
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export class IdempotentRequest {
  private id: string | null = null;
  private fingerprint: string | null = null;
  private unresolved = false;

  constructor(private readonly generate: () => string = generateUuid) {}

  prepare(payload: unknown): Prepared {
    const fp = JSON.stringify(payload);
    if (this.id !== null && this.fingerprint !== fp) {
      if (this.unresolved) {
        return {
          ok: false,
          reason:
            "The previous attempt may already have been recorded. Retry with the same values, or reload the page and check the history before changing them.",
        };
      }
      this.id = null;
    }
    if (this.id === null) this.id = this.generate();
    this.fingerprint = fp;
    return { ok: true, clientRequestId: this.id };
  }

  settle(outcome: Outcome): void {
    if (outcome === "success") {
      this.id = null;
      this.fingerprint = null;
      this.unresolved = false;
    } else {
      this.unresolved = outcome === "unknown";
    }
  }
}
