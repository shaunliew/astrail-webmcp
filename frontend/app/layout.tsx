// Root layout — Supabase auth/session via middleware + a browser client.
// Realtime subscriptions run client-side.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
