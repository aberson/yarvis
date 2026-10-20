// Gmail read-only connector (plan §1.2, §3.2, §3.3, §5, §8, D20, D21, D29). The ONLY Gmail importer.
// Read-only is enforced three ways here:
//   1. SCOPES is exactly the gmail.readonly scope and is the only scope ever requested (consent URL,
//      token exchange check, API client);
//   2. loadCredentials re-checks the scope RECORDED in private/gmail-token.json and refuses anything
//      but exactly that scope (provenance independent of the pin: a token minted earlier with wider
//      scopes would otherwise pass a code-only check);
//   3. the `GmailApi` surface below has only two read methods (list, get); a test greps this file
//      for every mutating Gmail call shape and fails the suite on any match.
// Nothing here logs: message bodies, headers and token values never reach a console or a log line.
// Every error message names files and kinds, never values read from private/.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { convert as htmlToText } from "html-to-text";
import { z } from "zod";
import { gmailId, type Message } from "@yarvis/shared";
import type { Paths } from "../config/paths.js";
import { writeJsonAtomic, type AtomicFs } from "../util/atomic-write.js";
import {
  callWithRetry,
  DEFAULT_CALL_TIMEOUT_MS,
  httpStatusOf,
  TimeoutError,
  withTimeout,
  type RetryOptions,
} from "../util/retry.js";
import { truncateText, extractLinks, tidyText } from "../util/text.js";

/** The ONLY OAuth scope Yarvis ever requests for Gmail (§1.2, §8). Exact-equality tested. */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const SCOPES = Object.freeze([GMAIL_READONLY_SCOPE] as const);

/** messages.get calls in flight at once (§5). */
export const GET_CONCURRENCY = 4;
/** messages.list page size. */
export const LIST_PAGE_SIZE = 500;
/** Each fetch overlaps the cursor by 24 h; id dedup absorbs the overlap (D21). */
export const CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1000;
/** How long `yarvis gmail:auth` waits for the browser consent redirect. */
export const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

export const GMAIL_WEB_LINK_PREFIX = "https://mail.google.com/mail/u/0/#all/";

// ---------------------------------------------------------------------------------------------
// Errors.

export type GmailErrorKind =
  /** No OAuth client / token file (run `yarvis gmail:auth`). */
  | "not_configured"
  /** The token's recorded scope is not exactly gmail.readonly: refused, never used. */
  | "scope_refused"
  /** The token or client file is unreadable, not JSON, or missing required fields. */
  | "token_invalid"
  /** Consent failed, or the token expired / was revoked (run `yarvis gmail:auth`). */
  | "auth"
  /** The Gmail API failed after retries, or timed out. */
  | "upstream";

/** `cause` may carry auth material (request/response, tokens): never log or print it. */
export class GmailError extends Error {
  constructor(
    readonly kind: GmailErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GmailError";
  }
}

const REAUTH = "run `npm run yarvis -- gmail:auth`";

// ---------------------------------------------------------------------------------------------
// Token + OAuth client files.

/** `private/gmail-token.json`: the googleapis Credentials object from `oauth2Client.getToken()`. */
export interface GmailToken {
  access_token?: string;
  refresh_token: string;
  /** Space-separated granted scopes; must be exactly `GMAIL_READONLY_SCOPE`. */
  scope: string;
  token_type?: string;
  expiry_date?: number;
}

/** The Desktop-app OAuth client (`{"installed": {...}}` as downloaded from Google Cloud). */
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

const OAuthClientFileSchema = z.object({
  installed: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
  }),
});

/** True when `scope` (space-separated, as recorded by Google) is exactly the read-only scope. */
export function isReadonlyScope(scope: unknown): boolean {
  if (typeof scope !== "string") return false;
  const granted = scope.split(" ");
  return granted.length === SCOPES.length && granted.every((s, i) => s === SCOPES[i]);
}

