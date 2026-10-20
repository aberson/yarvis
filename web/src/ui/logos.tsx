// Header logos (plan §5, D39): one SVG per LOGO_IDS entry, each a holographic HUD ring around a
// pirate mark. Colours come from CSS classes in styles.css (`.logo .h` holo stroke, `.hf` holo fill,
// `.t` thin holo, `.r` red stroke, `.rf` red fill, `.k` dark fill, `.w` bright fill), so the logos
// follow the theme tokens; scripts/make-icon.tsx reuses them for the desktop icon.
import type { ReactElement } from "react";
import { DEFAULT_LOGO, LOGO_IDS, type LogoId } from "@yarvis/shared";
import type { StringKey } from "../i18n/strings.js";

/** Each logo's display name in the string tables (pirate mode renames them too). */
export const LOGO_NAME: Readonly<Record<LogoId, StringKey>> = {
  "reactor-skull": "logoReactorSkull",
  "helm-wheel": "logoHelmWheel",
  "compass-hud": "logoCompassHud",
  "anchor-core": "logoAnchorCore",
  "crossed-cutlasses": "logoCrossedCutlasses",
  "jolly-roger": "logoJollyRoger",
  "eyepatch-iris": "logoEyepatchIris",
  "kraken-ring": "logoKrakenRing",
  "treasure-reticle": "logoTreasureReticle",
  "tricorn-visor": "logoTricornVisor",
};

/** Outer HUD ring: tick ring, solid ring and a red arc, shared by most marks. */
function Hud({ arc = "M10 20 A26 26 0 0 1 22 8" }: { arc?: string }) {
  return (
    <>
      <circle className="t" cx="32" cy="32" r="30" strokeDasharray="1.5 3" />
      <circle className="h" cx="32" cy="32" r="26.5" strokeDasharray="34 4 10 4" />
      <path className="r" d={arc} strokeWidth="3" />
    </>
  );
}

function Skull({ x = 32, y = 28, s = 1 }: { x?: number; y?: number; s?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <path
        className="w"
        d="M-9 -1 A9 9 0 1 1 9 -1 C9 3 7 5 6 6 L6 10 L-6 10 L-6 6 C-7 5 -9 3 -9 -1 Z"
      />
      <circle className="k" cx="-3.6" cy="0" r="2.6" />
      <circle className="k" cx="3.6" cy="0" r="2.6" />
      <path className="kf" d="M0 3 L-1.4 5.6 L1.4 5.6 Z" />
      <path className="kl" d="M-3 10 V7.5 M0 10 V7.5 M3 10 V7.5" />
    </g>
  );
}

function Bone({ d }: { d: string }) {
  return <path className="bone" d={d} />;
}

