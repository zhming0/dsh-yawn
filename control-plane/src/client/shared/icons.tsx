/** Shared 16px outline glyphs for the bundle's chips and settings pages. */

interface OutlineIconProps {
  size?: number;
}

/** A box glyph; the primitives package ships nothing that reads as a sandbox. */
export function SandboxIcon({ size = 16 }: OutlineIconProps) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinejoin="round"
      style={{ flex: "none" }}
    >
      <path d="M8 1.75 14 4.75v6.5L8 14.25 2 11.25v-6.5L8 1.75Z" />
      <path d="M2 4.75 8 7.75l6-3M8 7.75v6.5" />
    </svg>
  );
}

/** A plug glyph for MCP servers. */
export function PlugIcon({ size = 16 }: OutlineIconProps) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none" }}
    >
      <path d="M5.75 1.75v3M10.25 1.75v3" />
      <path d="M3.75 4.75h8.5v2.5a4.25 4.25 0 0 1-8.5 0v-2.5Z" />
      <path d="M8 11.5v2.75" />
    </svg>
  );
}

/** A key glyph for stored secrets. */
export function KeyIcon({ size = 16 }: OutlineIconProps) {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none" }}
    >
      <circle cx="4.75" cy="8" r="2.5" />
      <path d="M7.25 8H14M11.25 8v2.25M13.25 8v1.5" />
    </svg>
  );
}
