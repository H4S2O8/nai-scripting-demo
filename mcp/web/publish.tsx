/**
 * Publishing a project to E-Hentai: choose and order the images, fill in the
 * gallery details, set up the cover, prepare, then upload as a draft.
 *
 * The cover preview is drawn by the publisher service itself, from the same
 * spec it will render at prepare time, so what is shown here is what goes up.
 * Nothing on this page publishes: a draft is reviewed and published on the
 * site, and its public link brought back here for the required tags.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks"

import { Bar, call, href, showToast, thumb, useLoad } from "./common"

const LANGUAGES = ["No Text", "Chinese", "Japanese", "English", "Korean", "French", "German", "Italian", "Portuguese",
  "Russian", "Spanish", "Thai", "Vietnamese", "Indonesian", "Polish", "Ukrainian", "Dutch", "Turkish", "Arabic"]
const LANGUAGE_TYPES = ["Official / Textless", "Translated", "Rewrite"]
const POSITIONS: [string, string][] = [
  ["top-left", "左上"], ["top", "上中"], ["top-right", "右上"],
  ["left", "左中"], ["center", "正中"], ["right", "右中"],
  ["bottom-left", "左下"], ["bottom", "下中"], ["bottom-right", "右下"],
]
const RUNNING = new Set(["composing", "preparing", "queued", "downloading", "rendering_cover", "uploading", "publishing"])

type Spec = Record<string, Record<string, any>>
type Item = { imageId: number; pageId?: number; route?: string; label: string; selected: boolean; blocked?: string }

/** Set one field of the spec, or remove it (undefined), dropping empty sections. */
function withField(spec: Spec, section: string, key: string, value: any): Spec {
  const next: Spec = { ...spec, [section]: { ...(spec[section] ?? {}) } }
  if (value === undefined) delete next[section][key]
  else next[section][key] = value
  if (Object.keys(next[section]).length === 0) delete next[section]
  return next
}

function Field({ label, children, hint }: { label: string; children: any; hint?: string }) {
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      {children}
      {hint ? <span class="muted small">{hint}</span> : null}
    </label>
  )
}

function PositionSelect({ value, onChange, auto }: { value?: string; onChange: (v: string | undefined) => void; auto?: string }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange((e.target as HTMLSelectElement).value || undefined)}>
      <option value="">{auto ?? "默认"}</option>
      {POSITIONS.map(([key, name]) => <option value={key}>{name}</option>)}
    </select>
  )
}

/** A slider for an optional setting: unset, its handle sits where the template's own value is. */
function Slider({ value, min, max, step, onChange, fallback, template }: { value?: number; min: number; max: number; step: number; onChange: (v: number | undefined) => void; fallback: string; template: number }) {
  return (
    <div class="row">
      <input type="range" min={min} max={max} step={step} value={value ?? template}
        onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))} style={{ flex: 1 }} />
      <span class="small muted" style={{ minWidth: "56px", textAlign: "right" }}>{value === undefined ? fallback : value}</span>
      {value !== undefined ? <button class="small" onClick={() => onChange(undefined)}>默认</button> : null}
    </div>
  )
}

/* ------------------------------------------------------------- cover editor */