async function readJsonFile(file: string, missing: GmailError): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw missing;
    throw new GmailError(
      "token_invalid",
      `cannot read ${path.basename(file)} (${(err as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  } catch {
    throw new GmailError("token_invalid", `${path.basename(file)} is not valid JSON; ${REAUTH}`);
  }
}

/**
 * Loads `private/gmail-token.json` and refuses it unless its recorded `scope` is exactly
 * gmail.readonly (§8). Called on every fetch, so a token swapped on disk is re-checked.
 */
export async function loadCredentials(paths: Pick<Paths, "gmailTokenFile">): Promise<GmailToken> {
  const file = paths.gmailTokenFile;
  const name = path.basename(file);
  const raw = await readJsonFile(
    file,
    new GmailError("not_configured", `Gmail not connected (${name} is missing); ${REAUTH}`),
  );
  const rec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  if (!rec) throw new GmailError("token_invalid", `${name} is not a token object; ${REAUTH}`);
  if (!isReadonlyScope(rec.scope)) {
    throw new GmailError(
      "scope_refused",
      `${name} is refused: its recorded scope is not exactly ${GMAIL_READONLY_SCOPE} (Yarvis only ever uses a read-only Gmail token). Delete ${name} and ${REAUTH}`,
    );
  }
  if (typeof rec.refresh_token !== "string" || rec.refresh_token === "") {
    throw new GmailError("token_invalid", `${name} has no refresh token; ${REAUTH}`);
  }
  const token: GmailToken = { refresh_token: rec.refresh_token, scope: rec.scope as string };
  if (typeof rec.access_token === "string") token.access_token = rec.access_token;
  if (typeof rec.token_type === "string") token.token_type = rec.token_type;
  if (typeof rec.expiry_date === "number") token.expiry_date = rec.expiry_date;
  return token;
}

/** Loads the Desktop OAuth client from `private/google-oauth-client.json`. */
export async function loadOAuthClient(
  paths: Pick<Paths, "oauthClientFile">,
): Promise<OAuthClientConfig> {
  const name = path.basename(paths.oauthClientFile);
  const raw = await readJsonFile(
    paths.oauthClientFile,
    new GmailError(
      "not_configured",
      `Gmail OAuth client not configured: download the Desktop-app OAuth client JSON to the private folder as ${name}`,
    ),
  );
  const parsed = OAuthClientFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GmailError(
      "token_invalid",
      `${name} is not a Desktop-app OAuth client (expected {"installed": {"client_id", "client_secret"}})`,
    );
  }
  return {
    clientId: parsed.data.installed.client_id,
    clientSecret: parsed.data.installed.client_secret,
  };
}

/** Restrictive intent: the token file is created owner-read/write only (0600 on POSIX). */
const ownerOnlyFs: AtomicFs = {
  mkdir: (dir, opts) => fs.mkdir(dir, opts),
  writeFile: (file, data, encoding) => fs.writeFile(file, data, { encoding, mode: 0o600 }),
  rename: (from, to) => fs.rename(from, to),
  rm: (file, opts) => fs.rm(file, opts),
};

/** Writes the token atomically (temp file + rename), owner-only. Never logs it. */
export async function writeToken(
  paths: Pick<Paths, "gmailTokenFile">,
  token: GmailToken,
): Promise<void> {
  const out: GmailToken = { refresh_token: token.refresh_token, scope: token.scope };
  if (token.access_token !== undefined) out.access_token = token.access_token;
  if (token.token_type !== undefined) out.token_type = token.token_type;
  if (token.expiry_date !== undefined) out.expiry_date = token.expiry_date;
  await writeJsonAtomic(paths.gmailTokenFile, out, ownerOnlyFs);
}

// ---------------------------------------------------------------------------------------------
// `yarvis gmail:auth`: desktop loopback OAuth flow (PKCE + state) on 127.0.0.1:<ephemeral port>.

/** Tokens as returned by the OAuth token exchange (googleapis `Credentials`). */
export interface ExchangedTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
  expiry_date?: number | null;
}

export interface AuthUrlOptions {
  access_type: "offline";
  prompt: "consent";
  scope: string[];
  state: string;
  code_challenge_method: "S256";
  code_challenge: string;
}

/** The OAuth2 client surface the flow uses; the real one wraps googleapis `OAuth2Client`. */
export interface OAuthFlowClient {
  generateCodeVerifierAsync(): Promise<{ codeVerifier: string; codeChallenge?: string }>;
  generateAuthUrl(opts: AuthUrlOptions): string;
  getToken(opts: { code: string; codeVerifier: string }): Promise<{ tokens: ExchangedTokens }>;
}

export interface GmailAuthDeps {
  paths: Pick<Paths, "oauthClientFile" | "gmailTokenFile">;
  /** Builds the OAuth2 client bound to the loopback redirect URI. */
  createOAuthClient: (client: OAuthClientConfig, redirectUri: string) => Promise<OAuthFlowClient>;
  /** Opens the consent URL in the operator's browser (the URL is never printed). */
  openBrowser: (url: string) => Promise<void>;
  consentTimeoutMs?: number;
  /** Token-exchange call timeout (default 30 s, D20). */
  timeoutMs?: number;
}

export async function createGoogleOAuthClient(
  client: OAuthClientConfig,
  redirectUri: string,
): Promise<OAuthFlowClient> {
  const { google, Auth } = await import("googleapis");
  const oauth = new google.auth.OAuth2({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    redirectUri,
  });
  return {
    generateCodeVerifierAsync: () => oauth.generateCodeVerifierAsync(),
    generateAuthUrl: (opts) =>
      oauth.generateAuthUrl({ ...opts, code_challenge_method: Auth.CodeChallengeMethod.S256 }),
    getToken: async (opts) => {
      const res = await oauth.getToken({
        code: opts.code,
        codeVerifier: opts.codeVerifier,
        redirect_uri: redirectUri,
      });
      return { tokens: res.tokens };
    },
  };
}

/** Opens `url` with the platform's default handler, without a shell (no metacharacter parsing). */
export async function openInBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () =>
      reject(new GmailError("auth", "could not open a browser for Gmail consent")),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${body}</p>`;

interface Loopback {
  redirectUri: string;
  code: Promise<string>;
  close(): Promise<void>;
}

/** Listens on 127.0.0.1:<ephemeral>; resolves the first redirect carrying `code` + our `state`. */
async function startLoopback(expectedState: string, consentTimeoutMs: number): Promise<Loopback> {
  let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A denial/timeout can land before the caller awaits `code`: never an unhandled rejection.
  code.catch(() => undefined);
  let done = false;
  const finish = (fn: () => void) => {
    if (done) return;
    done = true;
    fn();
  };
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const html = (status: number, title: string, body: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
      res.end(PAGE(title, body));
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      // A malformed request target (e.g. "//") is not the consent redirect: 400, keep waiting.
      html(400, "Bad request", "Bad request.");
      return;
    }
    const params = url.searchParams;
    if (!params.has("code") && !params.has("error")) {
      html(404, "Not found", "Not found.");
      return;
    }
    if (params.get("state") !== expectedState) {
      // Not our consent round-trip (CSRF guard): reject this request, keep waiting.
      html(400, "Yarvis", "This sign-in link does not match the running gmail:auth. Ignored.");
      return;
    }
    if (params.has("error")) {
      const reason = (params.get("error") ?? "").replace(/[^a-z_]/gi, "").slice(0, 40);
      html(200, "Yarvis", "Gmail access was not granted. You can close this tab.");
      finish(() =>
        settle.reject(new GmailError("auth", `Gmail consent was not granted (${reason})`)),
      );
      return;
    }
    html(200, "Yarvis", "Gmail read-only access granted. You can close this tab.");
    finish(() => settle.resolve(params.get("code") ?? ""));
  };
  // No throw inside a request may escape the listener (it would crash gmail:auth): answer 400 if
  // nothing was sent yet, and keep waiting for the real redirect.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      handle(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      }
      if (!res.writableEnded) res.end("Bad request.");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const timer = setTimeout(
    () =>
      finish(() =>
        settle.reject(
          new GmailError(
            "auth",
            `Gmail consent was not completed within ${Math.round(consentTimeoutMs / 1000)} s`,
          ),
        ),
      ),
    consentTimeoutMs,
  );
  const port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${port}`,
    code,
    close: () =>
      new Promise<void>((resolve) => {
        clearTimeout(timer);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * `yarvis gmail:auth`: consent in the browser for exactly SCOPES, exchange the code (PKCE), refuse
 * any grant that is not exactly gmail.readonly, and write private/gmail-token.json atomically.
 * Throws GmailError (safe message) on any failure; never returns or prints token values.
 */
export async function runGmailAuth(deps: GmailAuthDeps): Promise<void> {
  const client = await loadOAuthClient(deps.paths);
  const state = randomBytes(16).toString("hex");
  const loopback = await startLoopback(state, deps.consentTimeoutMs ?? CONSENT_TIMEOUT_MS);
  try {
    const oauth = await deps.createOAuthClient(client, loopback.redirectUri);
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
    if (!codeChallenge) throw new GmailError("auth", "PKCE code challenge unavailable");
    const url = oauth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [...SCOPES],
      state,
      code_challenge_method: "S256",
      code_challenge: codeChallenge,
    });
    await deps.openBrowser(url);
    const code = await loopback.code;
    let tokens: ExchangedTokens;
    try {
      ({ tokens } = await withTimeout(
        () => oauth.getToken({ code, codeVerifier }),
        deps.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      ));
    } catch (err) {
      const status = httpStatusOf(err);
      throw new GmailError(
        "auth",
        err instanceof TimeoutError
          ? "Gmail token exchange timed out"
          : `Gmail token exchange failed${status === undefined ? "" : ` (HTTP ${status})`}`,
        { cause: err },
      );
    }
    if (!isReadonlyScope(tokens.scope)) {
      throw new GmailError(
        "scope_refused",
        `Google granted a scope other than exactly ${GMAIL_READONLY_SCOPE}; no token was written`,
      );
    }
    if (!tokens.refresh_token) {
      throw new GmailError(
        "auth",
        "Google returned no refresh token; revoke Yarvis at https://myaccount.google.com/permissions and run gmail:auth again",
      );
    }
    const token: GmailToken = { refresh_token: tokens.refresh_token, scope: GMAIL_READONLY_SCOPE };
    if (tokens.access_token) token.access_token = tokens.access_token;
    if (tokens.token_type) token.token_type = tokens.token_type;
    if (typeof tokens.expiry_date === "number") token.expiry_date = tokens.expiry_date;
    await writeToken(deps.paths, token);
  } finally {
    await loopback.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The read-only API surface, raw message shape, query.

export interface CallOpts {
  timeoutMs: number;
  signal: AbortSignal;
}

/** A `users.messages.get` (format full) message part (subset of gmail_v1.Schema$MessagePart). */
export interface RawMessagePart {
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
  body?: { attachmentId?: string | null; size?: number | null; data?: string | null } | null;
  parts?: RawMessagePart[] | null;
}

/** A `users.messages.get` (format full) response (subset of gmail_v1.Schema$Message). */
export interface RawMessage {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  internalDate?: string | null;
  payload?: RawMessagePart | null;
}

export interface ListParams {
  userId: "me";
  q: string;
  labelIds: string[];
  maxResults: number;
  pageToken?: string;
}

/**
 * The ONLY Gmail methods Yarvis has: two reads. The real client is adapted to it in
 * `createGoogleGmailApi`; tests and fake mode use FakeGmailApi (server/src/fakes/gmail.ts).
 */
export interface GmailApi {
  users: {
    messages: {
      list(
        params: ListParams,
        opts: CallOpts,
      ): Promise<{
        data: {
          messages?: Array<{ id?: string | null }> | null;
          nextPageToken?: string | null;
        };
      }>;
      get(
        params: { userId: "me"; id: string; format: "full" },
        opts: CallOpts,
      ): Promise<{ data: RawMessage }>;
    };
  };
}

/** Fetch cursor: `settings.since` (YYYY-MM-DD, read as 00:00:00Z) and `state.gmail.lastRunAt`. */
export interface GmailCursor {
  since: string;
  lastRunAt?: string | null;
}

/** Epoch seconds of max(since 00:00:00Z, lastRunAt − 24 h) (§3.3, D21). */
export function afterEpoch(cursor: GmailCursor): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cursor.since)) {
    throw new RangeError("gmail cursor: since must be YYYY-MM-DD");
  }
  const sinceMs = Date.parse(`${cursor.since}T00:00:00Z`);
  // Round-trip guard: Date.parse rolls impossible days over (2026-02-30 -> 2026-03-02), which
  // would silently move the after: floor; the parsed UTC date must give back the same Y-M-D.
  if (Number.isNaN(sinceMs) || new Date(sinceMs).toISOString().slice(0, 10) !== cursor.since) {
    throw new RangeError("gmail cursor: since is not a real date");
  }
  let floorMs = sinceMs;
  if (cursor.lastRunAt) {
    const lastMs = Date.parse(cursor.lastRunAt);
    if (Number.isNaN(lastMs)) throw new RangeError("gmail cursor: lastRunAt is not an ISO date");
    floorMs = Math.max(sinceMs, lastMs - CURSOR_OVERLAP_MS);
  }
  return Math.floor(floorMs / 1000);
}

/** The INBOX query (§5): `after:<epoch> -in:spam -in:trash` (paired with labelIds ["INBOX"]). */
export function gmailQuery(cursor: GmailCursor): string {
  return `after:${afterEpoch(cursor)} -in:spam -in:trash`;
}

// ---------------------------------------------------------------------------------------------
// MIME -> Message normalization.

function headerOf(part: RawMessagePart | null | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  const h = part?.headers?.find((x) => (x.name ?? "").toLowerCase() === lower);
  return h?.value ?? undefined;
}

/** Decodes bytes in `charset`, falling back to UTF-8 for unknown labels. */
function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? "utf-8").trim().toLowerCase().split("*")[0] || "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

function charsetOf(part: RawMessagePart): string | undefined {
  const ct = headerOf(part, "Content-Type") ?? "";
  return /charset\s*=\s*"?([^";\s]+)"?/i.exec(ct)?.[1];
}

function qBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const hex = text.slice(i + 1, i + 3);
    if (ch === "=" && /^[0-9a-f]{2}$/i.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else if (ch === "_") {
      out.push(0x20);
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/** RFC 2047 encoded-words (`=?charset?B|Q?...?=`) in a header value, any charset. */
export function decodeHeaderValue(value: string): string {
  if (!value.includes("=?")) return value;
  // Whitespace between two adjacent encoded-words is not part of the text.
  const joined = value.replace(/(\?=)\s+(?==\?[^?\s]+\?[BbQq]\?)/g, "$1");
  return joined.replace(ENCODED_WORD, (_m, charset: string, enc: string, text: string) =>
    decodeBytes(enc.toUpperCase() === "B" ? Buffer.from(text, "base64") : qBytes(text), charset),
  );
}

/** Gmail `body.data` is base64url of the part's bytes (transfer encoding already removed). */
function partText(part: RawMessagePart): string {
  const data = part.body?.data;
  if (!data) return "";
  return decodeBytes(Buffer.from(data, "base64url"), charsetOf(part));
}

function isAttachment(part: RawMessagePart): boolean {
  if (part.filename) return true;
  return /^\s*attachment/i.test(headerOf(part, "Content-Disposition") ?? "");
}

function collectText(part: RawMessagePart, out: { plain: string[]; html: string[] }): void {
  if (isAttachment(part)) return;
  if (part.parts && part.parts.length > 0) {
    for (const child of part.parts) collectText(child, out);
    return;
  }
  const mime = (part.mimeType ?? "").toLowerCase();
  if (mime === "text/plain") out.plain.push(partText(part));
  else if (mime === "text/html") out.html.push(partText(part));
}

const HTML_TO_TEXT_OPTIONS = {
  wordwrap: false as const,
  selectors: [
    { selector: "a", options: { ignoreHref: true } },
    { selector: "img", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "script", format: "skip" },
  ],
};

/** HTML -> plain text (html-to-text): tags, styles and scripts stripped. */
export function htmlToPlainText(html: string): string {
  return htmlToText(html, HTML_TO_TEXT_OPTIONS);
}

/** http(s) hrefs in HTML (phishing links often hide behind anchor text). */
function htmlHrefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? "").trim().replace(/&amp;/gi, "&");
    if (/^https?:\/\//i.test(href)) out.push(href);
  }
  return out;
}

/** "Name <a@b>" -> "a@b"; a bare address stays; anything else is returned decoded and trimmed. */
export function fromAddress(from: string): string {
  const decoded = decodeHeaderValue(from).trim();
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(decoded);
  return angle ? (angle[1] as string) : decoded;
}

function isoDate(raw: RawMessage): string {
  const internal = Number(raw.internalDate);
  if (raw.internalDate && Number.isFinite(internal)) return new Date(internal).toISOString();
  const header = Date.parse(headerOf(raw.payload, "Date") ?? "");
  return new Date(Number.isNaN(header) ? 0 : header).toISOString();
}

/**
 * MIME -> Message (§3.2): text/plain preferred (all inline plain parts), else text/html stripped
 * with html-to-text, else the snippet; per-part charset honoured; capped at 4000 chars on a
 * code-point boundary; links from the text and from HTML hrefs; Gmail web deep link.
 */
export function normalizeGmailMessage(raw: RawMessage): Message {
  const hexId = raw.id ?? "";
  const id = gmailId(hexId);
  const parts = { plain: [] as string[], html: [] as string[] };
  if (raw.payload) collectText(raw.payload, parts);
  let text = tidyText(parts.plain.join("\n\n"));
  if (!text && parts.html.length > 0) {
    text = tidyText(parts.html.map(htmlToPlainText).join("\n\n"));
  }
  if (!text && raw.snippet) text = tidyText(htmlToPlainText(raw.snippet));
  const links = [
    ...new Set([...extractLinks(text), ...parts.html.flatMap(htmlHrefs)].filter(Boolean)),
  ];
  return {
    id,
    source: "gmail",
    sender: fromAddress(headerOf(raw.payload, "From") ?? ""),
    context: decodeHeaderValue(headerOf(raw.payload, "Subject") ?? "").trim(),
    date: isoDate(raw),
    text: truncateText(text),
    links,
    link: `${GMAIL_WEB_LINK_PREFIX}${hexId}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The connector.

export interface GmailFetchResult {
  /** Newly fetched, normalized messages (list order). */
  messages: Message[];
  /** Ids returned by messages.list for the query. */
  listed: number;
  /** Listed ids skipped because they were already cached (no messages.get call). */
  skippedCached: number;
}

export interface GmailConnector {
  /**
   * Lists INBOX ids for `gmailQuery(cursor)` (all pages), then `messages.get` (format full) only
   * for ids whose Message id (`gmail:<hex>`) is not in `knownIds`, at most GET_CONCURRENCY at once.
   * Aborting `signal` stops it scheduling further list/get calls (in-flight calls finish within
   * their per-call timeout) and rejects with a GmailError.
   */
  fetchSince(
    cursor: GmailCursor,
    knownIds: ReadonlySet<string>,
    opts?: { signal?: AbortSignal },
  ): Promise<GmailFetchResult>;
  /**
   * `yarvis doctor`'s live check (§5): ONE INBOX `messages.list` with maxResults 1 (a read; the
   * listed id is discarded). Resolving the API re-runs the recorded-scope check in real mode.
   */
  probe(): Promise<void>;
}

export interface GmailConnectorOptions {
  /** A fixed API, or a resolver called once per fetch (real mode re-loads + re-checks the token). */
  api: GmailApi | (() => Promise<GmailApi>);
  timeoutMs?: number;
  retry?: RetryOptions;
  concurrency?: number;
  pageSize?: number;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight; stops launching after a failure or once
 * `signal` is aborted.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      if (signal?.aborted) {
        failed = true;
        throw cancelled();
      }
      const i = next++;
      try {
        out[i] = await fn(items[i] as T);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return out;
}

function cancelled(): GmailError {
  return new GmailError("upstream", "Gmail fetch cancelled");
}

function isAuthFailure(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status === 401) return true;
  const e = err as { message?: unknown; response?: { data?: { error?: unknown } } } | null;
  return (
    e?.response?.data?.error === "invalid_grant" ||
    (typeof e?.message === "string" && /invalid_grant/.test(e.message))
  );
}

export function createGmailConnector(opts: GmailConnectorOptions): GmailConnector {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const concurrency = opts.concurrency ?? GET_CONCURRENCY;
  const pageSize = opts.pageSize ?? LIST_PAGE_SIZE;
  const resolveApi =
    typeof opts.api === "function" ? opts.api : () => Promise.resolve(opts.api as GmailApi);

  async function call<T>(what: string, fn: (o: CallOpts) => Promise<T>): Promise<T> {
    try {
      return await callWithRetry((signal) => fn({ timeoutMs, signal }), {
        ...opts.retry,
        timeoutMs,
      });
    } catch (err) {
      if (err instanceof GmailError) throw err;
      if (err instanceof TimeoutError) {
        throw new GmailError("upstream", `Gmail ${what} timed out after ${timeoutMs} ms`, {
          cause: err,
        });
      }
      if (isAuthFailure(err)) {
        throw new GmailError("auth", `Gmail token expired or revoked; ${REAUTH}`, { cause: err });
      }
      const status = httpStatusOf(err);
      throw new GmailError(
        "upstream",
        `Gmail ${what} failed${status === undefined ? "" : ` (HTTP ${status})`}`,
        { cause: err },
      );
    }
  }

  return {
    async fetchSince(cursor, knownIds, fetchOpts = {}) {
      const { signal } = fetchOpts;
      const q = gmailQuery(cursor);
      const api = await resolveApi();
      const ids: string[] = [];
      const seen = new Set<string>();
      let pageToken: string | undefined;
      do {
        if (signal?.aborted) throw cancelled();
        const params: ListParams = { userId: "me", q, labelIds: ["INBOX"], maxResults: pageSize };
        if (pageToken) params.pageToken = pageToken;
        const res = await call("messages.list", (o) => api.users.messages.list(params, o));
        for (const m of res.data.messages ?? []) {
          if (m.id && !seen.has(m.id)) {
            seen.add(m.id);
            ids.push(m.id);
          }
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
      const fresh = ids.filter((hex) => !knownIds.has(gmailId(hex)));
      const messages = await mapLimit(
        fresh,
        concurrency,
        async (hex) => {
          const res = await call("messages.get", (o) =>
            api.users.messages.get({ userId: "me", id: hex, format: "full" }, o),
          );
          return normalizeGmailMessage({ ...res.data, id: res.data.id ?? hex });
        },
        signal,
      );
      return { messages, listed: ids.length, skippedCached: ids.length - fresh.length };
    },

    async probe() {
      const api = await resolveApi();
      const params: ListParams = { userId: "me", q: "", labelIds: ["INBOX"], maxResults: 1 };
      await call("messages.list", (o) => api.users.messages.list(params, o));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Real client: OAuth2 (client from google-oauth-client.json, token from gmail-token.json, both
// re-loaded and re-checked per fetch). googleapis is imported lazily so fake mode never loads it.

export async function createGoogleGmailApi(
  client: OAuthClientConfig,
  token: GmailToken,
): Promise<GmailApi> {
  const { google } = await import("googleapis");
  const auth = new google.auth.OAuth2({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
  });
  auth.setCredentials({ ...token, scope: GMAIL_READONLY_SCOPE });
  const gmail = google.gmail({ version: "v1", auth });
  // retry:false: util/retry.ts owns retries (no double backoff); timeout + signal per call.
  const o = (opts: CallOpts) => ({ timeout: opts.timeoutMs, signal: opts.signal, retry: false });
  return {
    users: {
      messages: {
        list: async (p, opts) => {
          const r = await gmail.users.messages.list(
            { ...p, fields: "messages/id,nextPageToken" },
            o(opts),
          );
          return { data: r.data };
        },
        get: async (p, opts) => {
          const r = await gmail.users.messages.get(p, o(opts));
          return { data: r.data };
        },
      },
    },
  };
}

/**
 * Resolves the real API once per fetch: requires google-oauth-client.json and gmail-token.json,
 * and re-runs the recorded-scope check (loadCredentials) every time.
 */
export function googleGmailApi(
  paths: Pick<Paths, "oauthClientFile" | "gmailTokenFile">,
  makeApi: (
    client: OAuthClientConfig,
    token: GmailToken,
  ) => Promise<GmailApi> = createGoogleGmailApi,
): () => Promise<GmailApi> {
  return async () => {
    if (!existsSync(paths.gmailTokenFile)) {
      throw new GmailError(
        "not_configured",
        `Gmail not connected (${path.basename(paths.gmailTokenFile)} is missing); ${REAUTH}`,
      );
    }
    const token = await loadCredentials(paths);
    const client = await loadOAuthClient(paths);
    return makeApi(client, token);
  };
}
