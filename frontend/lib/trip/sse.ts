import type { StreamEvent } from './backend-types'

export function parseSSELine(line: string): StreamEvent | null {
  if (!line.startsWith('data: ')) return null
  const data = line.slice(6).trim()
  if (data === '[DONE]') return null
  try {
    return JSON.parse(data) as StreamEvent
  } catch {
    return null
  }
}

export function parseSSEChunk(chunk: string): StreamEvent[] {
  return chunk
    .split('\n')
    .map(parseSSELine)
    .filter((e): e is StreamEvent => e !== null)
}
