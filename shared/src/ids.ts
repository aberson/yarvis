// Identity formats (plan §3.1, §5): builders and parsers for message, todo and quarantine ids.
// Parse rules: a todo id splits on its LAST `#` (n a positive integer); a message id is `gmail:` +
// hex, or `wa:` + remainder split on its LAST `:` into jid and key.id (both non-empty; jid must
// contain `@`; any JID domain parses). Anything else is a bad id (parsers return null).

export type ParsedMessageId =
  | { source: "gmail"; id: string; gmailId: string }
  | { source: "whatsapp"; id: string; remoteJid: string; keyId: string };

export interface ParsedTodoId {
  id: string;
  messageId: string;
  n: number;
  message: ParsedMessageId;
}

const HEX = /^[0-9a-f]+$/i;
const POSITIVE_INT = /^[1-9][0-9]*$/;

export function gmailId(messageId: string): string {
  const id = `gmail:${messageId}`;
  if (!parseMessageId(id)) throw new Error("gmailId: Gmail message id must be non-empty hex");
  return id;
}

export function waId(remoteJid: string, keyId: string): string {
  const id = `wa:${remoteJid}:${keyId}`;
  if (keyId.includes(":") || !parseMessageId(id)) {
    throw new Error("waId: remoteJid must contain @ and key.id must be non-empty without :");
  }
  return id;
}

export function todoId(messageId: string, n: number): string {
  if (!parseMessageId(messageId)) throw new Error("todoId: not a message id");
  if (!Number.isInteger(n) || n < 1) throw new Error("todoId: n must be a positive integer");
  return `${messageId}#${n}`;
}

export function parseMessageId(id: string): ParsedMessageId | null {
  if (id.startsWith("gmail:")) {
    const gmail = id.slice("gmail:".length);
    return HEX.test(gmail) ? { source: "gmail", id, gmailId: gmail } : null;
  }
  if (id.startsWith("wa:")) {
    const rest = id.slice("wa:".length);
    const cut = rest.lastIndexOf(":");
    if (cut < 0) return null;
    const remoteJid = rest.slice(0, cut);
    const keyId = rest.slice(cut + 1);
    if (!remoteJid || !keyId || !remoteJid.includes("@")) return null;
    return { source: "whatsapp", id, remoteJid, keyId };
  }
  return null;
}

export function parseTodoId(id: string): ParsedTodoId | null {
  const cut = id.lastIndexOf("#");
  if (cut < 0) return null;
  const messageId = id.slice(0, cut);
  const nText = id.slice(cut + 1);
  if (!POSITIVE_INT.test(nText)) return null;
  const n = Number(nText);
  if (!Number.isSafeInteger(n)) return null;
  const message = parseMessageId(messageId);
  return message ? { id, messageId, n, message } : null;
}

/** A quarantine item id is a message id (one row per message, §3.1). */
export const parseQuarantineId = parseMessageId;
