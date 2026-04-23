/**
 * Role helpers mirroring the SQL functions `is_manager()`, `is_admin_manager()`,
 * `is_client_user()`. These versions operate on an already-fetched `users.role`
 * value (cheap), rather than issuing a SQL round-trip for each check.
 *
 * IMPORTANT: these are UI-layer conveniences. Every write that actually needs
 * role enforcement should also rely on RLS — the DB is the source of truth.
 */

export type UserRole = 'admin_manager' | 'operator' | 'client' | 'investor' | 'creditor';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  clientId: string | null;
}

export function isManager(role: UserRole): boolean {
  return role === 'admin_manager' || role === 'operator';
}

export function isAdminManager(role: UserRole): boolean {
  return role === 'admin_manager';
}

export function isOperator(role: UserRole): boolean {
  return role === 'operator';
}

export function isClientUser(role: UserRole): boolean {
  return role === 'client';
}
