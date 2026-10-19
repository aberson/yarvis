// Minimal access log: one stdout line per /api request when its response finishes, e.g.
// "[api] PATCH /api/settings 200 3ms". Only method, path (query string dropped), status and
// duration are logged - never request bodies, headers, or anything read from private/.
import type { RequestHandler } from "express";

export type AccessLogSink = (line: string) => void;

export function accessLog(sink: AccessLogSink): RequestHandler {
  return (req, res, next) => {
    const pathOnly = req.originalUrl.split("?")[0] ?? "";
    if (pathOnly !== "/api" && !pathOnly.startsWith("/api/")) {
      next();
      return;
    }
    const start = process.hrtime.bigint();
    res.once("finish", () => {
      const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
      sink(`[api] ${req.method} ${pathOnly} ${res.statusCode} ${ms}ms`);
    });
    next();
  };
}
