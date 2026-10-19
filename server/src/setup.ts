// `npm run setup` (plan §10): idempotent, never overwrites an existing file. Creates
// <privateDir>/cache/, <privateDir>/settings.json (copied from settings.example.json) and
// <privateDir>/.env with an empty TYPESAFE_API_KEY= line. Prints paths only, never contents.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolvePaths, type Paths } from "./config/paths.js";
import { isMainModule } from "./util/is-main.js";

export interface SetupResult {
  created: string[];
  kept: string[];
}

async function createExclusive(file: string, write: () => Promise<void>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new Error(`setup could not create ${file}: ${(err as Error).message}`);
  }
}

export async function runSetup(paths: Paths): Promise<SetupResult> {
  const result: SetupResult = { created: [], kept: [] };
  const note = (file: string, created: boolean) =>
    (created ? result.created : result.kept).push(file);

  await mkdir(paths.privateDir, { recursive: true });
  const cacheCreated = (await mkdir(paths.cacheDir, { recursive: true })) !== undefined;
  note(paths.cacheDir, cacheCreated);

  note(
    paths.settingsFile,
    await createExclusive(paths.settingsFile, () =>
      // COPYFILE_EXCL (1): fail with EEXIST instead of overwriting.
      copyFile(paths.settingsExample, paths.settingsFile, 1),
    ),
  );
  note(
    paths.envFile,
    await createExclusive(paths.envFile, () =>
      writeFile(paths.envFile, "TYPESAFE_API_KEY=\n", { encoding: "utf8", flag: "wx" }),
    ),
  );
  return result;
}

if (isMainModule(import.meta.url)) {
  const paths = resolvePaths();
  runSetup(paths)
    .then(({ created, kept }) => {
      console.log(`yarvis setup: private dir ${paths.privateDir}`);
      for (const f of created) console.log(`  created ${f}`);
      for (const f of kept) console.log(`  kept    ${f} (already present)`);
    })
    .catch((err: unknown) => {
      console.error(`yarvis setup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