function CoverEditor({ spec, setSpec, guro, mascots, onMascotsChange }: {
  spec: Spec; setSpec: (s: Spec) => void; guro: boolean; mascots: any[]; onMascotsChange: () => void
}) {
  const set = (section: string, key: string, value: any) => setSpec(withField(spec, section, key, value))
  const panel = spec.panel ?? {}
  const mascot = spec.mascot ?? {}
  const badge = spec.badge ?? {}
  const fileRef = useRef<HTMLInputElement>(null)
  const [libraryId, setLibraryId] = useState("")

  const upload = (file: File) => {
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const added: any = await call("/api/mascots", { name: file.name.replace(/\.[^.]+$/, ""), dataUrl: reader.result })
        showToast("已加入吉祥物库")
        onMascotsChange()
        set("mascot", "url", added.url)
      } catch (e: any) {
        showToast(e.message, true)
      }
    }
    reader.readAsDataURL(file)
  }
  const fromLibrary = async () => {
    try {
      const added: any = await call("/api/mascots/from-image", { imageId: Number(libraryId), name: `图 #${libraryId}` })
      showToast("已加入吉祥物库")
      setLibraryId("")
      onMascotsChange()
      set("mascot", "url", added.url)
    } catch (e: any) {
      showToast(e.message, true)
    }
  }

  return (
    <div class="editor">
      <details open>
        <summary>背景</summary>
        <Field label="模糊" hint={guro ? "GURO 默认约 28.6" : "普通版默认不模糊"}>
          <Slider value={spec.background?.blur} min={0} max={100} step={1} fallback="默认" template={guro ? 28.6 : 0} onChange={(v) => set("background", "blur", v)} />
        </Field>
      </details>

      <details open>
        <summary>提示框</summary>
        <label class="check">
          <input type="checkbox" checked={panel.visible !== false} disabled={guro}
            onChange={(e) => set("panel", "visible", (e.target as HTMLInputElement).checked ? undefined : false)} />
          显示{guro ? "（GURO 版必须显示）" : ""}
        </label>
        {panel.visible !== false ? (
          <>
            <Field label="位置"><PositionSelect value={panel.position === "auto" ? undefined : panel.position} auto="自动" onChange={(v) => set("panel", "position", v)} /></Field>
            <Field label="宽度（占画面）"><Slider value={panel.width} min={0.15} max={1} step={0.01} fallback="自动" template={0.89} onChange={(v) => set("panel", "width", v)} /></Field>
            <Field label="高度（占画面）"><Slider value={panel.height} min={0.08} max={0.9} step={0.01} fallback="自动" template={0.32} onChange={(v) => set("panel", "height", v)} /></Field>
            {(["header", "main", "sub"] as const).map((key) => {
              const label = { header: "标题行", main: "主文字", sub: "小字" }[key]
              const fixed = guro && key === "sub"
              return (
                <Field label={label} hint={fixed ? "GURO 版的警告和观看提示是固定的" : "留空这一行就不显示；不填用模板文字"}>
                  <div class="row">
                    <input type="text" value={panel[key] ?? ""} disabled={fixed} maxLength={120} style={{ flex: 1 }}
                      placeholder={fixed ? "" : "模板文字"}
                      onInput={(e) => set("panel", key, (e.target as HTMLInputElement).value === "" && panel[key] === undefined ? undefined : (e.target as HTMLInputElement).value)} />
                    {!fixed ? (
                      <input type="color" value={panel[key + "_color"] ?? { header: "#72ddf6", main: "#f7faff", sub: "#c3d1e6" }[key]}
                        onInput={(e) => set("panel", key + "_color", (e.target as HTMLInputElement).value)} aria-label={label + "颜色"} />
                    ) : null}
                    {panel[key] !== undefined && !fixed ? <button class="small" onClick={() => set("panel", key, undefined)}>模板</button> : null}
                  </div>
                </Field>
              )
            })}
            <label class="check">
              <input type="checkbox" checked={panel.outline !== false}
                onChange={(e) => set("panel", "outline", (e.target as HTMLInputElement).checked ? undefined : false)} />
              边框
            </label>
          </>
        ) : null}
      </details>

      <details open>
        <summary>吉祥物</summary>
        <label class="check">
          <input type="checkbox" checked={mascot.visible !== false}
            onChange={(e) => set("mascot", "visible", (e.target as HTMLInputElement).checked ? undefined : false)} />
          显示
        </label>
        {mascot.visible !== false ? (
          <>
            <Field label="图片">
              <select value={mascot.url ?? ""} onChange={(e) => set("mascot", "url", (e.target as HTMLSelectElement).value || undefined)}>
                <option value="">DeepSeek 娘（默认）</option>
                {mascots.map((m) => <option value={m.url}>{m.name}（{m.width}×{m.height}）</option>)}
              </select>
            </Field>
            <div class="row" style={{ margin: "4px 0 10px" }}>
              <button onClick={() => fileRef.current?.click()}>上传新的…</button>
              <input ref={fileRef} type="file" accept="image/png,image/webp,image/jpeg" style={{ display: "none" }}
                onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) upload(f); (e.target as HTMLInputElement).value = "" }} />
              <input type="text" inputMode="numeric" placeholder="图库编号" value={libraryId} style={{ width: "96px" }}
                onInput={(e) => setLibraryId((e.target as HTMLInputElement).value.replace(/\D/g, ""))} aria-label="图库图片编号" />
              <button onClick={fromLibrary} disabled={!libraryId}>用图库里的这张</button>
            </div>
            <p class="muted small">透明底的 PNG 效果最好，比如用 NovelAI 画一张透明底立绘再在这里按编号取用。</p>
            <Field label="位置"><PositionSelect value={mascot.position} auto="右下（默认）" onChange={(v) => set("mascot", "position", v)} /></Field>
            <Field label="大小"><Slider value={mascot.scale} min={0.2} max={2.5} step={0.05} fallback="1" template={1} onChange={(v) => set("mascot", "scale", v)} /></Field>
            <div class="row">
              <label class="check"><input type="checkbox" checked={mascot.shadow !== false}
                onChange={(e) => set("mascot", "shadow", (e.target as HTMLInputElement).checked ? undefined : false)} />阴影</label>
              <label class="check"><input type="checkbox" checked={mascot.flip === true}
                onChange={(e) => set("mascot", "flip", (e.target as HTMLInputElement).checked ? true : undefined)} />水平翻转</label>
            </div>
          </>
        ) : null}
      </details>

      <details open>
        <summary>角标</summary>
        <Field label="显示" hint="自动：只在竖版封面显示">
          <select value={badge.visible === undefined ? "auto" : String(badge.visible)}
            onChange={(e) => { const v = (e.target as HTMLSelectElement).value; set("badge", "visible", v === "auto" ? undefined : v === "true") }}>
            <option value="auto">自动</option>
            <option value="true">显示</option>
            <option value="false">不显示</option>
          </select>
        </Field>
        {badge.visible !== false ? (
          <>
            <Field label="文字">
              <input type="text" value={badge.text ?? ""} placeholder="AI GENERATED" maxLength={40}
                onInput={(e) => set("badge", "text", (e.target as HTMLInputElement).value || undefined)} />
            </Field>
            <Field label="位置"><PositionSelect value={badge.position} auto="左下（默认）" onChange={(v) => set("badge", "position", v)} /></Field>
          </>
        ) : null}
      </details>
      <button onClick={() => setSpec({})}>恢复默认封面</button>
    </div>
  )
}

