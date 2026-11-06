-- Milestone 5 -- Configurable Industry Architecture. Additive only: one new
-- enum and two new nullable-by-default columns on "organization". No
-- existing column is altered or dropped, and every existing organization
-- row gets industry_profile = 'general' (the only sensible default for an
-- org that never had a profile before) with no other behaviour change --
-- see prisma/schema.prisma's "Milestone 5" comment for the design
-- rationale, and industry-profile-service.ts for the profile registry this
-- just makes room for.

-- ---------------------------------------------------------------------------
-- Enum
-- ---------------------------------------------------------------------------
CREATE TYPE "IndustryProfile" AS ENUM (
  'general',
  'plastics',
  'food_beverage',
  'metal_fabrication',
  'textile_garment',
  'furniture_woodworking',
  'packaging_printing'
);

-- ---------------------------------------------------------------------------
-- Columns added to "organization"
-- ---------------------------------------------------------------------------
ALTER TABLE "organization" ADD COLUMN "industry_profile" "IndustryProfile" NOT NULL DEFAULT 'general';

-- A small, fixed-shape JSON array of module-key strings (never a generic
-- object/EAV bag) -- see schema.prisma's comment on this column for why
-- this is JSONB rather than this project's first native Postgres array
-- column. The CHECK below only constrains its outer shape (must be a JSON
-- array); which keys are valid for the organization's CURRENT profile is
-- validated at the service layer (industry-profile-service.ts), because
-- that validation depends on a value (industry_profile) in the same row,
-- which a single-column CHECK cannot reference across an UPDATE the way the
-- service layer already does transactionally.
ALTER TABLE "organization" ADD COLUMN "industry_profile_modules" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "organization"
  ADD CONSTRAINT "organization_industry_profile_modules_is_array"
  CHECK (jsonb_typeof("industry_profile_modules") = 'array');

-- ---------------------------------------------------------------------------
-- Runtime grants -- guarded exactly like every prior migration.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT UPDATE (industry_profile, industry_profile_modules) ON organization TO mops_runtime;
  END IF;
END
$$;
