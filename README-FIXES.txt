Unzip over your erp-sys folder (same paths), then run:

  npm install
  npx prisma migrate deploy          (if it stops on the costing migration, see docs/SETUP_COMMANDS.md section 9)
  psql "<superuser url>" -d mops_dev -f docs/db-roles-and-security.sql   (Stage 3 grants; safe to re-run)
  npm test
