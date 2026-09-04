/**
 * The state every tab shares.
 *
 * Kept in its own module so the tabs can type against it without importing
 * index.tsx, which imports them.
 */
import { Script } from "scripting"

import {
  Account,
  CharacterPrompt,
  GenerateParams,
  GeneratedImage,
  Quote,
} from "./nai"
import { Chunk } from "./chunks"

/** Shown in the title bar so an over-the-air update is visible at a glance. */
export const VERSION = (() => {
  try {
    return Script.metadata?.version ?? "?"
  } catch {
    return "?"
  }
})()

/** Minimization is unavailable in some contexts; probe once, not per render. */
export const CAN_MINIMIZE = (() => {
  try {
    return Script.supportsMinimization()
  } catch {
    return false
  }
})()

/**
 * Which text the full-screen editor is pointed at.
 *
 * The editor lives above the tabs so any tab can open it; this is how they say
 * what to edit. Each target also picks the storage scope for the chunk
 * picker's collapsed categories — the art-style picker and the character
 * picker keep their own shape.
 */
export type EditTarget =
  | { kind: "style" }
  | { kind: "character" }
  | { kind: "specific" }
  | { kind: "negative" }
  | { kind: "char"; index: number; field: "prompt" | "negative" }

export type Workbench = {
  params: GenerateParams
  patch: (next: Partial<GenerateParams>) => void

  token: string
  account: Account | null
  /** Name of the active account slot, shown in the toolbar. */
  accountLabel: string
  /** Opus allowance remaining, 0-100, or null when there is none. */
  opusPercent: number | null
  quote: Quote

  history: GeneratedImage[]
  current: GeneratedImage | null
  showImage: (image: GeneratedImage) => void
  removeImage: (path: string) => void
  clearImages: () => void

  chunks: Chunk[]

  busy: boolean
  progress: { done: number; total: number }
  status: string
  generate: () => void

  editPrompt: (target: EditTarget) => void
  addCharacter: () => void
  removeCharacter: (index: number) => void
  patchCharacter: (index: number, next: Partial<CharacterPrompt>) => void
  moveCharacter: (index: number, delta: number) => void
  openViewer: () => void
  openCharacters: () => void
  openAccount: () => void
  reuse: (image: GeneratedImage) => void
  saveImage: (image: GeneratedImage) => void
  shareImage: (image: GeneratedImage) => void
  toast: (message: string) => void
}
