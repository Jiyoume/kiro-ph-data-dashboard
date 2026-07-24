import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Executive Revenue Dashboard',
  description: 'Data-driven insights for C-suite decision making',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-800">
        <header className="border-b bg-white px-8 py-4">
          <h1 className="text-xl font-bold text-slate-900">
            Executive Revenue Dashboard
          </h1>
          <p className="text-sm text-slate-500">
            Customer Analytics · PSCG Workshop · {new Date().getFullYear()}
          </p>
        </header>
        <main className="mx-auto max-w-7xl px-6 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