/** The cover as the publisher will draw it, re-rendered half a second after the last change. */
function CoverPreview({ project, backgroundImageId, coverStyle, spec }: { project: string; backgroundImageId: number | null; coverStyle: string; spec: Spec }) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const key = JSON.stringify([backgroundImageId, coverStyle, spec])
  useEffect(() => {
    if (!backgroundImageId) return
    let live = true
    const timer = setTimeout(async () => {
      setBusy(true)
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(project)}/publish/preview`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-nai-app": "1" },
          body: JSON.stringify({ backgroundImageId, coverStyle, coverSpec: Object.keys(spec).length ? spec : null, maxWidth: Math.min(1200, window.innerWidth * 2) }),
        })
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`)
        const url = URL.createObjectURL(await response.blob())
        if (live) {
          setSrc((old) => (old && URL.revokeObjectURL(old), url))
          setError(null)
        }
      } catch (e: any) {
        if (live) setError(e.message)
      } finally {
        if (live) setBusy(false)
      }
    }, 500)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key])
  if (!backgroundImageId) return <div class="preview"><div class="empty">先在上面选至少一张图</div></div>
  return (
    <div class="preview cover-preview">
      {src ? <img src={src} alt="封面预览" style={{ opacity: busy ? 0.6 : 1 }} /> : <div class="empty">{busy ? "生成预览…" : ""}</div>}
      {error ? <p class="err-text">{error}</p> : null}
    </div>
  )
}

/* ----------------------------------------------------------- publications */

function links(job: any): [string, string][] {
  const out: [string, string][] = []
  const walk = (value: any, key: string) => {
    if (typeof value === "string" && /^https:\/\/(upld\.)?(e-hentai|exhentai)\.org\//.test(value)) out.push([key, value])
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k)
  }
  walk(job, "")
  return out
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`

function duration(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`
  return `${(seconds / 3600).toFixed(1)} 小时`
}

/**
 * The steps of a running publication and a bar for the current one. Speed and
 * time left come from successive polls, smoothed so one slow poll does not
 * swing the estimate.
 */
