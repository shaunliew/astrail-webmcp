-- Keep the private schema out of the authenticated client's direct namespace.
-- Security-definer RLS predicates remain callable by their stored function OID.
revoke usage on schema private from authenticated;
grant usage on schema private to service_role;
