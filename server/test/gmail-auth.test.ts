// `yarvis gmail:auth` (plan §5, §8, M1): the desktop loopback OAuth flow, driven end to end through
// the CLI entry (runCli) with an injected fake OAuth client and a fake "browser" that follows the
// consent redirect to the real 127.0.0.1 loopback listener. No network beyond loopback.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliDeps, type CliIo } from "../src/cli.js";
import {
  GMAIL_READONLY_SCOPE,
  loadCredentials,
  type AuthUrlOptions,
  type ExchangedTokens,
  type OAuthClientConfig,
  type OAuthFlowClient,
} from "../src/connectors/gmail.js";
import { REPO_ROOT, type Paths } from "../src/config/paths.js";
import { tempPaths } from "./helpers.js";

const ACCESS = "SYNTHETIC-ACCESS-TOKEN-VALUE-7f3a";
const REFRESH = "SYNTHETIC-REFRESH-TOKEN-VALUE-9c1e";
const CLIENT_SECRET = "SYNTHETIC-CLIENT-SECRET-55aa";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function capture(): CliIo & { out_: string[]; err_: string[] } {
  const out_: string[] = [];
  const err_: string[] = [];
  return { out_, err_, out: (l) => out_.push(l), err: (l) => err_.push(l) };
}

function setup(opts: { client?: boolean } = {}): Paths {
  const t = tempPaths();
  cleanups.push(t.cleanup);
  if (opts.client !== false) {
    writeFileSync(
      t.paths.oauthClientFile,
      JSON.stringify({
        installed: {
          client_id: "synthetic-client.apps.googleusercontent.com",
          client_secret: CLIENT_SECRET,
          redirect_uris: ["http://localhost"],
        },
      }),
    );
  }
  return t.paths;
}

interface FakeFlow {
  deps: CliDeps["gmailAuth"];
  seen: {
    client?: OAuthClientConfig;
    redirectUri?: string;
    authUrl?: AuthUrlOptions;
    exchange?: { code: string; codeVerifier: string };
    browserStatus: number[];
    /** Calls of the injected seams; only runGmailAuth invokes them. */
    calls: { createOAuthClient: number; openBrowser: number; getToken: number };
  };
}

/**
 * A fake Google: generateAuthUrl records its options; the "browser" GETs the loopback redirect
 * with `query` (default: the right state + a code), optionally after a forged-state request.
 */
function fakeFlow(
  opts: {
    tokens?: ExchangedTokens;
    query?: (state: string) => string;
    forgeFirst?: boolean;
    browser?: "follow" | "ignore";
    /** Send a raw malformed request target ("//") to the loopback first. */
    malformedFirst?: boolean;
  } = {},
): FakeFlow {
  const seen: FakeFlow["seen"] = {
    browserStatus: [],
    calls: { createOAuthClient: 0, openBrowser: 0, getToken: 0 },
  };
  const tokens: ExchangedTokens = opts.tokens ?? {
    access_token: ACCESS,
    refresh_token: REFRESH,
    scope: GMAIL_READONLY_SCOPE,
    token_type: "Bearer",
    expiry_date: 1792454400000,
  };
  const createOAuthClient = (
    client: OAuthClientConfig,
    redirectUri: string,
  ): Promise<OAuthFlowClient> => {
    seen.calls.createOAuthClient++;
    seen.client = client;
    seen.redirectUri = redirectUri;
    return Promise.resolve({
      generateCodeVerifierAsync: () =>
        Promise.resolve({ codeVerifier: "verifier-1", codeChallenge: "challenge-1" }),
      generateAuthUrl: (o: AuthUrlOptions) => {
        seen.authUrl = o;
        const u = new URL("https://accounts.example.com/o/oauth2/v2/auth");
        u.searchParams.set("redirect_uri", redirectUri);
        u.searchParams.set("state", o.state);
        u.searchParams.set("scope", o.scope.join(" "));
        return u.toString();
      },
      getToken: (o: { code: string; codeVerifier: string }) => {
        seen.calls.getToken++;
        seen.exchange = o;
        return Promise.resolve({ tokens });
      },
    });
  };
  const openBrowser = async (url: string) => {
    seen.calls.openBrowser++;
    if (opts.browser === "ignore") return;
    const u = new URL(url);
    const redirect = u.searchParams.get("redirect_uri") ?? "";
    const state = u.searchParams.get("state") ?? "";
    if (opts.malformedFirst) seen.browserStatus.push(await rawGet(redirect, "//"));
    if (opts.forgeFirst) {
      const forged = await fetch(`${redirect}/?code=evil&state=forged`);
      seen.browserStatus.push(forged.status);
    }
    const favicon = await fetch(`${redirect}/favicon.ico`);
    seen.browserStatus.push(favicon.status);
    const query = opts.query ? opts.query(state) : `code=auth-code-1&state=${state}`;
    const res = await fetch(`${redirect}/?${query}`);
    seen.browserStatus.push(res.status);
  };
  return { deps: { createOAuthClient, openBrowser, consentTimeoutMs: 2_000 }, seen };
}

