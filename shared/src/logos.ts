// Header logo choices (plan §5, D39): THE one list of logo ids. The server validates
// `settings.logo` / `PATCH {logo}` against it and the web app draws one SVG per id.

export const LOGO_IDS = [
  "reactor-skull",
  "helm-wheel",
  "compass-hud",
  "anchor-core",
  "crossed-cutlasses",
  "jolly-roger",
  "eyepatch-iris",
  "kraken-ring",
  "treasure-reticle",
  "tricorn-visor",
] as const;

export type LogoId = (typeof LOGO_IDS)[number];

/** Used when settings.json predates the logo setting. */
export const DEFAULT_LOGO: LogoId = "reactor-skull";
