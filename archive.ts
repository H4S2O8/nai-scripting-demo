/**
 * Archiving generated images to iCloud Drive.
 *
 * The script's own Documents folder is local to the device: reinstall the
 * script, or lose the phone, and the images go with it. Copying them into
 * iCloud Documents puts them in the Files app, syncs them to the user's other
 * devices, and costs no server, no credentials and no upload code.
 *
 * Copies rather than moves. The local file is what the gallery renders from
 * and what a not-yet-downloaded iCloud file cannot serve, so removing it is a
 * separate, explicit choice.
 */
import { GeneratedImage } from "./nai"

const FOLDER = "NAI-Studio"

export type ArchiveState = {
  available: boolean
  /** Absolute path of the archive folder, or "" when iCloud is unavailable. */
  dir: string
  reason: string
}

export function archiveState(): ArchiveState {
  try {
    if (!FileManager.isiCloudEnabled) {
      return {
        available: false,
        dir: "",
        reason: "iCloud 不可用：请在系统设置里登录 iCloud，并允许 Scripting 使用 iCloud 云盘。",
      }
    }
    const dir = FileManager.iCloudDocumentsDirectory.replace(/\/+$/, "") + "/" + FOLDER
    return { available: true, dir, reason: "" }
  } catch (error) {
    return {
      available: false,
      dir: "",
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

function baseName(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] || path
}

/** Whether this image already has a copy in the archive. */
export function isArchived(image: GeneratedImage, state: ArchiveState): boolean {
  if (!state.available) return false
  return FileManager.existsSync(state.dir + "/" + baseName(image.path))
}

export type ArchiveResult = {
  copied: number
  skipped: number
  failed: number
  lastError: string
}

/**
 * Copy images into the archive, skipping ones already there.
 *
 * One failure does not stop the rest: a single unreadable file should not
 * strand every image behind it.
 */
export async function archiveAll(
  images: GeneratedImage[],
  state: ArchiveState,
): Promise<ArchiveResult> {
  const result: ArchiveResult = { copied: 0, skipped: 0, failed: 0, lastError: "" }
  if (!state.available) {
    result.lastError = state.reason
    result.failed = images.length
    return result
  }

  try {
    if (!FileManager.existsSync(state.dir)) {
      FileManager.createDirectorySync(state.dir, true)
    }
  } catch (error) {
    result.failed = images.length
    result.lastError = error instanceof Error ? error.message : String(error)
    return result
  }

  for (const image of images) {
    const target = state.dir + "/" + baseName(image.path)
    try {
      if (FileManager.existsSync(target)) {
        result.skipped++
        continue
      }
      if (!FileManager.existsSync(image.path)) {
        result.failed++
        result.lastError = "本地文件不存在：" + baseName(image.path)
        continue
      }
      // Async: copying a few hundred files synchronously freezes the UI.
      await FileManager.copyFile(image.path, target)
      result.copied++
    } catch (error) {
      result.failed++
      result.lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return result
}

/**
 * Delete local copies of images that are already archived.
 *
 * Only ever removes a file after confirming the archived copy exists, so a
 * half-finished archive cannot take the originals with it.
 */
export function pruneArchived(
  images: GeneratedImage[],
  state: ArchiveState,
): { removed: number; kept: number } {
  let removed = 0
  let kept = 0
  for (const image of images) {
    if (state.available && isArchived(image, state) && FileManager.existsSync(image.path)) {
      try {
        FileManager.removeSync(image.path)
        removed++
        continue
      } catch {
        /* fall through to counting it as kept */
      }
    }
    kept++
  }
  return { removed, kept }
}
