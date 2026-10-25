/**
 * What every view of the review page shares: the API call, routing helpers,
 * data loading, the top bar and the toast.
 */
import { useEffect, useState } from "preact/hooks"

/* ------------------------------------------------------------------ api */

export class ApiError extends Error {}

export async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json", "x-nai-app": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  })
  if (response.status === 401) {
    location.href = "/app/login"
    throw new ApiError("未登录")
  }
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
  if (!response.ok) throw new ApiError(data.error ?? `HTTP ${response.status}`)
  return data as T
}

/** Every thumbnail is one 512 px JPEG on R2; the API redirects to it. */
export const thumb = (id: number) => `/api/thumb/${id}`

/* --------------------------------------------------------------- shared */


let setToastState: (text: string, error?: boolean) => void = () => {}

/** Show a short message at the bottom of the screen; errors stay longer. */
export function showToast(text: string, error = false) {
  setToastState(text, error)
}

export function Toast() {
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null)
  useEffect(() => {
    setToastState = (text, error = false) => {
      setToast({ text, error })
      setTimeout(() => setToast(null), error ? 4000 : 1800)
    }
  }, [])
  return toast ? <div class={"toast" + (toast.error ? " err" : "")} role="status">{toast.text}</div> : null
}

export function useRoute(): string[] {
  const read = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent)
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => {
      setRoute(read())
      window.scrollTo(0, 0)
    }
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])
  return route
}

export const href = (...parts: (string | number)[]) => "#/" + parts.map((p) => encodeURIComponent(String(p))).join("/")

export function useLoad<T>(path: string | null, deps: unknown[] = []): [T | null, string | null, () => void] {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!path) return
    let live = true
    call<T>(path)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [path, tick, ...deps])
  return [data, error, () => setTick((t) => t + 1)]
}

export function Bar({ title, back, right }: { title: string; back?: string; right?: any }) {
  return (
    <header class="bar">
      {back ? (
        <a href={back}>
          <button class="back" aria-label="返回">‹</button>
        </a>
      ) : null}
      <h1>{title}</h1>
      {right}
    </header>
  )
}

