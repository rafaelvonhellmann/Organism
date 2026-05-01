import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, unauthorizedResponse } from '@/lib/auth';

export function middleware(request: NextRequest) {
  if (!requireAuth(request)) return unauthorizedResponse();
  return NextResponse.next();
}

export const config = {
  matcher: ['/api/((?!auth$).*)'],
};
