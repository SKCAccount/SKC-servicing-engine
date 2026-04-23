/**
 * Shared API types for server-action and route-handler input/output contracts.
 * Actual schemas will be added as each workflow lands.
 */

export interface ActionSuccess<T> {
  ok: true;
  data: T;
}

export interface ActionError {
  ok: false;
  error: {
    code: string;
    message: string;
    // Human-friendly field-level messages when input validation fails.
    fieldErrors?: Record<string, string[]>;
  };
}

export type ActionResult<T> = ActionSuccess<T> | ActionError;

export const ok = <T>(data: T): ActionSuccess<T> => ({ ok: true, data });

export const err = (
  code: string,
  message: string,
  fieldErrors?: Record<string, string[]>,
): ActionError => ({
  ok: false,
  error: fieldErrors ? { code, message, fieldErrors } : { code, message },
});
