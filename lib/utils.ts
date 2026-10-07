import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Standard shadcn/ui helper: merges conditional class lists (clsx) and then
// resolves conflicting Tailwind utility classes so the last one wins
// (tailwind-merge) — e.g. cn("p-2", condition && "p-4") correctly yields
// just "p-4", not both classes left to fight it out in source order.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
