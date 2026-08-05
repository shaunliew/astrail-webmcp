import { notFound } from 'next/navigation'

import DevSignInForm from './DevSignInForm'

/* Dev-only password door for seeded demo/test accounts (e.g. Aster). The prod sign-in
   flow is OTP-only, which needs a receivable inbox — demo accounts don't have one, so in
   development this page offers plain email+password against the same Supabase project.
   Real user accounts are passwordless and cannot sign in here. The NODE_ENV check runs
   server-side on every request: production builds 404 before rendering anything. */
export default function DevSignInPage() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return <DevSignInForm />
}
