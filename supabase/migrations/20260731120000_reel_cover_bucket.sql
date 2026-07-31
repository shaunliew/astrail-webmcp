-- Durable reel-cover thumbnails: a PUBLIC-READ Storage bucket, written only by the backend service-role key
-- (bypasses Storage RLS → no policy needed). `do update` converges a pre-existing private bucket to public.
insert into storage.buckets (id, name, public)
values ('reel-covers', 'reel-covers', true)
on conflict (id) do update set public = excluded.public;
