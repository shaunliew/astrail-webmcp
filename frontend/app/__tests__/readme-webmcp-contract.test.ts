import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readme = readFileSync(resolve(process.cwd(), '..', 'README.md'), 'utf8')

const REGISTERED_TOOLS = [
  'get_app_state',
  'list_trips',
  'save_reels',
  'list_saved_reels',
  'get_itinerary',
  'get_place_evidence',
  'plan_trip_from_reels',
  'get_trip_progress',
  'move_place',
  'remove_place',
  'show_on_map',
  'set_map_mode',
  'get_map_view',
]

describe('README WebMCP submission contract', () => {
  it('lists every tool currently mounted by globalTools and tripTools', () => {
    const table = readme.match(/## WebMCP tools[\s\S]*?(?=\n## )/)?.[0] ?? ''

    for (const name of REGISTERED_TOOLS) {
      expect(table).toContain(`\`${name}\``)
    }
  })

  it('shows the native registration call and the motivating feedback', () => {
    expect(readme).toContain(
      'document.modelContext.registerTool({ name, description, inputSchema, execute })',
    )
    expect(readme).toContain(
      "unclear how to navigate the website — where to click, how to choose the reels, how to start generating a trip.",
    )
  })

  it('does not overstate the itinerary edit rollout', () => {
    expect(readme).toMatch(/move_place[\s\S]*remove_place[\s\S]*unit-tested[\s\S]*never live-tested/i)
    expect(readme).toContain('WEBMCP_EDITS_ENABLED')
    expect(readme).toMatch(/off by default/i)
  })
})
