'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Bespoke range calendar — same UX as the react-aria pattern (field group → popover →
// drag-select a range) but zero new deps and no shadcn tokens. Two themes: `night` (the dark
// void/starlight/brass create surface) and `paper` (the light daybreak sheet, PlanSheet).
// Contract is plain 'YYYY-MM-DD' strings (or '') so it drops straight into BriefInput.

type Variant = 'night' | 'paper'

type Props = {
  startDate: string // 'YYYY-MM-DD' | ''
  endDate: string // 'YYYY-MM-DD' | ''
  onChange: (start: string, end: string) => void
  /** Optional lower bound; days before it are disabled. 'YYYY-MM-DD'. */
  minDate?: string
  /** Accessible name for the trigger; also the visible field label when `showLabel`. */
  label?: string
  /** Hide the built-in label (when the host already renders its own heading). */
  showLabel?: boolean
  /** Colour system. `night` = dark create surface, `paper` = light daybreak sheet. */
  variant?: Variant
  /** Which side the calendar opens toward. Use `top` inside short/scrolling containers. */
  placement?: 'bottom' | 'top'
}

// Per-variant class map — keeps one render tree while each surface keeps its own accent
// language (bright brass + dark-on-brass at night; brass-deep + light-on-brass on paper).
const THEME: Record<Variant, {
  trigger: string; placeholder: string; caption: string; icon: string; ring: string
  popover: string; nav: string; heading: string; weekday: string
  rangeFill: string; day: string; dayDisabled: string; endpoint: string; todayRing: string
}> = {
  night: {
    trigger: 'surface text-[var(--starlight)]',
    placeholder: 'text-[var(--faint)]',
    caption: 'text-[var(--faint)]',
    icon: 'text-[var(--muted)]',
    ring: 'focus-visible:ring-[var(--brass)]',
    popover: 'border-[var(--line)] bg-[var(--elevated)] shadow-[var(--shadow-night)]',
    nav: 'text-[var(--muted)] hover:bg-[var(--brass-soft)] hover:text-[var(--starlight)]',
    heading: 'text-[var(--starlight)]',
    weekday: 'text-[var(--faint)]',
    rangeFill: 'bg-[var(--brass-soft)]',
    day: 'text-[var(--starlight)] hover:bg-[var(--brass-soft)]',
    dayDisabled: 'text-[var(--faint)] opacity-40',
    endpoint: 'bg-[var(--brass)] text-[var(--ink)]',
    todayRing: 'ring-[var(--faint)]',
  },
  paper: {
    trigger: 'min-h-11 border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] text-[color:var(--text)]',
    placeholder: 'text-[color:var(--text-faint)]',
    caption: 'text-[color:var(--text-faint)]',
    icon: 'text-[color:var(--text-muted)]',
    ring: 'focus-visible:ring-[color:var(--brass-deep)]',
    popover: 'border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] shadow-[0_1px_2px_rgba(28,23,16,0.12),0_14px_40px_rgba(28,23,16,0.22)]',
    nav: 'text-[color:var(--text-muted)] hover:bg-[color:var(--brass-glow)] hover:text-[color:var(--text)]',
    heading: 'text-[color:var(--text)]',
    weekday: 'text-[color:var(--text-faint)]',
    rangeFill: 'bg-[color:var(--brass-glow)]',
    day: 'text-[color:var(--text)] hover:bg-[color:var(--brass-glow)]',
    dayDisabled: 'text-[color:var(--text-faint)] opacity-40',
    endpoint: 'bg-[color:var(--brass-deep)] text-[color:var(--paper-0)]',
    todayRing: 'ring-[color:var(--paper-line-2)]',
  },
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n: number) => String(n).padStart(2, '0')
// month `m` is 0-indexed everywhere in this module (matches the Date API).
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`

function parseISO(s: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!match) return null
  return { y: +match[1], m: +match[2] - 1, d: +match[3] }
}

const isoOf = (date: Date) => iso(date.getFullYear(), date.getMonth(), date.getDate())
const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate()
const firstWeekday = (y: number, m: number) => new Date(y, m, 1).getDay() // 0 = Sun

// Fixed-width ISO strings sort chronologically, so range math is plain string compares.
function nightsBetween(a: string, b: string): number {
  const pa = parseISO(a), pb = parseISO(b)
  if (!pa || !pb) return 0
  return Math.round((Date.UTC(pb.y, pb.m, pb.d) - Date.UTC(pa.y, pa.m, pa.d)) / 86_400_000)
}

function fmt(dateIso: string, withYear: boolean): string {
  const p = parseISO(dateIso)
  if (!p) return ''
  return `${MONTHS_SHORT[p.m]} ${p.d}${withYear ? `, ${p.y}` : ''}`
}

function buildWeeks(y: number, m: number): (number | null)[][] {
  const cells: (number | null)[] = Array(firstWeekday(y, m)).fill(null)
  for (let d = 1; d <= daysInMonth(y, m); d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: (number | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export default function DateRangePicker({
  startDate, endDate, onChange, minDate,
  label = 'Trip dates', showLabel = true, variant = 'night', placement = 'bottom',
}: Props) {
  const t = THEME[variant]
  const [open, setOpen] = useState(false)
  const [todayIso] = useState(() => isoOf(new Date()))
  const [view, setView] = useState(() => {
    const seed = parseISO(startDate) ?? parseISO(minDate ?? '') ?? parseISO(todayIso)!
    return { y: seed.y, m: seed.m }
  })
  // `anchor` is the first endpoint of an in-progress selection; the committed range in
  // props stays untouched until the second click.
  const [anchor, setAnchor] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [focusDay, setFocusDay] = useState<string>(startDate || todayIso)

  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const wantFocus = useRef(false) // only steal focus in response to keyboard nav
  // Trigger viewport rect — the calendar is portaled to <body> and fixed-positioned against
  // it, so it escapes clipping by any scrolling/overflow ancestor (e.g. PlanSheet's sheet).
  const [rect, setRect] = useState<DOMRect | null>(null)

  // The widget spans two DOM trees once portaled: the root (label + trigger) and the popover.
  const inWidget = (node: Node | null) =>
    Boolean(node && (rootRef.current?.contains(node) || popoverRef.current?.contains(node)))

  function openPicker() {
    // Seed focus on the committed start, else today — but never on a malformed prop or a
    // disabled day (else the opening grid has no tabbable/focusable cell).
    let seed = parseISO(startDate) ? startDate : todayIso
    if (minDate && seed < minDate) seed = minDate
    const p = parseISO(seed)!
    setView({ y: p.y, m: p.m })
    setFocusDay(seed)
    setAnchor(null)
    setHover(null)
    setRect(triggerRef.current!.getBoundingClientRect())
    wantFocus.current = true
    setOpen(true)
  }

  function close(refocus: boolean) {
    setOpen(false)
    setAnchor(null)
    setHover(null)
    if (refocus) triggerRef.current?.focus()
  }

  // While open: dismiss on a true outside click or Escape, and keep the fixed popover aligned
  // to the trigger as the page/ancestors scroll or resize.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!inWidget(e.target as Node)) close(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(true) } }
    const reposition = () => { if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect()) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  // Land keyboard focus on the active day when opening or arrow-navigating.
  useEffect(() => {
    if (!open || !wantFocus.current) return
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`button[data-iso="${focusDay}"]`)
    el?.focus()
    wantFocus.current = false
  }, [open, focusDay, view])

  const disabled = (dayIso: string) => Boolean(minDate) && dayIso < minDate!

  // Tab-out (focus leaves BOTH the root and the popover) dismisses. A dead-space or
  // disabled-day click inside the popover blurs to null → keep open (true outside clicks are
  // the pointerdown listener's job, and it preserves any in-progress anchor).
  function onWidgetBlur(e: React.FocusEvent) {
    if (open && e.relatedTarget && !inWidget(e.relatedTarget as Node)) close(false)
  }

  function pick(dayIso: string) {
    if (disabled(dayIso)) return
    setFocusDay(dayIso) // keep roving focus on the activated day (mouse↔keyboard parity)
    if (anchor == null) {
      setAnchor(dayIso)
      setHover(dayIso)
      return
    }
    const lo = anchor <= dayIso ? anchor : dayIso
    const hi = anchor <= dayIso ? dayIso : anchor
    onChange(lo, hi)
    close(true)
  }

  // Move the shown month, carrying focus with it (same day-of-month, clamped to the
  // month length and to minDate) so the new grid always has one tabbable/focusable cell.
  // `focus` steals focus (keyboard nav); chevron clicks leave it on the button.
  function goToMonth(months: number, focus: boolean) {
    const d = new Date(view.y, view.m + months, 1)
    const ny = d.getFullYear(), nm = d.getMonth()
    const p = parseISO(focusDay)!
    let next = iso(ny, nm, Math.min(p.d, daysInMonth(ny, nm)))
    const md = minDate ? parseISO(minDate) : null
    if (md && next < minDate! && md.y === ny && md.m === nm) next = minDate!
    setView({ y: ny, m: nm })
    setFocusDay(next)
    if (focus) wantFocus.current = true
  }

  function moveFocus(deltaDays: number) {
    const p = parseISO(focusDay)!
    const d = new Date(p.y, p.m, p.d + deltaDays)
    let next = isoOf(d)
    if (minDate && next < minDate) next = minDate // clamp to the boundary, don't dead-end
    const np = parseISO(next)!
    setFocusDay(next)
    setView({ y: np.y, m: np.m })
    wantFocus.current = true
  }

  function onGridKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); moveFocus(-1); break
      case 'ArrowRight': e.preventDefault(); moveFocus(1); break
      case 'ArrowUp': e.preventDefault(); moveFocus(-7); break
      case 'ArrowDown': e.preventDefault(); moveFocus(7); break
      case 'PageUp': e.preventDefault(); goToMonth(-1, true); break
      case 'PageDown': e.preventDefault(); goToMonth(1, true); break
      case 'Enter':
      case ' ': e.preventDefault(); pick(focusDay); break
    }
  }

  // Range to paint: the live anchor→hover preview while selecting, else the committed range.
  const other = hover ?? anchor
  const [rangeLo, rangeHi] = anchor
    ? [anchor <= other! ? anchor : other!, anchor <= other! ? other! : anchor]
    : [startDate, endDate]

  const startP = parseISO(startDate)
  const endP = parseISO(endDate)
  const hasRange = Boolean(startP && endP)
  const spansYears = hasRange && startP!.y !== endP!.y
  const triggerText = hasRange
    ? `${fmt(startDate, spansYears)} → ${fmt(endDate, spansYears)}`
    : 'Add trip dates'
  const nights = hasRange ? nightsBetween(startDate, endDate) : 0

  const weeks = buildWeeks(view.y, view.m)

  return (
    <div
      ref={rootRef}
      className="relative flex flex-col gap-1.5"
      onBlur={onWidgetBlur}
    >
      {showLabel ? (
        <span className={cx('type-label text-[11px] uppercase tracking-wide', variant === 'night' ? 'text-[var(--muted)]' : 'text-[color:var(--text-muted)]')}>
          {label}
        </span>
      ) : null}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close(true) : openPicker())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={hasRange ? `${label}: ${triggerText}. Change dates.` : `Select ${label.toLowerCase()}`}
        className={cx(
          'type-body flex items-center justify-between gap-2 rounded-lg p-2.5 text-left text-sm',
          'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0',
          t.trigger, t.ring,
        )}
      >
        <span className={hasRange ? '' : t.placeholder}>{triggerText}</span>
        <CalendarGlyph className={t.icon} />
      </button>

      {hasRange ? (
        <p className={cx('type-body text-xs', t.caption)}>
          {nights === 0 ? 'Same-day trip' : `${nights} night${nights === 1 ? '' : 's'}`}
        </p>
      ) : null}

      {open && rect ? createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Choose trip dates"
          onBlur={onWidgetBlur}
          style={{
            position: 'fixed',
            left: Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - 304 - 8))),
            ...(placement === 'top'
              ? { bottom: Math.round(window.innerHeight - rect.top + 8) }
              : { top: Math.round(rect.bottom + 8) }),
            zIndex: 50,
          }}
          className={cx('w-[19rem] rounded-lg border p-3', t.popover)}
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => goToMonth(-1, false)}
              aria-label="Previous month"
              className={cx('grid size-7 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2', t.nav, t.ring)}
            >
              <Chevron dir="left" />
            </button>
            <span aria-live="polite" className={cx('type-label text-xs uppercase tracking-wide', t.heading)}>
              {MONTHS_LONG[view.m]} {view.y}
            </span>
            <button
              type="button"
              onClick={() => goToMonth(1, false)}
              aria-label="Next month"
              className={cx('grid size-7 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2', t.nav, t.ring)}
            >
              <Chevron dir="right" />
            </button>
          </div>

          <div role="grid" aria-label={`${MONTHS_LONG[view.m]} ${view.y}`} onKeyDown={onGridKeyDown} ref={gridRef}>
            <div role="row" className="grid grid-cols-7">
              {WEEKDAYS.map((w, i) => (
                <span
                  key={i}
                  role="columnheader"
                  aria-label={w}
                  className={cx('type-label grid h-7 place-items-center text-[10px] uppercase', t.weekday)}
                >
                  {w[0]}
                </span>
              ))}
            </div>

            {weeks.map((week, wi) => (
              <div role="row" key={wi} className="grid grid-cols-7">
                {week.map((day, di) => {
                  if (day == null) return <span role="gridcell" key={di} className="h-9" />
                  const dayIso = iso(view.y, view.m, day)
                  const isDisabled = disabled(dayIso)
                  const isLo = dayIso === rangeLo
                  const isHi = dayIso === rangeHi
                  const isEnd = isLo || isHi
                  const solidRange = Boolean(rangeLo && rangeHi) && rangeLo !== rangeHi
                  const inRange = solidRange && dayIso > rangeLo && dayIso < rangeHi
                  const isToday = dayIso === todayIso
                  return (
                    <span role="gridcell" aria-selected={isEnd} key={di} className={cx(
                      'grid place-items-center',
                      (inRange || (isEnd && solidRange)) && t.rangeFill,
                      isLo && solidRange && 'rounded-l-md',
                      isHi && solidRange && 'rounded-r-md',
                    )}>
                      <button
                        type="button"
                        data-iso={dayIso}
                        disabled={isDisabled}
                        tabIndex={dayIso === focusDay ? 0 : -1}
                        onClick={() => pick(dayIso)}
                        onMouseEnter={() => anchor && setHover(dayIso)}
                        aria-label={`${MONTHS_LONG[view.m]} ${day}, ${view.y}`}
                        className={cx(
                          'type-body grid size-9 place-items-center rounded-md text-sm transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2', t.ring,
                          isDisabled && cx('cursor-not-allowed', t.dayDisabled),
                          !isDisabled && !isEnd && t.day,
                          isEnd && cx('font-medium', t.endpoint),
                          isToday && !isEnd && cx('ring-1 ring-inset', t.todayRing),
                        )}
                      >
                        {day}
                      </button>
                    </span>
                  )
                })}
              </div>
            ))}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

function CalendarGlyph({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={cx('size-4 shrink-0', className)} fill="none" stroke="currentColor" strokeWidth={1.6}>
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 2.5v4M16 2.5v4" strokeLinecap="round" />
    </svg>
  )
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d={dir === 'left' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
    </svg>
  )
}