function JobProgress({ bar }: { bar: any }) {
  const last = useRef<{ done: number; at: number; unit: string; rate: number } | null>(null)
  const measured = bar.total !== undefined
  let rate = 0
  if (measured) {
    const now = Date.now()
    const prev = last.current
    if (prev && prev.unit === bar.unit && bar.done > prev.done && now > prev.at) {
      const sample = ((bar.done - prev.done) * 1000) / (now - prev.at)
      rate = prev.rate ? prev.rate * 0.6 + sample * 0.4 : sample
    } else if (prev && prev.unit === bar.unit) {
      rate = prev.rate
    }
    if (!prev || prev.done !== bar.done || prev.unit !== bar.unit) last.current = { done: bar.done, at: now, unit: bar.unit, rate }
  } else {
    last.current = null
  }
  const percent = measured ? Math.min(100, (bar.done / bar.total) * 100) : 0
  const amount = !measured ? "" : bar.unit === "byte" ? `${mb(bar.done)} / ${mb(bar.total)}` : `${bar.done} / ${bar.total}`
  const speed = !rate ? "" : bar.unit === "byte" ? `${mb(rate)}/s` : `${rate.toFixed(1)} ${bar.unit === "page" ? "页" : "张"}/s`
  const left = rate ? `还要约 ${duration((bar.total - bar.done) / rate)}` : ""
  return (
    <div class="job-progress">
      <ol class="steps">
        {bar.steps.map((step: string, i: number) => (
          <li class={i < bar.step ? "done" : i === bar.step ? "now" : ""}>{step}</li>
        ))}
      </ol>
      <div class="track" role="progressbar" aria-label={bar.label}
        aria-valuemin={0} aria-valuemax={measured ? bar.total : undefined} aria-valuenow={measured ? bar.done : undefined}>
        <div class={measured ? "fill" : "fill busy"} style={measured ? { width: `${percent}%` } : undefined} />
      </div>
      <p class="small">
        <span>{bar.label}</span>
        {measured ? <span class="muted"> · {amount} · {Math.floor(percent)}%</span> : null}
        {speed ? <span class="muted"> · {speed} · {left}</span> : null}
      </p>
    </div>
  )
}

