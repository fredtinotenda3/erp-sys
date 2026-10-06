// Password hashing via @node-rs/argon2 (prebuilt native binaries — avoids
// the node-gyp/Python/MSVC toolchain the plain `argon2` package needs to
// compile on Windows; see SETUP_COMMANDS.md for the bcryptjs fallback if
// this package ever fails to install on a given platform).
//
// Parameters follow the OWASP Password Storage Cheat Sheet's Argon2id
// minimum ("m=19456 (19 MiB), t=2, p=1") rather than the library's own
// defaults (4096 KiB / t=3 / p=1), which are below that minimum. Algorithm
// is pinned to Argon2id explicitly even though it's already the library
// default, so a future library version changing its default can't silently
// weaken this.
import { hash, verify } from "@node-rs/argon2";

// `algorithm: 2` is @node-rs/argon2's Algorithm.Argon2id. Deliberately NOT
// importing the `Algorithm` const enum itself: TypeScript inlines const
// enums at compile time, which `isolatedModules` (the mode Next.js's
// SWC-based build uses, and which create-next-app's default tsconfig turns
// on) cannot support for an enum imported from another module — confirmed
// by running `tsc --noEmit` with `isolatedModules: true` against this exact
// file, which fails with "Cannot access ambient const enums when
// 'isolatedModules' is enabled" the moment `Algorithm.Argon2id` is
// referenced. The plain numeric literal has no such restriction.
const HASH_OPTIONS = {
  algorithm: 2, // Algorithm.Argon2id
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, HASH_OPTIONS);
}

// Deliberately does NOT pass HASH_OPTIONS to verify(): Argon2's encoded hash
// string carries its own parameters (algorithm, version, m, t, p, salt), and
// verify() reads them from the hash, not from the options argument. This
// also means a future rotation of HASH_OPTIONS (e.g. raising memoryCost)
// does not invalidate existing stored hashes — they keep verifying correctly
// against whichever parameters they were originally hashed with.
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  return verify(storedHash, plaintext);
}
