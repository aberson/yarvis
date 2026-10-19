// UI string tables (plan §5, P7): pirate mode swaps this table and nothing else; data is never altered.
import { createContext, useContext } from "react";

export const en = {
  appName: "Yarvis",
  navTodos: "Todos",
  navQuarantine: "Quarantine",
  navApps: "Connected apps",
  navSettings: "Settings",
  loading: "Loading…",
  loadError: "Could not load settings",
  notBuiltYet: "This page arrives in a later build step.",
  settingsTitle: "Settings",
  pirateLabel: "Pirate mode",
  pirateOn: "On",
  pirateOff: "Off",
  pirateHint: "Swaps the interface strings only.",
  saving: "Saving…",
  saveError: "Could not save",
  thresholdsTitle: "Jev thresholds (read-only)",
  thresholdQuarantine: "Quarantine at",
  thresholdAction: "Action item at",
  privateDirLabel: "Private folder",
  fakeModeBadge: "fake mode",
  sourceGmail: "Gmail",
  sourceWhatsapp: "WhatsApp",
  hideDone: "Hide done",
  showDone: "Show done",
  openSheet: "Open sheet",
  sheetNotConfigured: "No Google Sheet configured",
  todosLoadError: "Could not load to-dos",
  todosEmpty: "Nothing to do.",
  todoSaveError: "Could not update the to-do",
  markDone: "Done",
  extractionPending: "extraction pending",
  openOriginal: "Open original",
  quarantineIntro: "Messages Jev flagged. They never reach to-do extraction.",
  quarantineLoadError: "Could not load quarantine",
  quarantineEmpty: "Nothing in quarantine.",
  colSource: "Source",
  colSender: "From",
  colContext: "Subject / chat",
  colDate: "Received",
  colReason: "Reason",
  colPhishing: "Phishing",
  colMalicious: "Malicious",
  colSpam: "Spam",
  colLink: "Link",
  released: "released",
  noScore: "n/a",
} as const;

export type StringKey = keyof typeof en;
export type Strings = Readonly<Record<StringKey, string>>;

export const pirate: Strings = {
  appName: "Yarvis",
  navTodos: "Chores fer the Crew",
  navQuarantine: "The Brig",
  navApps: "Spyglasses",
  navSettings: "Ship's Riggin'",
  loading: "Hoistin' the sails…",
  loadError: "Blimey, the riggin' be tangled",
  notBuiltYet: "This deck be built on a later voyage.",
  settingsTitle: "Ship's Riggin'",
  pirateLabel: "Pirate tongue",
  pirateOn: "Aye",
  pirateOff: "Nay",
  pirateHint: "Swaps the words only, matey.",
  saving: "Stowin'…",
  saveError: "Couldn't stow it",
  thresholdsTitle: "Jev's lookout marks (fer readin' only)",
  thresholdQuarantine: "Throw in the brig at",
  thresholdAction: "Put the crew to work at",
  privateDirLabel: "Treasure chest",
  fakeModeBadge: "make-believe",
  sourceGmail: "Gmail bottle",
  sourceWhatsapp: "WhatsApp parrot",
  hideDone: "Hide finished chores",
  showDone: "Show finished chores",
  openSheet: "Open the ship's log",
  sheetNotConfigured: "No ship's log charted",
  todosLoadError: "The chores be lost at sea",
  todosEmpty: "No chores, ye lucky dog.",
  todoSaveError: "Couldn't mark that chore",
  markDone: "Done an' dusted",
  extractionPending: "still decipherin'",
  openOriginal: "See the original scroll",
  quarantineIntro: "Scurvy messages Jev clapped in irons. They never reach the chore list.",
  quarantineLoadError: "Couldn't open the brig",
  quarantineEmpty: "The brig be empty.",
  colSource: "Port o' call",
  colSender: "Sent by",
  colContext: "Concernin'",
  colDate: "Washed ashore",
  colReason: "Crime",
  colPhishing: "Phishin'",
  colMalicious: "Black-hearted",
  colSpam: "Bilge",
  colLink: "Spyglass",
  released: "set free",
  noScore: "none",
};

export const tables: Readonly<Record<"en" | "pirate", Strings>> = { en, pirate };

export function stringsFor(isPirate: boolean): Strings {
  return isPirate ? pirate : en;
}

/** Whether pirate mode is on (provided by App from settings.pirate). */
export const PirateContext = createContext<boolean>(false);

/** Picks the string table by settings.pirate. */
export function usePirate(): Strings {
  return stringsFor(useContext(PirateContext));
}
