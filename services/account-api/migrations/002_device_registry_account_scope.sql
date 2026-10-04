DO $$
DECLARE
  current_primary_key TEXT;
  current_columns TEXT[];
BEGIN
  SELECT
    constraint_row.conname,
    array_agg(attribute_row.attname::TEXT ORDER BY key_column.ordinality)
  INTO current_primary_key, current_columns
  FROM pg_constraint AS constraint_row
  CROSS JOIN LATERAL unnest(constraint_row.conkey)
    WITH ORDINALITY AS key_column(attnum, ordinality)
  JOIN pg_attribute AS attribute_row
    ON attribute_row.attrelid = constraint_row.conrelid
   AND attribute_row.attnum = key_column.attnum
  WHERE constraint_row.conrelid = 'device_registry'::regclass
    AND constraint_row.contype = 'p'
  GROUP BY constraint_row.conname;

  IF current_columns = ARRAY['user_id', 'device_id']::TEXT[] THEN
    RETURN;
  END IF;

  IF current_columns IS DISTINCT FROM ARRAY['device_id']::TEXT[] THEN
    RAISE EXCEPTION 'Unexpected device_registry primary key: %', current_columns;
  END IF;

  EXECUTE format(
    'ALTER TABLE device_registry DROP CONSTRAINT %I',
    current_primary_key
  );

  ALTER TABLE device_registry
    ADD CONSTRAINT device_registry_pkey PRIMARY KEY (user_id, device_id);
END
$$;
