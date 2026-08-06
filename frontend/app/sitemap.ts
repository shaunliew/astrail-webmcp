import type { MetadataRoute } from "next"
import { SITE_URL } from "@/lib/site"

// Public, indexable pages only. Everything under /app/* (the authenticated product)
// and /auth/* (OAuth callbacks) is intentionally excluded and blocked in robots.ts.
// Add a route here the moment it becomes a public marketing/landing page.
const PUBLIC_ROUTES: ReadonlyArray<{
  path: string
  changeFrequency: NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>
  priority: number
}> = [
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
]

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date()
  return PUBLIC_ROUTES.map(({ path, changeFrequency, priority }) => ({
    url: `${SITE_URL}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }))
}
