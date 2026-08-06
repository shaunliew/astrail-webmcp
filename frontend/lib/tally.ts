// Tally form IDs, kept in one place and deliberately separate so the two lists never
// get conflated — they carry different consent/purpose (launch legal precautions A3).
//
//   NOTIFY  — "email me when the full launch / hotel booking is ready" (public landing)
//   FEEDBACK — in-app beta feedback ("tell us what broke"), opened from the sidebar
//
// Both open as Tally popups via https://tally.so/widgets/embed.js (loaded once in the
// root layout) using a `data-tally-open="<id>"` attribute on the trigger element.
export const TALLY_NOTIFY_FORM_ID = 'QKjrvk'
export const TALLY_FEEDBACK_FORM_ID = 'PdNreP'
