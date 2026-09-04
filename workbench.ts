/**
 * The state every tab shares.
 *
 * Kept in its own module so the tabs can type against it without importing
 * index.tsx, which imports them.
 */
import { Script } from "scripting"

import { Account, GenerateParams, GeneratedImage, Quote } from "./nai"
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

export type PromptField = "prompt" | "negative"

export type Workbench = {
  params: GenerateParams
  patch: (next: Partial<GenerateParams>) => void

  token: string
  account: Account | null
  quote: Quote

  history: GeneratedImage[]
  current: GeneratedImage | null
  showImage: (image: GeneratedImage) => void
  removeImage: (path: string) => void
  clearImages: () => void

  chunks: Chunk[]
  insertChunk: (chunk: Chunk, field: PromptField) => void

  busy: boolean
  progress: { done: number; total: number }
  status: string
  generate: () => void

  editPrompt: (field: PromptField) => void
  openViewer: () => void
  openAccount: () => void
  reuse: (image: GeneratedImage) => void
  toast: (message: string) => void
}
