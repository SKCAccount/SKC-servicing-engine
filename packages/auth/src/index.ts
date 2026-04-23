export {
  type UserRole,
  type AuthUser,
  isManager,
  isAdminManager,
  isOperator,
  isClientUser,
} from './roles';

// Server and browser entrypoints are intentionally NOT re-exported from index
// to keep client bundles from pulling in server-only code. Consumers import
// them directly:
//   import { createSupabaseServerClient } from '@seaking/auth/server';
//   import { getSupabaseBrowserClient } from '@seaking/auth/browser';
