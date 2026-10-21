// Server entry point: binds 127.0.0.1 on PORT (default 8787) (plan §5, D10).
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, defaultAssistantService, defaultSheetsStore } from "./index.js";
import { loadPrivateEnv } from "./config/env.js";
import { isFakeMode, REPO_ROOT, resolvePaths, resolvePorts, type Env } from "./config/paths.js";
import { isMainModule } from "./util/is-main.js";
import { resetFakePipelineState } from "./pipeline/seams.js";

export const BIND_HOST = "127.0.0.1";

/** A signalled stop waits at most this long for owned assistant work before exiting anyway. */
export const SHUTDOWN_GRACE_MS = 5_000;

export interface StartedServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** `repoRoot` is injectable so tests can point the default private dirs at a temp tree. */
export async function startServer(
  env: Env = process.env,
  repoRoot: string = REPO_ROOT,
): Promise<StartedServer> {
  const paths = resolvePaths(env, repoRoot);
  loadPrivateEnv(paths);
  const { serverPort, webPort } = resolvePorts(env);
  const fake = isFakeMode(env);
  // Fake mode's sheet is in-memory: start its caches/cursors from the fixture state too (D32).
  if (fake) await resetFakePipelineState(paths);
  // Assistant (plan S1): open its SQLite store and reconcile abandoned runs under the assistant
  // lock before serving. Any assistant failure (corrupt/newer/unwritable store, unusable lock path)
  // only makes /api/assistant/* answer 503; the server and Todos still start.
  const sheets = defaultSheetsStore({ paths, fake }, env);
  const assistant = defaultAssistantService({ paths, fake }, sheets);
  await assistant.init().catch((err: unknown) => {
    // init() already fails closed; this guard keeps any surprise from stopping the server.
    console.error(
      `[yarvis] assistant startup recovery failed (${err instanceof Error ? err.name : "error"})`,
    );
  });
  const app = createApp({ paths, fake, webPort, sheets, assistant });
  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const s = app.listen(serverPort, BIND_HOST, (err?: Error) => {
        s.off("error", reject);
        if (err) reject(err);
        else resolve(s);
      });
      s.once("error", reject);
    });
  } catch (err) {
    await assistant.close();
    throw err;
  }
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `http://${BIND_HOST}:${port}`,
    // Stop accepting, then let the assistant finish its owned work and close its database.
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      server.closeIdleConnections();
      await Promise.all([closed, assistant.close()]);
    },
  };
}

if (isMainModule(import.meta.url)) {
  startServer()
    .then((started) => {
      const { url } = started;
      // Graceful stop: the assistant settles its owned run and closes its database (bounded).
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        const force = setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
        force.unref();
        void started
          .close()
          .catch(() => undefined)
          .finally(() => process.exit(0));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      const env = process.env;
      const paths = resolvePaths(env);
      console.log(
        `yarvis server listening on ${url}${isFakeMode(env) ? " (fake mode)" : ""}; private dir ${paths.privateDir}`,
      );
    })
    .catch((err: unknown) => {
      console.error(
        `yarvis server failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    });
}