/** GET with a raw request target, bypassing URL normalization; resolves the status code. */
function rawGet(base: string, target: string): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: Number(u.port), method: "GET", path: target },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function leaked(io: { out_: string[]; err_: string[] }): boolean {
  const all = [...io.out_, ...io.err_].join("\n");
  return [ACCESS, REFRESH, CLIENT_SECRET, "auth-code-1", "verifier-1"].some((v) => all.includes(v));
}

describe("yarvis gmail:auth via runCli (injected fake OAuth)", () => {
  it("runs the loopback flow, writes the read-only token, and prints only 'ok'", async () => {
    const paths = setup();
    const flow = fakeFlow();
    const io = capture();
    expect(await runCli(["gmail:auth"], io, { paths, gmailAuth: flow.deps })).toBe(0);
    expect(io.out_).toEqual(["ok"]);
    expect(io.err_).toEqual([]);
    expect(leaked(io)).toBe(false);
    // Wiring proof: the CLI verb reached runGmailAuth, which drove each injected seam exactly once.
    expect(flow.seen.calls).toEqual({ createOAuthClient: 1, openBrowser: 1, getToken: 1 });

    // Loopback on 127.0.0.1 with an ephemeral port; consent asked for exactly gmail.readonly.
    expect(flow.seen.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(flow.seen.redirectUri).not.toMatch(/:0$/);
    expect(flow.seen.client).toEqual({
      clientId: "synthetic-client.apps.googleusercontent.com",
      clientSecret: CLIENT_SECRET,
    });
    expect(flow.seen.authUrl).toMatchObject({
      access_type: "offline",
      prompt: "consent",
      scope: [GMAIL_READONLY_SCOPE],
      code_challenge_method: "S256",
      code_challenge: "challenge-1",
    });
    expect(flow.seen.authUrl?.state).toMatch(/^[0-9a-f]{32}$/);
    expect(flow.seen.exchange).toEqual({ code: "auth-code-1", codeVerifier: "verifier-1" });
    expect(flow.seen.browserStatus).toEqual([404, 200]);

    const written = JSON.parse(readFileSync(paths.gmailTokenFile, "utf8")) as unknown;
    expect(written).toEqual({
      refresh_token: REFRESH,
      scope: GMAIL_READONLY_SCOPE,
      access_token: ACCESS,
      token_type: "Bearer",
      expiry_date: 1792454400000,
    });
    // The minted token passes the load-time recorded-scope check.
    await expect(loadCredentials(paths)).resolves.toMatchObject({ scope: GMAIL_READONLY_SCOPE });
    if (process.platform !== "win32") {
      expect(statSync(paths.gmailTokenFile).mode & 0o077).toBe(0);
    }
  });

  it("ignores a redirect with a forged state and still completes with the real one", async () => {
    const paths = setup();
    const flow = fakeFlow({ forgeFirst: true });
    const io = capture();
    expect(await runCli(["gmail:auth"], io, { paths, gmailAuth: flow.deps })).toBe(0);
    expect(flow.seen.browserStatus).toEqual([400, 404, 200]);
    expect(flow.seen.exchange?.code).toBe("auth-code-1");
  });

  it("answers a malformed request target with 400 and still completes on the real redirect", async () => {
    const paths = setup();
    const flow = fakeFlow({ malformedFirst: true });
    const io = capture();
    expect(await runCli(["gmail:auth"], io, { paths, gmailAuth: flow.deps })).toBe(0);
    expect(io.out_).toEqual(["ok"]);
    expect(flow.seen.browserStatus).toEqual([400, 404, 200]);
    expect(flow.seen.exchange?.code).toBe("auth-code-1");
    expect(existsSync(paths.gmailTokenFile)).toBe(true);
  });

  it("refuses a grant wider than gmail.readonly and writes no token", async () => {
    const paths = setup();
    const flow = fakeFlow({
      tokens: {
        access_token: ACCESS,
        refresh_token: REFRESH,
        scope: `${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.modify`,
      },
    });
    const io = capture();
    expect(await runCli(["gmail:auth"], io, { paths, gmailAuth: flow.deps })).toBe(1);
    expect(io.out_).toEqual([]);
    expect(io.err_.join("\n")).toMatch(/scope other than exactly .*gmail\.readonly; no token/);
    expect(existsSync(paths.gmailTokenFile)).toBe(false);
    expect(leaked(io)).toBe(false);
  });

  it("a denied consent fails cleanly with no token", async () => {
    const paths = setup();
    const flow = fakeFlow({ query: (state) => `error=access_denied&state=${state}` });
    const io = capture();
    expect(await runCli(["gmail:auth"], io, { paths, gmailAuth: flow.deps })).toBe(1);
    expect(io.err_.join("\n")).toContain("Gmail consent was not granted (access_denied)");
    expect(existsSync(paths.gmailTokenFile)).toBe(false);
  });

  it("no refresh token -> error, no file", async () => {
    const paths = setup();
    const flow = fakeFlow({ tokens: { access_token: ACCESS, scope: GMAIL_READONLY_SCOPE } });
    const io = capture();
    expect(await runCli(["gmail:auth"], io, { paths, gmailAuth: flow.deps })).toBe(1);
    expect(io.err_.join("\n")).toContain("no refresh token");
    expect(existsSync(paths.gmailTokenFile)).toBe(false);
  });

  it("times out when consent never arrives", async () => {
    const paths = setup();
    const flow = fakeFlow({ browser: "ignore" });
    const io = capture();
    const code = await runCli(["gmail:auth"], io, {
      paths,
      gmailAuth: { ...flow.deps, consentTimeoutMs: 100 },
    });
    expect(code).toBe(1);
    expect(io.err_.join("\n")).toContain("Gmail consent was not completed");
  });

  it("missing OAuth client JSON -> not configured, never starts the flow", async () => {
    const paths = setup({ client: false });
    const flow = fakeFlow();
    const io = capture();
    expect(await runCli(["gmail:auth"], io, { paths, gmailAuth: flow.deps })).toBe(1);
    expect(io.err_.join("\n")).toContain("google-oauth-client.json");
    expect(flow.seen.redirectUri).toBeUndefined();
  });

  it("a web (non-Desktop) OAuth client is rejected without echoing it", async () => {
    const paths = setup({ client: false });
    writeFileSync(
      paths.oauthClientFile,
      JSON.stringify({ web: { client_id: "x", client_secret: CLIENT_SECRET } }),
    );
    const io = capture();
    expect(await runCli(["gmail:auth"], io, { paths, gmailAuth: fakeFlow().deps })).toBe(1);
    expect(io.err_.join("\n")).toContain("not a Desktop-app OAuth client");
    expect(leaked(io)).toBe(false);
  });

  it("a library error during exchange is reported without its message", async () => {
    const paths = setup();
    const flow = fakeFlow();
    const base = flow.deps.createOAuthClient;
    const io = capture();
    const code = await runCli(["gmail:auth"], io, {
      paths,
      gmailAuth: {
        ...flow.deps,
        createOAuthClient: async (c, r) => ({
          ...(await base(c, r)),
          getToken: () =>
            Promise.reject(Object.assign(new Error(`bad ${REFRESH}`), { status: 400 })),
        }),
      },
    });
    expect(code).toBe(1);
    expect(io.err_.join("\n")).toContain("Gmail token exchange failed (HTTP 400)");
    expect(leaked(io)).toBe(false);
  });

  it("rejects arguments", async () => {
    const io = capture();
    expect(await runCli(["gmail:auth", "--scope=all"], io, { paths: setup() })).toBe(2);
  });
});

describe("cli entry point (tsx server/src/cli.ts gmail:auth)", () => {
  it("is wired: with no OAuth client it exits 1 naming the missing file, stdout empty", () => {
    const paths = setup({ client: false });
    const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
    const res = spawnSync(
      process.execPath,
      [tsxCli, path.join(REPO_ROOT, "server", "src", "cli.ts"), "gmail:auth"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, YARVIS_PRIVATE_DIR: paths.privateDir },
        timeout: 60_000,
      },
    );
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("yarvis gmail:auth: Gmail OAuth client not configured");
    expect(res.stderr).toContain("google-oauth-client.json");
  });
});
