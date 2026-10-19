// Identity formats (plan §3.1, §5): builders and LAST-separator parse rules.
import { describe, expect, it } from "vitest";
import { gmailId, parseMessageId, parseTodoId, todoId, waId } from "../src/ids.js";

describe("id builders", () => {
  it("build the §3.1 examples", () => {
    expect(gmailId("18f3c2a9b1e4d7f0")).toBe("gmail:18f3c2a9b1e4d7f0");
    expect(waId("1234567890@s.whatsapp.net", "3EB0A1C2D3E4F5")).toBe(
      "wa:1234567890@s.whatsapp.net:3EB0A1C2D3E4F5",
    );
    expect(todoId("gmail:18f3c2a9b1e4d7f0", 1)).toBe("gmail:18f3c2a9b1e4d7f0#1");
  });

  it("refuse inputs that would not parse back", () => {
    expect(() => gmailId("not-hex")).toThrow();
    expect(() => waId("no-at-sign", "K")).toThrow();
    expect(() => waId("1555@s.whatsapp.net", "a:b")).toThrow();
    expect(() => todoId("gmail:abc", 0)).toThrow();
    expect(() => todoId("bogus", 1)).toThrow();
  });
});

describe("parseTodoId", () => {
  it("round-trips a WhatsApp todo id containing @, : and # (last # and last : win)", () => {
    const id = todoId(waId("15555550123:7@s.whatsapp.net", "3EB0#A1"), 2);
    expect(id).toBe("wa:15555550123:7@s.whatsapp.net:3EB0#A1#2");
    expect(parseTodoId(id)).toEqual({
      id,
      messageId: "wa:15555550123:7@s.whatsapp.net:3EB0#A1",
      n: 2,
      message: {
        source: "whatsapp",
        id: "wa:15555550123:7@s.whatsapp.net:3EB0#A1",
        remoteJid: "15555550123:7@s.whatsapp.net",
        keyId: "3EB0#A1",
      },
    });
  });

  it("accepts any JID domain (groups too)", () => {
    expect(parseTodoId("wa:120363000000000001@g.us:ABC#1")?.message).toMatchObject({
      remoteJid: "120363000000000001@g.us",
    });
  });

  it.each([
    "gmail:18f3c2a9b1e4d7f0", // no #n
    "gmail:18f3c2a9b1e4d7f0#0",
    "gmail:18f3c2a9b1e4d7f0#01",
    "gmail:18f3c2a9b1e4d7f0#-1",
    "gmail:18f3c2a9b1e4d7f0#1.5",
    "gmail:xyz#1",
    "gmail:#1",
    "wa:15555550123@s.whatsapp.net#1", // no key.id
    "wa:15555550123@s.whatsapp.net:#1", // empty key.id
    "wa::KEY#1", // empty jid
    "wa:15555550123:KEY#1", // jid without @
    "slack:abc#1",
    "",
  ])("rejects %j", (id) => {
    expect(parseTodoId(id)).toBeNull();
  });
});

describe("parseMessageId", () => {
  it("parses gmail and wa ids and rejects todo-shaped gmail ids", () => {
    expect(parseMessageId("gmail:18F3c2")).toEqual({
      source: "gmail",
      id: "gmail:18F3c2",
      gmailId: "18F3c2",
    });
    expect(parseMessageId("gmail:18f3#1")).toBeNull();
    expect(parseMessageId("wa:1555@s.whatsapp.net:K")).toMatchObject({ source: "whatsapp" });
  });
});
