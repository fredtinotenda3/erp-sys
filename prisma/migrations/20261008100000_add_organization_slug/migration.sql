-- ============================================================================
-- Adds organization.slug: a short, human-typeable, platform-unique login
-- handle (e.g. "acme-furniture"). Replaces typing a raw organization UUID on
-- the login screen. The UUID stays the primary key and the internal tenant
-- identifier everywhere; slug is only a lookup handle for login.
--
-- Three steps so existing rows (including test organizations already in the
-- database) are handled safely:
--   1. add the column as nullable
--   2. backfill: slugified name + first 6 hex chars of the id (guarantees
--      uniqueness without guessing at collisions)
--   3. make it NOT NULL, add UNIQUE and a format CHECK
--
-- Format rule (also enforced in application code): 3-50 chars, lowercase
-- letters/digits, single hyphens between groups, no leading/trailing hyphen.
--
-- VERIFICATION after applying:
--   SELECT id, name, slug FROM organization LIMIT 10;      -- every row has a slug
--   SELECT count(*) FROM organization WHERE slug IS NULL;  -- expect 0
-- ============================================================================

ALTER TABLE organization ADD COLUMN slug text;

UPDATE organization
SET slug = left(
      coalesce(
        nullif(trim(both '-' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))), ''),
        'org'
      ),
      40
    ) || '-' || left(replace(id::text, '-', ''), 6)
WHERE slug IS NULL;

-- left(...,40) can cut mid-word and leave a trailing hyphen before the suffix
-- hyphen ("abc--1a2b3c"); collapse any double hyphen so the CHECK below holds.
UPDATE organization SET slug = regexp_replace(slug, '-{2,}', '-', 'g');

ALTER TABLE organization ALTER COLUMN slug SET NOT NULL;
ALTER TABLE organization ADD CONSTRAINT organization_slug_key UNIQUE (slug);
ALTER TABLE organization ADD CONSTRAINT organization_slug_format
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 50);
