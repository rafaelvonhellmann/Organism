import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '@/components/sidebar';
import { BottomNav } from '@/components/bottom-nav';
import { ThemeProvider } from '@/components/theme-provider';
import { AuthGate } from '@/components/auth-gate';

export const metadata: Metadata = {
  title: 'Organism — Living Knowledge System',
  description: 'Perspective-driven knowledge orchestration dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* Prevent flash of wrong theme by reading localStorage before paint */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('organism-theme');if(t==='light'){document.documentElement.classList.remove('dark');document.documentElement.classList.add('light')}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <AuthGate>
            <Sidebar />
            <main className="ml-0 md:ml-56 pt-14 md:pt-0 pb-16 md:pb-0 min-h-screen">
              {children}
            </main>
            <BottomNav />
          </AuthGate>
        </ThemeProvider>
      </body>
    </html>
  );
}
