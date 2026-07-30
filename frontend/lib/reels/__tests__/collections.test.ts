import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'

const { from, getUser, createClient } = vi.hoisted(() => ({
  from: vi.fn(),
  getUser: vi.fn(),
  createClient: vi.fn(() => ({ auth: { getUser }, from })),
}))

vi.mock('@/lib/supabase/client', () => ({ createClient }))

import {
  addReelsToCollection,
  createCollection,
  deleteCollection,
  getMembershipsByCollection,
  listCollections,
  removeReelFromCollection,
  renameCollection,
} from '@/lib/reels/collections'

const USER_ID = 'user-123'

// The Supabase query builder is chainable + thenable: every builder method returns the
// same object, and awaiting it resolves (or rejects) with the configured outcome. This lets
// a test assert the exact call shape of a multi-link chain against one mock.
type Outcome = { data?: unknown; error?: unknown } | { reject: unknown }

interface QueryMock {
  select: Mock
  insert: Mock
  update: Mock
  delete: Mock
  upsert: Mock
  eq: Mock
  order: Mock
  single: Mock
  then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise<unknown>
}

function makeQuery(outcome: Outcome): QueryMock {
  const query = {} as QueryMock
  ;(['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'order', 'single'] as const).forEach(
    (method) => {
      query[method] = vi.fn(() => query)
    },
  )
  query.then = (resolve, reject) =>
    'reject' in outcome
      ? Promise.reject(outcome.reject).then(resolve, reject)
      : Promise.resolve(outcome).then(resolve, reject)
  return query
}

describe('reel collections data layer', () => {
  beforeEach(() => {
    from.mockReset()
    getUser.mockReset()
    createClient.mockClear()
    getUser.mockResolvedValue({ data: { user: { id: USER_ID } }, error: null })
  })

  it('lists collections ordered by sort_order then created_at', async () => {
    const query = makeQuery({ data: [{ id: 'c1' }], error: null })
    from.mockReturnValue(query)

    const result = await listCollections()

    expect(from).toHaveBeenCalledWith('reel_collections')
    expect(query.select).toHaveBeenCalledWith('*')
    expect(query.order).toHaveBeenNthCalledWith(1, 'sort_order', { ascending: true })
    expect(query.order).toHaveBeenNthCalledWith(2, 'created_at', { ascending: true })
    expect(result).toEqual([{ id: 'c1' }])
  })

  it('creates a collection with the current user_id and returns the row', async () => {
    const row = { id: 'c1', name: 'Tokyo', user_id: USER_ID }
    const query = makeQuery({ data: row, error: null })
    from.mockReturnValue(query)

    const result = await createCollection('Tokyo')

    expect(from).toHaveBeenCalledWith('reel_collections')
    expect(query.insert).toHaveBeenCalledWith({ name: 'Tokyo', user_id: USER_ID })
    expect(query.select).toHaveBeenCalledWith('*')
    expect(query.single).toHaveBeenCalled()
    expect(result).toEqual(row)
  })

  it('maps a unique-name violation (23505) to a name-collision error instead of swallowing it', async () => {
    const query = makeQuery({ data: null, error: { code: '23505', message: 'duplicate key value' } })
    from.mockReturnValue(query)

    await expect(createCollection('Tokyo')).rejects.toThrow('A tray named "Tokyo" already exists.')
  })

  it('refuses a write when there is no authenticated user (auth guard is load-bearing)', async () => {
    getUser.mockResolvedValueOnce({ data: { user: null }, error: null })

    await expect(createCollection('Tokyo')).rejects.toThrow('Not authenticated')
    expect(from).not.toHaveBeenCalled()
  })

  it('renames a collection filtered by id and maps 23505 the same way', async () => {
    const okQuery = makeQuery({ data: { id: 'c1', name: 'Kyoto' }, error: null })
    from.mockReturnValue(okQuery)

    const result = await renameCollection('c1', 'Kyoto')

    expect(okQuery.update).toHaveBeenCalledWith({ name: 'Kyoto' })
    expect(okQuery.eq).toHaveBeenCalledWith('id', 'c1')
    expect(okQuery.single).toHaveBeenCalled()
    expect(result).toEqual({ id: 'c1', name: 'Kyoto' })

    const dupeQuery = makeQuery({ data: null, error: { code: '23505', message: 'dup' } })
    from.mockReturnValue(dupeQuery)
    await expect(renameCollection('c1', 'Kyoto')).rejects.toThrow('A tray named "Kyoto" already exists.')
  })

  it('deletes a collection filtered by id', async () => {
    const query = makeQuery({ data: null, error: null })
    from.mockReturnValue(query)

    await deleteCollection('c1')

    expect(from).toHaveBeenCalledWith('reel_collections')
    expect(query.delete).toHaveBeenCalled()
    expect(query.eq).toHaveBeenCalledWith('id', 'c1')
  })

  it('upserts membership rows with ignoreDuplicates on the PK conflict, each carrying user_id', async () => {
    const query = makeQuery({ data: null, error: null })
    from.mockReturnValue(query)

    await addReelsToCollection('c1', ['r1', 'r2'])

    expect(from).toHaveBeenCalledWith('reel_collection_items')
    expect(query.upsert).toHaveBeenCalledWith(
      [
        { user_id: USER_ID, collection_id: 'c1', saved_reel_id: 'r1' },
        { user_id: USER_ID, collection_id: 'c1', saved_reel_id: 'r2' },
      ],
      { onConflict: 'collection_id,saved_reel_id', ignoreDuplicates: true },
    )
  })

  it('treats an ON CONFLICT DO NOTHING result as a no-op (no throw)', async () => {
    const query = makeQuery({ data: null, error: null })
    from.mockReturnValue(query)

    await expect(addReelsToCollection('c1', ['r1'])).resolves.toBeUndefined()
  })

  it('propagates a non-conflict RLS error (42501) instead of swallowing it', async () => {
    const query = makeQuery({ data: null, error: { code: '42501', message: 'permission denied' } })
    from.mockReturnValue(query)

    await expect(addReelsToCollection('c1', ['r1'])).rejects.toThrow('Could not add reels to the tray')
  })

  it('propagates a network rejection from the membership upsert', async () => {
    const query = makeQuery({ reject: new Error('network down') })
    from.mockReturnValue(query)

    await expect(addReelsToCollection('c1', ['r1'])).rejects.toThrow('network down')
  })

  it('no-ops on an empty reel id list without touching the client', async () => {
    await addReelsToCollection('c1', [])

    expect(createClient).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
    expect(getUser).not.toHaveBeenCalled()
  })

  it('groups memberships by collection_id in a single RLS-scoped query', async () => {
    const items = [
      { collection_id: 'c1', saved_reel_id: 'r1', user_id: USER_ID, created_at: 't' },
      { collection_id: 'c1', saved_reel_id: 'r2', user_id: USER_ID, created_at: 't' },
      { collection_id: 'c2', saved_reel_id: 'r3', user_id: USER_ID, created_at: 't' },
    ]
    const query = makeQuery({ data: items, error: null })
    from.mockReturnValue(query)

    const grouped = await getMembershipsByCollection()

    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('reel_collection_items')
    expect(query.select).toHaveBeenCalledWith('*')
    expect(grouped).toEqual({ c1: ['r1', 'r2'], c2: ['r3'] })
  })

  it('removes a membership filtered by both collection_id and saved_reel_id', async () => {
    const query = makeQuery({ data: null, error: null })
    from.mockReturnValue(query)

    await removeReelFromCollection('c1', 'r1')

    expect(from).toHaveBeenCalledWith('reel_collection_items')
    expect(query.delete).toHaveBeenCalled()
    expect(query.eq).toHaveBeenNthCalledWith(1, 'collection_id', 'c1')
    expect(query.eq).toHaveBeenNthCalledWith(2, 'saved_reel_id', 'r1')
  })
})