function Publication({ id, onChange }: { id: number; onChange: () => void }) {
  const [data, error, reload] = useLoad<any>(`/api/publications/${id}`)
  const [busy, setBusy] = useState(false)
  const [gallery, setGallery] = useState("")
  const state = data?.job?.state ?? data?.state
  useEffect(() => {
    if (!data || !RUNNING.has(state)) return
    const timer = setTimeout(reload, 2000)
    return () => clearTimeout(timer)
  }, [data])
  const act = async (path: string, body: unknown, done: string) => {
    setBusy(true)
    try {
      await call(`/api/publications/${id}/${path}`, body)
      showToast(done)
      reload()
      onChange()
    } catch (e: any) {
      showToast(e.message, true)
    } finally {
      setBusy(false)
    }
  }
  if (error) return <div class="note"><p class="err-text">{error}</p></div>
  if (!data) return <div class="note"><p class="muted small">读取中…</p></div>
  const job = data.job
  const draft = () => {
    const ask = data.settings.appendTo
      ? `在网站上给 ${data.settings.appendTo} 创建一个新版本草稿，把番外页接在最后（原来的页和封面保留，不会公开）。继续吗？`
      : `把这 ${data.items.length} 张图和封面上传到 E-Hentai，作为你账号下的草稿（不会公开）。继续吗？`
    if (!confirm(ask)) return
    act("draft", {}, "已开始上传草稿")
  }
  return (
    <div class="note">
      <div class="meta">
        <span>#{data.id}</span>
        <span>{new Date(data.createdAt).toLocaleString("zh-CN")}</span>
        <span class="chip">{state}</span>
        <span>{data.items.length} 张</span>
      </div>
      <div class="body">
        {data.settings.appendTo ? (
          <strong>补番外到 <a href={data.settings.appendTo} target="_blank" rel="noreferrer">{data.settings.appendTo}</a></strong>
        ) : (
          <strong>{data.settings.title}</strong>
        )}
        {data.bar ? <JobProgress bar={data.bar} /> : null}
        {data.error ? <p class="err-text">{data.error}</p> : null}
        {job?.error ? <p class="err-text">{job.error}</p> : null}
        {data.jobError ? <p class="err-text">E-Hentai 服务：{data.jobError}</p> : null}
        {job?.cover?.preview_url ? <img src={job.cover.preview_url} alt="准备好的封面" class="ready-cover" /> : null}
        {links(job).map(([key, url]) => <p class="small"><a href={url} target="_blank" rel="noreferrer">{key || "链接"}：{url}</a></p>)}
        <div class="row" style={{ marginTop: "8px" }}>
          {state === "prepared" ? <button class="primary" disabled={busy} onClick={draft}>上传为草稿</button> : null}
          {job && ["draft_ready", "published", "tags_pending", "publication_unverified"].includes(state) ? (
            <>
              <input type="text" placeholder="在网站发布后，贴公开画廊链接" value={gallery} style={{ flex: 1, minWidth: "200px" }}
                onInput={(e) => setGallery((e.target as HTMLInputElement).value)} />
              <button disabled={busy || !gallery} onClick={() => act("link", { galleryUrl: gallery }, "已关联，正在补标签")}>关联并补标签</button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- page */

export function Publish({ name }: { name: string }) {
  const [data, error, reload] = useLoad<any>(`/api/projects/${encodeURIComponent(name)}/publish`)
  const [project] = useLoad<any>(`/api/projects/${encodeURIComponent(name)}`)
  const [items, setItems] = useState<Item[]>([])
  const [settings, setSettings] = useState<any>(null)
  const [spec, setSpec] = useState<Spec>({})
  const [mascots, setMascots] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [appending, setAppending] = useState(false)

  useEffect(() => {
    if (!data) return
    setMascots(data.mascots)
    if (settings) return
    setItems(data.candidates)
    const saved = data.settings ?? {}
    setSettings({ title: name, coverStyle: "ai", acceptSiteTerms: false, ...saved, appendTo: null })
    setSpec(saved.coverSpec ?? {})
  }, [data])

  /**
   * Appending side stories to the published gallery: only side-story pages,
   * and by default the ones not uploaded before; the gallery's own title and
   * cover stay, so those sections give way to the gallery link.
   */
  const switchMode = (append: boolean) => {
    setAppending(append)
    if (!append) {
      setItems(data.candidates)
      setSettings({ ...settings, appendTo: null })
      return
    }
    const done = new Set<string>(data.appendDefaults.publishedRoutes)
    setItems(data.candidates.map((c: Item) => ({ ...c, selected: !c.blocked && !!c.route && !done.has(c.route) })))
    setSettings({
      ...settings,
      appendTo: settings.appendTo || data.appendDefaults.galleryUrl || "",
      containsGuro: settings.coverStyle === "ai_guro",
    })
  }

  const novel = project?.kind === "novel"
  const chosen = items.filter((i) => i.selected && !i.blocked)
  const routes = [...new Set(chosen.flatMap((i) => (i.route ? [i.route] : [])))]
  const backgroundImageId = settings?.backgroundImageId && chosen.some((i) => i.imageId === settings.backgroundImageId)
    ? settings.backgroundImageId
    : chosen[0]?.imageId ?? null
  const guro = settings?.coverStyle === "ai_guro"
  const reloadMascots = () => call<any[]>("/api/mascots").then(setMascots).catch((e) => showToast(e.message, true))
  const set = (key: string, value: any) => setSettings({ ...settings, [key]: value })
  const move = (index: number, delta: number) => {
    const next = items.slice()
    const [item] = next.splice(index, 1)
    next.splice(index + delta, 0, item)
    setItems(next)
  }
  const start = async () => {
    setBusy(true)
    try {
      await call(`/api/projects/${encodeURIComponent(name)}/publish/start`, {
        items: chosen.map(({ imageId, pageId }) => ({ imageId, pageId })),
        settings: { ...settings, backgroundImageId, coverSpec: Object.keys(spec).length ? spec : null },
      })
      showToast(appending ? "开始准备追加：合成番外页、核对原画廊（还没上传）" : "开始准备：下载图片、生成封面（还没上传）")
      reload()
    } catch (e: any) {
      showToast(e.message, true)
    } finally {
      setBusy(false)
    }
  }
  const languageDefault = useMemo(() => (novel ? "Chinese" : "No Text"), [novel])

  if (error) return <><Bar title="发布到 E-Hentai" back={href("p", name)} /><div class="wrap"><p class="err-text">{error}</p></div></>
  if (!data || !settings) return <Bar title="发布到 E-Hentai" back={href("p", name)} />
  return (
    <>
      <Bar title="发布到 E-Hentai" back={href("p", name)} />
      <div class="wrap publish">
        <h2>1. 选图和顺序（已选 {chosen.length}）</h2>
        <p class="muted small">{novel ? "小说按页序上传合成好的左图右文页面。" : "默认选中各镜头里选定的图；其他图片可以手动加上。"}</p>
        {routes.length ? (
          <p class="muted small">
            含番外 {routes.join("、")}：每条番外前面自动加一张只印番外标签的分隔页，番外页脚印「{routes[0]} · 页码」。
          </p>
        ) : null}
        <div class="pick-list">
          {items.map((item, index) => (
            <div class={"pick-row" + (item.blocked || (appending && !item.route) ? " blocked" : "")} key={`${item.pageId ?? 0}-${item.imageId}`}>
              <input type="checkbox" checked={item.selected && !item.blocked} disabled={!!item.blocked || (appending && !item.route)} aria-label={`选择 ${item.label}`}
                onChange={(e) => setItems(items.map((it, i) => (i === index ? { ...it, selected: (e.target as HTMLInputElement).checked } : it)))} />
              {item.imageId ? <img src={thumb(item.imageId)} alt="" loading="lazy" /> : <span class="no-image" />}
              <div class="pick-label">
                <span>{item.label}</span>
                {item.imageId ? <span class="muted small">#{item.imageId}</span> : null}
                {item.blocked ? <span class="err-text small">{item.blocked}</span> : null}
              </div>
              {!novel ? (
                <div class="row">
                  <button class="small" disabled={index === 0} onClick={() => move(index, -1)} aria-label="上移">↑</button>
                  <button class="small" disabled={index === items.length - 1} onClick={() => move(index, 1)} aria-label="下移">↓</button>
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {novel && data.candidates.some((c: Item) => c.route) ? (
          <div class="mode-switch" role="radiogroup" aria-label="发布方式">
            <button class={appending ? "" : "on"} role="radio" aria-checked={!appending} onClick={() => switchMode(false)}>新画廊</button>
            <button class={appending ? "on" : ""} role="radio" aria-checked={appending} onClick={() => switchMode(true)}>补番外到已发布的画廊</button>
          </div>
        ) : null}

        {appending ? (
          <>
            <h2>2. 追加到哪个画廊</h2>
            <p class="muted small">
              在网站上给这个画廊出一个新版本：原来的页和封面保留，番外页接在最后；标题、封面沿用画廊里的。
              上传后是一份更新草稿，你在网站上审完手动发布，新版本才替换旧版本。
            </p>
            <Field label="已发布画廊的链接" hint="旧版本的链接也行，会自动找到最新版本">
              <input type="text" value={settings.appendTo ?? ""} placeholder="https://e-hentai.org/g/1234567/abcdef1234/"
                onInput={(e) => set("appendTo", (e.target as HTMLInputElement).value)} />
            </Field>
            <label class="check">
              <input type="checkbox" checked={settings.toc !== false} onChange={(e) => set("toc", (e.target as HTMLInputElement).checked)} />
              在简介的目录里补上新番外从第几页开始
            </label>
            <label class="check">
              <input type="checkbox" checked={settings.containsGuro === true} onChange={(e) => set("containsGuro", (e.target as HTMLInputElement).checked)} />
              新页里有 GURO 内容（原画廊必须已经是 GURO 封面）
            </label>
            <label class="check">
              <input type="checkbox" checked={settings.acceptSiteTerms === true} onChange={(e) => set("acceptSiteTerms", (e.target as HTMLInputElement).checked)} />
              我同意 E-Hentai 的上传条款
            </label>
            <div class="actions">
              <span class="small muted">准备只在服务器上合成和下载，不会上传。</span>
              <span class="spacer" />
              <button class="primary" disabled={busy || chosen.length === 0 || !settings.appendTo?.trim() || settings.acceptSiteTerms !== true} onClick={start}>
                开始准备追加
              </button>
            </div>
          </>
        ) : null}

        <div hidden={appending}>
        <h2>2. 投稿信息</h2>
        <Field label="标题" hint="会自动加上 [AI Generated]；GURO 会自动加 [GURO] 前缀">
          <input type="text" value={settings.title} maxLength={450} onInput={(e) => set("title", (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="日文标题（可选）">
          <input type="text" value={settings.titleJpn ?? ""} maxLength={450} onInput={(e) => set("titleJpn", (e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="简介（可选）">
          <textarea value={settings.description ?? ""} onInput={(e) => set("description", (e.target as HTMLTextAreaElement).value)} />
        </Field>
        <div class="grid2">
          <Field label="语言">
            <select value={settings.language ?? languageDefault} onChange={(e) => set("language", (e.target as HTMLSelectElement).value)}>
              {LANGUAGES.map((l) => <option value={l}>{l}</option>)}
            </select>
          </Field>
          <Field label="语言类型">
            <select value={settings.languageType ?? LANGUAGE_TYPES[0]} onChange={(e) => set("languageType", (e.target as HTMLSelectElement).value)}>
              {LANGUAGE_TYPES.map((l) => <option value={l}>{l}</option>)}
            </select>
          </Field>
          <Field label="封面样式">
            <select value={settings.coverStyle} onChange={(e) => {
              const style = (e.target as HTMLSelectElement).value
              setSettings({ ...settings, coverStyle: style })
              if (style === "ai_guro" && spec.panel) {
                // The GURO warning cannot be hidden or reworded.
                const { visible: _v, sub: _s, sub_color: _c, ...rest } = spec.panel
                setSpec({ ...spec, panel: rest })
              }
            }}>
              <option value="ai">普通（AI 声明）</option>
              <option value="ai_guro">GURO（红色警告、模糊背景）</option>
            </select>
          </Field>
          {guro ? (
            <Field label="受伤者性别" hint="决定 female:guro / male:guro 标签">
              <select value={settings.guroGender ?? ""} onChange={(e) => set("guroGender", (e.target as HTMLSelectElement).value || null)}>
                <option value="">请选择</option>
                <option value="female">女性</option>
                <option value="male">男性</option>
                <option value="both">都有</option>
              </select>
            </Field>
          ) : null}
        </div>
        {routes.length ? (
          <label class="check">
            <input type="checkbox" checked={settings.toc !== false} onChange={(e) => set("toc", (e.target as HTMLInputElement).checked)} />
            简介末尾附目录（正文和各条番外从画廊第几页开始）
          </label>
        ) : null}
        <label class="check">
          <input type="checkbox" checked={settings.acceptSiteTerms === true} onChange={(e) => set("acceptSiteTerms", (e.target as HTMLInputElement).checked)} />
          我同意 E-Hentai 的上传条款
        </label>

        <h2>3. 封面</h2>
        <Field label="背景图">
          <select value={backgroundImageId ?? ""} onChange={(e) => set("backgroundImageId", Number((e.target as HTMLSelectElement).value) || null)}>
            {chosen.map((item) => <option value={item.imageId}>{item.label} · #{item.imageId}</option>)}
          </select>
        </Field>
        <div class="cover-layout">
          <CoverPreview project={name} backgroundImageId={backgroundImageId} coverStyle={settings.coverStyle} spec={spec} />
          <CoverEditor spec={spec} setSpec={setSpec} guro={guro} mascots={mascots} onMascotsChange={reloadMascots} />
        </div>

        <div class="actions">
          <span class="small muted">准备只在服务器上下载图片、生成封面，不会上传。</span>
          <span class="spacer" />
          <button class="primary" disabled={busy || chosen.length === 0 || !settings.title?.trim() || (guro && !settings.guroGender)} onClick={start}>
            开始准备
          </button>
        </div>
        </div>

        <h2>发布记录</h2>
        {data.publications.length === 0 ? <p class="muted small">还没有。</p> : null}
        <div class="notes">
          {data.publications.map((p: any) => <Publication id={p.id} key={p.id} onChange={reload} />)}
        </div>
      </div>
    </>
  )
}
