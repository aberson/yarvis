// Load / validate / write settings (plan §5, §12.1). Reads <privateDir>/settings.json; when it is
// absent, falls back to the tracked repo-root settings.example.json (read-only until a PATCH, which
// creates the private file). Writes are temp-file + rename (plan §3.3).
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import {
  DEFAULT_LOGO,
  LOGO_IDS,
  isSinceShape,
  sinceEpochMs,
  type Settings,
  type SettingsPatch,
} from "@yarvis/shared";
import type { Paths } from "./paths.js";
import { writeJsonAtomic } from "../util/atomic-write.js";

// D38: a calendar day or an exact UTC instant; sinceEpochMs (shared/src/since.ts) is the one parser.
const since = z
  .string()
  .refine(isSinceShape, "must be YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS]Z")
  .refine((s) => sinceEpochMs(s) !== null, "must be a real calendar date and time");

const probability = z.number().min(0).max(1);

export const SettingsSchema = z.strictObject({
  sheetId: z.string(),
  pirate: z.boolean(),
  logo: z.enum(LOGO_IDS).default(DEFAULT_LOGO),
  since,
  whatsapp: z.strictObject({
    allowlist: z.array(z.strictObject({ jid: z.string().min(1), name: z.string() })),
  }),
  jev: z.strictObject({
    model: z.string().min(1),
    concurrency: z.number().int().positive(),
    thresholds: z.strictObject({ quarantine: probability, action: probability }),
  }),
  extract: z.strictObject({
    model: z.string().min(1),
    timeoutMs: z.number().int().positive(),
  }),
});

export const SettingsPatchSchema = z.strictObject({
  pirate: z.boolean().optional(),
  logo: z.enum(LOGO_IDS).optional(),
});

// Compile-time pin: the zod schema and the shared Settings / SettingsPatch types must not drift.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type AssertTrue<T extends true> = T;
export type SettingsSchemaMatchesShared = AssertTrue<
  Equals<z.infer<typeof SettingsSchema>, Settings>
>;
export type SettingsPatchSchemaMatchesShared = AssertTrue<
  Equals<z.infer<typeof SettingsPatchSchema>, SettingsPatch>
>;

/** A settings file is unreadable, not JSON, or fails the schema. Names the file, never its values. */
export class SettingsError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`invalid settings in ${file}: ${detail}`);
    this.name = "SettingsError";
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

export function parseSettings(raw: unknown, file: string): Settings {
  const result = SettingsSchema.safeParse(raw);
  if (!result.success) throw new SettingsError(file, formatIssues(result.error));
  return result.data;
}

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    throw new SettingsError(
      file,
      `cannot read (${(err as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  } catch {
    throw new SettingsError(file, "not valid JSON");
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Which file the settings came from. */
export type SettingsSource = "private" | "example";

export async function loadSettingsWithSource(
  paths: Paths,
): Promise<{ settings: Settings; source: SettingsSource }> {
  if (await fileExists(paths.settingsFile)) {
    return {
      settings: parseSettings(await readJson(paths.settingsFile), paths.settingsFile),
      source: "private",
    };
  }
  return {
    settings: parseSettings(await readJson(paths.settingsExample), paths.settingsExample),
    source: "example",
  };
}

export async function loadSettings(paths: Paths): Promise<Settings> {
  return (await loadSettingsWithSource(paths)).settings;
}

/** Validates then writes <privateDir>/settings.json via temp file + rename. */
export async function writeSettings(paths: Paths, settings: Settings): Promise<Settings> {
  const valid = parseSettings(settings, paths.settingsFile);
  await writeJsonAtomic(paths.settingsFile, valid);
  return valid;
}

/** Thrown for a PATCH body that is not exactly `{pirate?: boolean, logo?: LogoId}`. */
export class SettingsPatchError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "SettingsPatchError";
  }
}

export function parseSettingsPatch(body: unknown): SettingsPatch {
  const result = SettingsPatchSchema.safeParse(body);
  if (!result.success) throw new SettingsPatchError(formatIssues(result.error));
  return result.data;
}

// Serializes read-modify-write cycles within this process so concurrent PATCHes do not lose updates.
let queue: Promise<unknown> = Promise.resolve();

export function patchSettings(paths: Paths, patch: SettingsPatch): Promise<Settings> {
  const run = async (): Promise<Settings> => {
    const current = await loadSettings(paths);
    const next: Settings = { ...current };
    if (patch.pirate !== undefined) next.pirate = patch.pirate;
    if (patch.logo !== undefined) next.logo = patch.logo;
    return writeSettings(paths, next);
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
