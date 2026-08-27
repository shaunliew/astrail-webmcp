import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  signInWithOAuth: vi.fn(),
  signInWithOtp: vi.fn(),
  signInWithPassword: vi.fn(),
  verifyOtp: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      signInWithOAuth: mocks.signInWithOAuth,
      signInWithOtp: mocks.signInWithOtp,
      signInWithPassword: mocks.signInWithPassword,
      verifyOtp: mocks.verifyOtp,
    },
  }),
}))

vi.mock('@/components/door/DoorChrome', () => ({
  DoorBrand: () => null,
  DoorStage: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  FOCUS_RING: '',
}))

import SignInPage from '../sign-in/page'

describe('password sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.signInWithOAuth.mockResolvedValue({ data: { provider: 'google', url: null }, error: null })
    mocks.signInWithOtp.mockResolvedValue({ data: { user: null, session: null }, error: null })
    mocks.signInWithPassword.mockResolvedValue({ data: { user: {}, session: {} }, error: null })
    mocks.verifyOtp.mockResolvedValue({ data: { user: {}, session: {} }, error: null })
  })

  it('reveals the quiet password form and signs in with the entered credentials', async () => {
    const user = userEvent.setup()
    render(<SignInPage />)

    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Have a password? Sign in with it' }))

    const password = screen.getByLabelText('Password')
    expect(password).toHaveAttribute('type', 'password')
    await user.type(screen.getByLabelText('Email'), '  judge@example.com  ')
    await user.type(password, 'demo-password')
    await user.click(screen.getByRole('button', { name: 'Sign in with password' }))

    expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      email: 'judge@example.com',
      password: 'demo-password',
    })
    expect(mocks.push).toHaveBeenCalledWith('/app')
  })

  it('names a disabled email provider instead of blaming the password', async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: {
        name: 'AuthApiError',
        status: 422,
        code: 'email_provider_disabled',
        message: 'Email logins are disabled',
      },
    })
    const user = userEvent.setup()
    render(<SignInPage />)

    await user.click(screen.getByRole('button', { name: 'Have a password? Sign in with it' }))
    await user.type(screen.getByLabelText('Email'), 'judge@example.com')
    await user.type(screen.getByLabelText('Password'), 'demo-password')
    await user.click(screen.getByRole('button', { name: 'Sign in with password' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Password sign-in is not enabled for this project.',
    )
    expect(screen.getByRole('alert')).not.toHaveTextContent(/wrong password/i)
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('uses non-enumerating friendly copy for wrong credentials', async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: {
        name: 'AuthApiError',
        status: 400,
        code: 'invalid_credentials',
        message: 'Invalid login credentials',
      },
    })
    const user = userEvent.setup()
    render(<SignInPage />)

    await user.click(screen.getByRole('button', { name: 'Have a password? Sign in with it' }))
    await user.type(screen.getByLabelText('Email'), 'judge@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Sign in with password' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That email or password didn’t match. Check both and try again.',
    )
  })
})
