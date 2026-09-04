/**
 * Design tokens for the NovelAI workbench.
 *
 * Neutrals come from the iOS semantic palette so light/dark mode is handled by
 * the system; only the brand accent is hard-coded. Anything that needs an
 * explicit pair is written as `{ light, dark }` (DynamicShapeStyle).
 */
import { Color } from "scripting"

export type Dynamic = { light: Color; dark: Color }
export type Gradient = {
  gradient: { color: Color; location: number }[]
  startPoint: { x: number; y: number }
  endPoint: { x: number; y: number }
}

export const ACCENT = "#7C5CFA" as Color
export const ACCENT_DEEP = "#5B3FD9" as Color
export const ACCENT_SOFT = "#A78BFA" as Color

/** Page canvas. Slightly cooler than systemGroupedBackground to read as a studio. */
export const PAGE_BG: Dynamic = { light: "#F3F3F9", dark: "#0B0B11" }
/** Raised card surface. */
export const CARD_BG: Dynamic = { light: "#FFFFFF", dark: "#17171F" }
/** Inset well inside a card (text areas, image frame). */
export const WELL_BG: Dynamic = { light: "#F5F5FA", dark: "#101017" }
/** Hairline card border — carries the card edge where shadows are unavailable. */
export const CARD_STROKE: Dynamic = {
  light: "rgba(17, 17, 34, 0.07)",
  dark: "rgba(255, 255, 255, 0.09)",
}
/** Unselected chip. */
export const CHIP_BG: Dynamic = { light: "#EFEFF6", dark: "#1F1F2A" }
/** Selected chip / accent wash. */
export const CHIP_ON_BG: Dynamic = {
  light: "rgba(124, 92, 250, 0.14)",
  dark: "rgba(124, 92, 250, 0.26)",
}
export const CHIP_ON_FG: Dynamic = { light: ACCENT_DEEP, dark: ACCENT_SOFT }

/** Primary action fill. */
export const ACCENT_GRADIENT: Gradient = {
  gradient: [
    { color: "#8B6BFF" as Color, location: 0 },
    { color: "#5B3FD9" as Color, location: 1 },
  ],
  startPoint: { x: 0, y: 0 },
  endPoint: { x: 1, y: 1 },
}

/** Empty-canvas placeholder fill. */
export const CANVAS_GRADIENT: Gradient = {
  gradient: [
    { color: "rgba(124, 92, 250, 0.16)" as Color, location: 0 },
    { color: "rgba(32, 183, 216, 0.14)" as Color, location: 1 },
  ],
  startPoint: { x: 0, y: 0 },
  endPoint: { x: 1, y: 1 },
}

export const RADIUS_CARD = 20
export const RADIUS_WELL = 14
export const RADIUS_CHIP = 10
