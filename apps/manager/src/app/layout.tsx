import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sea King Capital — Manager',
  description: 'Sea King Capital PO Financing & AR Factoring System',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
