/**
 * API ROUTE TEMPLATE — copy this file when creating a new route under src/app/api/
 *
 * SECURITY CHECKLIST (mandatory for every handler):
 *   ✅ Call requireAuth(request) as the FIRST statement
 *   ✅ Return unauthorizedResponse() immediately if requireAuth returns false
 *   ✅ Never accept auth via ?token= in new routes (use Bearer header or cookie only)
 *   ✅ The /api/auth route is the ONLY intentional exception to this rule
 *
 * There is no middleware-level auth backstop — the per-route check IS the only protection.
 * A missing requireAuth() means the route is unauthenticated by default.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth, unauthorizedResponse } from "@/lib/auth";

export async function GET(request: NextRequest) {
  if (!requireAuth(request)) return unauthorizedResponse();

  // TODO: implement handler
  return NextResponse.json({ ok: true });
}

export async function POST(request: NextRequest) {
  if (!requireAuth(request)) return unauthorizedResponse();

  // TODO: implement handler
  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function PUT(request: NextRequest) {
  if (!requireAuth(request)) return unauthorizedResponse();

  // TODO: implement handler
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  if (!requireAuth(request)) return unauthorizedResponse();

  // TODO: implement handler
  return NextResponse.json({ ok: true });
}
