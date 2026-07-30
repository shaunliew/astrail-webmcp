// RLS-direct Supabase CRUD for inspiration Trays (reel_collections) and their
// reel memberships (reel_collection_items). Mirrors lib/trip/supabase-api.ts:
// every read/write goes through the browser client and is scoped to auth.uid()
// by RLS — no backend endpoint. See supabase/migrations/20260718120000_saved_reels_foundation.sql.
import { createClient } from '@/lib/supabase/client'
import type { ReelCollection, ReelCollectionItem } from './backend-types'

// user_id is `not null` with NO default on both tables, and the INSERT policies are
// `with check (auth.uid() = user_id)` — so every insert MUST set user_id from the live
// session (never a caller/prop), or the write silently fails the not-null / RLS check.
async function requireUserId(supabase: ReturnType<typeof createClient>): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) throw new Error('Not authenticated')
  return user.id
}

// The unique index reel_collections (user_id, lower(btrim(name))) surfaces a concurrent
// duplicate as Postgres 23505; the client-side disable is UX-only, this is the real guard.
function collectionWriteError(error: { code?: string; message?: string }, name: string): Error {
  if (error.code === '23505') return new Error(`A tray named "${name}" already exists.`)
  return new Error(`Could not save the tray: ${error.message}`)
}

export async function listCollections(): Promise<ReelCollection[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('reel_collections')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(`Could not load trays: ${error.message}`)
  return (data ?? []) as ReelCollection[]
}

export async function createCollection(name: string): Promise<ReelCollection> {
  const supabase = createClient()
  const userId = await requireUserId(supabase)
  const { data, error } = await supabase
    .from('reel_collections')
    .insert({ name, user_id: userId })
    .select('*')
    .single()
  if (error) throw collectionWriteError(error, name)
  return data as ReelCollection
}

export async function renameCollection(id: string, name: string): Promise<ReelCollection> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('reel_collections')
    .update({ name })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw collectionWriteError(error, name)
  return data as ReelCollection
}

export async function deleteCollection(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from('reel_collections').delete().eq('id', id)
  if (error) throw new Error(`Could not delete the tray: ${error.message}`)
}

// Batch-safe: `ignoreDuplicates: true` emits ON CONFLICT DO NOTHING, so an already-present
// membership is skipped row-by-row (no UPDATE grant needed on the junction table) instead of
// aborting the whole batch. A plain insert + swallow-23505 would drop every other reel when a
// single one is already a member. Every non-conflict error (RLS with-check, FK, network) surfaces.
export async function addReelsToCollection(collectionId: string, savedReelIds: string[]): Promise<void> {
  if (savedReelIds.length === 0) return
  const supabase = createClient()
  const userId = await requireUserId(supabase)
  const rows = savedReelIds.map((savedReelId) => ({
    user_id: userId,
    collection_id: collectionId,
    saved_reel_id: savedReelId,
  }))
  const { error } = await supabase
    .from('reel_collection_items')
    .upsert(rows, { onConflict: 'collection_id,saved_reel_id', ignoreDuplicates: true })
  if (error) throw new Error(`Could not add reels to the tray: ${error.message}`)
}

export async function removeReelFromCollection(collectionId: string, savedReelId: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase
    .from('reel_collection_items')
    .delete()
    .eq('collection_id', collectionId)
    .eq('saved_reel_id', savedReelId)
  if (error) throw new Error(`Could not remove the reel from the tray: ${error.message}`)
}

export async function listCollectionItems(): Promise<ReelCollectionItem[]> {
  const supabase = createClient()
  const { data, error } = await supabase.from('reel_collection_items').select('*')
  if (error) throw new Error(`Could not load tray memberships: ${error.message}`)
  return (data ?? []) as ReelCollectionItem[]
}

// Grouped read for the trays grid: ONE RLS-scoped query, grouped client-side (avoids N+1).
export async function getMembershipsByCollection(): Promise<Record<string, string[]>> {
  const items = await listCollectionItems()
  const grouped: Record<string, string[]> = {}
  for (const item of items) {
    (grouped[item.collection_id] ??= []).push(item.saved_reel_id)
  }
  return grouped
}
