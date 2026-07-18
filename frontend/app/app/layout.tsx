// Night-world shell for every /app route (Night & Daybreak — docs/DESIGN-DRAFT.md).
// The .app-shell scope remaps the design tokens to Night values; the landing at /
// keeps the :root palette untouched.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <div className="app-shell">{children}</div>
}
