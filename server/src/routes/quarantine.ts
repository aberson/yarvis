// GET /api/quarantine (plan §6): every row of the Quarantine tab (released rows included, with
// their released_at; the page marks them).
import { Router } from "express";
import type { QuarantineItem } from "@yarvis/shared";
import { QUARANTINE, type SheetsStore } from "../connectors/sheets.js";

export function quarantineRouter(opts: { store: SheetsStore }): Router {
  const router = Router();
  router.get("/api/quarantine", async (_req, res) => {
    const body: QuarantineItem[] = await opts.store.readRows(QUARANTINE);
    res.json(body);
  });
  return router;
}
