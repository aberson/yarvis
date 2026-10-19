// Server entry point: binds 127.0.0.1 on PORT (default 8787) (plan §5, D10).
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "./index.js";
import { loadPrivateEnv } from "./config/env.js";
import { isFakeMode, resolvePaths, resolvePorts, type Env } from "./config/paths.js";
import { isMainModule } from "./util/is-main.js";

export const BIND_HOST = "127.0.0.1";

export interface StartedServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startServer(env: Env = process.env): Promise<StartedServer> {
  const paths = resolvePaths(env);
  loadPrivateEnv(paths);
  const { serverPort, webPort } = resolvePorts(env);
  const fake = isFakeMode(env);
  const app = createApp({ paths, fake, webPort });
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(serverPort, BIND_HOST, (err?: Error) => {
      s.off("error", reject);
      if (err) reject(err);
      else resolve(s);
    });
    s.once("error", reject);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `http://${BIND_HOST}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

if (isMainModule(import.meta.url)) {
  startServer()
    .then(({ url }) => {
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
