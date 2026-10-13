INSERT INTO currency (code, name, decimals)
VALUES
  ('USD', 'United States Dollar', 2),
  ('ZIG', 'Zimbabwe Gold', 2),
  ('ZAR', 'South African Rand', 2)
ON CONFLICT DO NOTHING;
