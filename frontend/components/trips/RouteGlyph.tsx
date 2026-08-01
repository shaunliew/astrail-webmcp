// A tiny deterministic "constellation trail" glyph, seeded off the trip id so every trip
// gets a stable little route shape. Shared by the trip cards and the inventory rows.

type RoutePoint = { x: number; y: number }

function routePoints(id: string): [RoutePoint, RoutePoint, RoutePoint] {
  let hash = 2166136261
  for (const character of id) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }

  const next = () => {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507)
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909)
    return ((hash ^= hash >>> 16) >>> 0) / 4294967296
  }

  return [
    { x: 8 + next() * 12, y: 11 + next() * 18 },
    { x: 31 + next() * 10, y: 7 + next() * 24 },
    { x: 56 + next() * 10, y: 11 + next() * 18 },
  ]
}

export default function RouteGlyph({ tripId }: { tripId: string }) {
  const [start, middle, end] = routePoints(tripId)
  const firstControl = { x: (start.x + middle.x) / 2, y: Math.min(start.y, middle.y) - 7 }
  const secondControl = { x: (middle.x + end.x) / 2, y: Math.min(middle.y, end.y) - 7 }

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="72"
      height="40"
      viewBox="0 0 72 40"
      className="shrink-0"
    >
      <path
        d={`M ${start.x} ${start.y} Q ${firstControl.x} ${firstControl.y} ${middle.x} ${middle.y} Q ${secondControl.x} ${secondControl.y} ${end.x} ${end.y}`}
        fill="none"
        stroke="var(--brass)"
        strokeDasharray="1.5 4"
        strokeLinecap="round"
        strokeOpacity="0.6"
        strokeWidth="1.2"
      />
      {[start, middle, end].map((point, index) => (
        <circle key={index} cx={point.x} cy={point.y} r="2.5" fill="var(--brass-deep)" />
      ))}
    </svg>
  )
}
