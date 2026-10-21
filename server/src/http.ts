// Small helpers shared by createApp and the route modules for the plan §6 error shape.
import type { Response } from "express";
import type { ApiErrorBody, ApiErrorCode } from "@yarvis/shared";

const STATUS: Record<ApiErrorCode, number> = {
  bad_host: 403,
  missing_x_yarvis: 403,
  bad_id: 400,
  not_found: 404,
  bad_request: 400,
  settings_invalid: 500,
  sheets_not_configured: 503,
  sheets_error: 502,
  internal: 500,
  assistant_busy: 409,
  revision_conflict: 409,
  assistant_unavailable: 503,
  source_unavailable: 503,
};

/**
 * Sends `{error, message?}` with the code's fixed status. `extra` adds documented fields to the body
 * (only a save conflict's `currentPacket` today, S1.5); it never overrides `error`/`message`.
 */
export function sendError(
  res: Response,
  error: ApiErrorCode,
  message?: string,
  extra?: Readonly<Record<string, unknown>>,
): void {
  const body: ApiErrorBody = message === undefined ? { error } : { error, message };
  res.status(STATUS[error]).json(extra ? { ...extra, ...body } : body);
}
