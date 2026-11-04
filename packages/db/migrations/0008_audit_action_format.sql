-- 0008: one canonical spelling for audit actions (final verification, Low finding 3).
-- Forward-only. Never edit this file after it has been applied anywhere: the runner checksums it.
--
-- 0006 and 0007 reserve the actions mandate.*, category_limit.* and app_user.* for rows the database writes itself.
-- That check is case-sensitive and does not trim, so the runtime role could insert 'APP_USER.role_change' or
-- ' app_user.role_change' with a forged actor; a case-insensitive search (an auditor, the Elasticsearch mirror) would
-- read those as genuine. Requiring lower-case dotted identifiers makes every look-alike impossible to store, so the
-- reserved-prefix check sees the only spelling that exists. The length limit from 0001 stays.

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.audit_log WHERE action !~ '^[a-z][a-z0-9_]*([.][a-z0-9_]+)*$';
  IF n > 0 THEN
    RAISE EXCEPTION 'migration 0008 refused existing data: % audit_log row(s) have an action that is not lower-case dotted identifiers; audit_log is append-only, so they need a deliberate decision, not a rewrite', n
      USING ERRCODE = 'MD013';
  END IF;
END;
$$;

ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_action_format_check CHECK (action ~ '^[a-z][a-z0-9_]*([.][a-z0-9_]+)*$');
