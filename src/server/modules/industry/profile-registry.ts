// Milestone 5 (Configurable Industry Architecture) -- the actual source of
// truth for what each industry profile supports. Deliberately a plain,
// compile-time TypeScript registry, not a database table: the mandate's own
// architecture principles rule out "unnecessary runtime plugin loading" and
// a generic EAV model, and a profile's terminology/module list is exactly
// the kind of thing that changes with a code review, not with a form
// submission -- so it lives in code, reviewed like code. What an
// ORGANIZATION chooses (which profile, which of that profile's modules are
// turned on) is the only part that's per-tenant data, and that lives on
// Organization.industryProfile / industryProfileModules
// (industry-profile-service.ts).
//
// "plastics" is the only profile with isImplemented: true and a non-empty
// implementedModules list -- see Milestone 6. The other five exist here so
// an organization's profile selection is a real, typed value a Milestone-5
// admin screen can offer today, per the mandate's "architecturally
// supported without pretending their industry-specific workflows have
// already been implemented." Adding real support for one of them later
// means: flipping isImplemented, filling in implementedModules/terminology,
// and writing the extension modules Milestone 6 shows the pattern for --
// never touching this file's shape or any other profile's entry.
export const INDUSTRY_PROFILE_VALUES = [
  "general",
  "plastics",
  "food_beverage",
  "metal_fabrication",
  "textile_garment",
  "furniture_woodworking",
  "packaging_printing",
] as const;
export type IndustryProfileKey = (typeof INDUSTRY_PROFILE_VALUES)[number];

export interface IndustryProfileDefinition {
  key: IndustryProfileKey;
  label: string;
  description: string;
  /** False for every profile except "general" and "plastics" -- see file header. */
  isImplemented: boolean;
  /**
   * Optional-module keys this profile actually supports. An organization's
   * industryProfileModules may only contain keys from the list of its
   * CURRENT profile (validated in industry-profile-service.ts); an
   * unimplemented profile's list is always empty, so there is nothing for
   * an organization to (mis)enable there.
   */
  implementedModules: readonly { key: string; label: string; description: string }[];
  /** Label overrides merged over DEFAULT_TERMINOLOGY -- see getTerminology below. */
  terminology: Readonly<Record<string, string>>;
}

const DEFAULT_TERMINOLOGY: Readonly<Record<string, string>> = {
  workCentreLabel: "Work Centre",
  machineLabel: "Machine",
  mouldLabel: "Mould",
  jobLabel: "Production Job",
  stageLabel: "Stage",
};

export const PROFILE_REGISTRY: Readonly<Record<IndustryProfileKey, IndustryProfileDefinition>> = {
  general: {
    key: "general",
    label: "General Manufacturing",
    description: "The shared manufacturing core with no industry-specific extension. The default for every new organization.",
    isImplemented: true,
    implementedModules: [],
    terminology: {},
  },
  plastics: {
    key: "plastics",
    label: "Plastics Manufacturing",
    description:
      "Injection/blow moulding, mould management, regrind tracking, and plastics-specific material, product, and process attributes (Milestone 6).",
    isImplemented: true,
    implementedModules: [
      { key: "plastics_materials", label: "Plastics material attributes", description: "Polymer grade, resin spec, colour masterbatch, regrind/recycled-content tracking on raw materials." },
      { key: "plastics_product_spec", label: "Plastics product specification", description: "Product type, resin, colour, weight, capacity, dimensions, neck finish on finished goods." },
      { key: "mould_management", label: "Mould management", description: "Mould register, machine compatibility, maintenance, and usage history." },
      { key: "plastics_process_detail", label: "Plastics process detail", description: "Process type, mould assignment, target/actual cycle time, and cavity performance on a job stage." },
      { key: "regrind_tracking", label: "Regrind tracking", description: "Spawning a regrind material lot from a job's scrap, with job-level traceability and its own ledger movement type." },
      { key: "plastics_analytics", label: "Plastics job cost & yield analytics", description: "A read-only per-job report combining material, labour, machine-time, scrap, and regrind data." },
    ],
    terminology: { workCentreLabel: "Production Line", machineLabel: "Press", mouldLabel: "Mould" },
  },
  food_beverage: {
    key: "food_beverage",
    label: "Food & Beverage Manufacturing",
    description: "Architecturally supported profile selection; no food & beverage-specific modules are implemented yet.",
    isImplemented: false,
    implementedModules: [],
    terminology: {},
  },
  metal_fabrication: {
    key: "metal_fabrication",
    label: "Metal Fabrication",
    description: "Architecturally supported profile selection; no metal-fabrication-specific modules are implemented yet.",
    isImplemented: false,
    implementedModules: [],
    terminology: {},
  },
  textile_garment: {
    key: "textile_garment",
    label: "Textile & Garment Manufacturing",
    description: "Architecturally supported profile selection; no textile/garment-specific modules are implemented yet.",
    isImplemented: false,
    implementedModules: [],
    terminology: {},
  },
  furniture_woodworking: {
    key: "furniture_woodworking",
    label: "Furniture & Woodworking",
    description: "Architecturally supported profile selection; no furniture/woodworking-specific modules are implemented yet.",
    isImplemented: false,
    implementedModules: [],
    terminology: {},
  },
  packaging_printing: {
    key: "packaging_printing",
    label: "Packaging & Printing",
    description: "Architecturally supported profile selection; no packaging/printing-specific modules are implemented yet.",
    isImplemented: false,
    implementedModules: [],
    terminology: {},
  },
};

export function getProfileDefinition(key: IndustryProfileKey): IndustryProfileDefinition {
  return PROFILE_REGISTRY[key];
}

/** DEFAULT_TERMINOLOGY with the given profile's overrides merged on top -- always a complete map. */
export function getTerminology(key: IndustryProfileKey): Record<string, string> {
  return { ...DEFAULT_TERMINOLOGY, ...PROFILE_REGISTRY[key].terminology };
}

export function isValidModuleForProfile(key: IndustryProfileKey, moduleKey: string): boolean {
  return PROFILE_REGISTRY[key].implementedModules.some((m) => m.key === moduleKey);
}
