import { updateSession } from '@seaking/auth/middleware';
import type { NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on every path EXCEPT:
     * - /_next/static (static assets)
     * - /_next/image (image optimization)
     * - /favicon.ico, other public static files
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
