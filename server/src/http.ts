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
  internal: 500,
};

export function sendError(res: Response, error: ApiErrorCode, message?: string): void {
  const body: ApiErrorBody = message === undefined ? { error } : { error, message };
  res.status(STATUS[error]).json(body);
}