const DRAW: Readonly<Record<LogoId, () => ReactElement>> = {
  "reactor-skull": () => (
    <>
      <Hud />
      <circle className="t" cx="32" cy="32" r="20" />
      <Bone d="M18 40 L46 52 M46 40 L18 52" />
      <Skull y={27} />
    </>
  ),
  "helm-wheel": () => (
    <>
      <Hud arc="M54 44 A26 26 0 0 1 44 54" />
      <circle className="h" cx="32" cy="32" r="14" />
      <circle className="t" cx="32" cy="32" r="10" />
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        const [c, s] = [Math.cos(a), Math.sin(a)];
        return (
          <g key={i}>
            <line className="h" x1={32 + 4 * c} y1={32 + 4 * s} x2={32 + 19 * c} y2={32 + 19 * s} />
            <circle className="hf" cx={32 + 20.5 * c} cy={32 + 20.5 * s} r="2" />
          </g>
        );
      })}
      <circle className="rf" cx="32" cy="32" r="4" />
    </>
  ),
  "compass-hud": () => (
    <>
      <circle className="h" cx="32" cy="32" r="27" />
      {Array.from({ length: 24 }, (_, i) => {
        const a = (i * Math.PI) / 12;
        const r0 = i % 6 === 0 ? 21 : 24;
        return (
          <line
            key={i}
            className="t"
            x1={32 + r0 * Math.cos(a)}
            y1={32 + r0 * Math.sin(a)}
            x2={32 + 27 * Math.cos(a)}
            y2={32 + 27 * Math.sin(a)}
          />
        );
      })}
      <path
        className="h"
        d="M32 32 L38 38 L32 54 L26 38 Z M32 32 L26 26 L10 32 L26 38 Z M32 32 L38 26 L54 32 L38 38 Z"
      />
      <path className="rf" d="M32 8 L38 26 L32 32 L26 26 Z" />
      <circle className="k" cx="32" cy="32" r="3" />
    </>
  ),
  "anchor-core": () => (
    <>
      <Hud arc="M42 7.5 A26 26 0 0 1 56 22" />
      <circle className="h" cx="32" cy="15" r="3.5" />
      <line className="h" x1="32" y1="18.5" x2="32" y2="48" />
      <line className="h" x1="24" y1="23" x2="40" y2="23" />
      <path className="h" d="M18 36 Q20 50 32 49 Q44 50 46 36" />
      <path className="rf" d="M15 39 L18 33 L21 39 Z M43 39 L46 33 L49 39 Z" />
      <circle className="rf" cx="32" cy="34" r="3" />
    </>
  ),
  "crossed-cutlasses": () => (
    <>
      <Hud />
      <path className="blade" d="M19 47 Q26 26 47 13" />
      <path className="blade" d="M45 47 Q38 26 17 13" />
      <path className="r" d="M14 42 L24 50 M50 42 L40 50" />
      <circle className="rf" cx="16" cy="51" r="2.5" />
      <circle className="rf" cx="48" cy="51" r="2.5" />
      <circle className="hf" cx="32" cy="31.5" r="2" />
    </>
  ),
  "jolly-roger": () => (
    <>
      <path className="h" d="M32 3 L57 17.5 V46.5 L32 61 L7 46.5 V17.5 Z" />
      <path className="t" d="M32 8 L52.5 20 V44 L32 56 L11.5 44 V20 Z" />
      <line className="h" x1="16" y1="14" x2="16" y2="52" />
      <path className="k" d="M16 16 Q30 11 48 17 L48 40 Q32 35 16 40 Z" />
      <Skull x={32} y={25} s={0.72} />
      <Bone d="M24 31 L40 37 M40 31 L24 37" />
      <path className="r" d="M7 46.5 L32 61 L57 46.5" strokeWidth="2.5" />
    </>
  ),
  "eyepatch-iris": () => (
    <>
      <Hud arc="M8 42 A26 26 0 0 0 20 55" />
      <circle className="h" cx="32" cy="32" r="16" />
      <circle className="t" cx="32" cy="32" r="12" strokeDasharray="3 2" />
      <circle className="hf" cx="32" cy="32" r="6" />
      <circle className="k" cx="32" cy="32" r="2.5" />
      <path className="r" d="M6 18 L58 46" strokeWidth="2.5" />
      <path className="pat" d="M17 22 Q31 15 37 27 Q35 41 21 41 Q12 34 17 22 Z" />
    </>
  ),
  "kraken-ring": () => (
    <>
      <circle className="t" cx="32" cy="32" r="30" strokeDasharray="1.5 3" />
      {Array.from({ length: 6 }, (_, i) => (
        <path
          key={i}
          className={i % 2 === 0 ? "h" : "r"}
          transform={`rotate(${i * 60} 32 32)`}
          d="M32 22 C33 14 40 10 44 14 C47 17 44 21 41 19"
        />
      ))}
      <circle className="h" cx="32" cy="32" r="10" />
      <circle className="hf" cx="32" cy="32" r="5" />
      <circle className="rf" cx="32" cy="32" r="2" />
    </>
  ),
  "treasure-reticle": () => (
    <>
      <circle className="h" cx="32" cy="32" r="24" strokeDasharray="30 7.7" />
      <circle className="t" cx="32" cy="32" r="16" />
      <path className="h" d="M32 2 V14 M32 50 V62 M2 32 H14 M50 32 H62" />
      <path className="t" d="M14 50 C20 44 16 38 22 36" strokeDasharray="2 2" />
      <path className="xmark" d="M25 25 L39 39 M39 25 L25 39" />
    </>
  ),
  "tricorn-visor": () => (
    <>
      <Hud arc="M56 22 A26 26 0 0 1 58 32" />
      <path className="k" d="M10 27 Q20 12 32 18 Q44 12 54 27 Q43 23 32 26 Q21 23 10 27 Z" />
      <path className="r" d="M16 24 Q32 19 48 24" />
      <rect className="h" x="19" y="30" width="26" height="18" rx="6" />
      <rect className="hf" x="23" y="36" width="18" height="4" rx="2" />
      <circle className="rf" cx="36" cy="38" r="1.6" />
      <path className="t" d="M26 44 H38" />
    </>
  ),
};

export function isLogoId(v: unknown): v is LogoId {
  return typeof v === "string" && (LOGO_IDS as readonly string[]).includes(v);
}

/** One logo as an inline SVG; an unknown id falls back to DEFAULT_LOGO. */
export function Logo({
  id,
  size = 40,
  title,
}: {
  id: LogoId | undefined;
  size?: number;
  title?: string;
}) {
  const logo = isLogoId(id) ? id : DEFAULT_LOGO;
  return (
    <svg
      className="logo"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-logo={logo}
    >
      {DRAW[logo]()}
    </svg>
  );
}
