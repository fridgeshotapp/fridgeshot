-- feedback and preparations are not used by the app (both empty as of 2026-11-01)
-- but are exposed through PostgREST: with RLS off, anyone holding the public anon
-- key can read and write them. RLS with no policies = deny all for anon/authenticated;
-- the service role (backend) still bypasses it.
alter table public.feedback enable row level security;
alter table public.preparations enable row level security;
