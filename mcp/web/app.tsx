/**
 * Review page for the NovelAI studio.
 *
 * Reads and writes the same studio the MCP tools use: a pick made here is the
 * pick the agent sees on its next novelai_review, and a note left here shows
 * up in that review as feedback to act on. Hash routes, so the server only
 * ever serves one page:
 *
 *   #/                       projects
 *   #/p/<name>               a novel's pages, or a gallery's shots
 *   #/p/<name>/page/<id>     one page: its preview, candidates, notes
 *   #/p/<name>/shot/<id>     one gallery shot
 *   #/p/<name>/publish       publishing to E-Hentai (publish.tsx)
 */
import { render } from "preact"
import { useCallback, useEffect, useMemo, useState } from "preact/hooks"

import { APP_VERSION, ApiError, Bar, Toast, UpdateBanner, call, href, showToast, thumb, useLoad, useRoute } from "./common"
import { Publish } from "./publish"

const STATUS: Record<string, string> = { shot: "待写镜头", draw: "待抽卡", pick: "待选图", done: "已完成" }

function Progress({ p }: { p: any }) {
  const total = (p.shot ?? 0) + (p.draw ?? 0) + (p.pick ?? 0) + (p.done ?? 0)
  if (!total) return null
  const pct = (n: number) => `${(100 * n) / total}%`
  return (
    <div class="progress" aria-hidden="true">
      <span class="done" style={{ width: pct(p.done) }} />
      <span class="pick" style={{ width: pct(p.pick) }} />
      <span class="draw" style={{ width: pct(p.draw) }} />
    </div>
  )
}

/* -------------------------------------------------------------- projects */

function Projects() {
  const [projects, error] = useLoad<any[]>("/api/projects")
  return (
    <>
      <Bar title="NovelAI 工作室" right={<a href="/app/logout" class="small muted">退出</a>} />
      <div class="wrap">
        {error ? <p class="muted">{error}</p> : null}
        {projects && projects.length === 0 ? <p class="muted">还没有项目。让 agent 用 novelai_project 建一个。</p> : null}
        <div class="cards">
          {(projects ?? []).map((p) => (
            <a class="card" href={href("p", p.name)} key={p.name}>
              <div class="row">
                <span class="title">{p.name}</span>
                <span class="chip">{p.kind === "novel" ? "小说" : "图集"}</span>
              </div>
              {p.description ? <p>{p.description}</p> : null}
              <Progress p={p.progress} />
              <div class="row small muted">
                {p.kind === "novel" ? <span>{p.progress.pages} 页</span> : <span>{p.progress.shots} 个镜头</span>}
                <span>已完成 {p.progress.done}</span>
                {p.progress.pick ? <span class="chip pick">待选图 {p.progress.pick}</span> : null}
                {p.progress.openFeedback ? <span class="chip alert">意见 {p.progress.openFeedback}</span> : null}
              </div>
            </a>
          ))}
        </div>
        <p class="muted small version">版本 {APP_VERSION}</p>
      </div>
    </>
  )
}

/* --------------------------------------------------------------- project */

function Project({ name }: { name: string }) {
  const [project, error, reload] = useLoad<any>(`/api/projects/${encodeURIComponent(name)}`)
  const [filter, setFilter] = useState("all")
  const [zoom, setZoom] = useState<string | null>(null)
  if (error) return <><Bar title={name} back="#/" /><div class="wrap"><p class="muted">{error}</p></div></>
  if (!project) return <Bar title={name} back="#/" />
  const keep = (status: string) => filter === "all" || status === filter
  const tabs = [["all", "全部"], ["pick", "待选图"], ["draw", "待抽卡"], ["shot", "待写镜头"], ["done", "已完成"]]
  const editRoute = async (c: any) => {
    const route = prompt(
      `第 ${c.chapter} 章属于哪条番外？填标签，比如「IF 1」；留空表示正文。\n番外要排在全部正文之后，同一条番外的章节要连在一起；上传时每条番外前面会加一张只印这个标签的分隔页。`,
      c.route,
    )
    if (route === null || route.trim() === c.route) return
    try {
      await call(`/api/projects/${encodeURIComponent(name)}/chapters/${c.chapter}`, { route })
      showToast(route.trim() ? `第 ${c.chapter} 章设为番外「${route.trim()}」` : `第 ${c.chapter} 章改回正文`)
      reload()
    } catch (e: any) {
      showToast(e.message, true)
    }
  }
  return (
    <>
      <Bar title={project.name} back="#/" right={<a href={href("p", name, "publish")}><button>发布</button></a>} />
      <div class="wrap">
        {project.description ? <p class="muted">{project.description}</p> : null}
        <Progress p={project.progress} />
        <div class="tabs" role="tablist">
          {tabs.map(([key, label]) => (
            <button class={filter === key ? "on" : ""} onClick={() => setFilter(key)} role="tab" aria-selected={filter === key}>
              {label}
              {key !== "all" && project.progress[key] ? ` ${project.progress[key]}` : ""}
            </button>
          ))}
        </div>
        {project.kind === "novel"
          ? project.chapters.map((c: any, i: number) => {
              const pages = c.pages.filter((p: any) => keep(p.status))
              if (!pages.length) return null
              const opens = c.route && c.route !== project.chapters[i - 1]?.route
              return (
                <section key={c.chapter}>
                  {opens ? <div class="route-break">番外 · {c.route}</div> : null}
                  <div class="chapter-head">
                    <h2>
                      第 {c.chapter} 章{c.title ? ` · ${c.title}` : ""}
                      {c.route ? <span class="chip route">{c.route}</span> : null}
                    </h2>
                    <button class="small-button" onClick={() => editRoute(c)}>{c.route ? "改番外" : "设为番外"}</button>
                  </div>
                  <div class="tiles">
                    {pages.map((p: any) => (
                      <a class="tile" href={href("p", name, "page", p.id)} key={p.id}>
                        <div class="frame">
                          {p.picked || p.cover ? (
                            <img src={thumb(p.picked ?? p.cover)} alt="" loading="lazy" class={p.picked ? "" : "standin"} />
                          ) : (
                            <div class="excerpt">{p.text.slice(0, 60)}…</div>
                          )}
                        </div>
                        <div class="label">
                          <span>第 {p.page} 页</span>
                          <span class={"chip " + (p.status === "pick" ? "pick" : p.status === "done" ? "done" : "")}>
                            {STATUS[p.status]}
                            {p.status === "pick" && p.counts ? ` ${p.counts.candidate}` : ""}
                          </span>
                        </div>
                      </a>
                    ))}
                  </div>
                </section>
              )
            })
          : (
            <div class="tiles" style={{ marginTop: "12px" }}>
              {project.shots.filter((s: any) => keep(s.status)).map((s: any) => (
                <a class="tile" href={href("p", name, "shot", s.id)} key={s.id}>
                  <div class="frame">
                    {s.picked.length || s.cover ? (
                      <img src={thumb(s.picked[0] ?? s.cover)} alt="" loading="lazy" class={s.picked.length ? "" : "standin"} />
                    ) : (
                      <div class="excerpt">{s.title}</div>
                    )}
                  </div>
                  <div class="label">
                    <span>{s.title || `镜头 #${s.id}`}</span>
                    <span class={"chip " + (s.status === "pick" ? "pick" : s.status === "done" ? "done" : "")}>
                      {s.status === "done" ? `保留 ${s.picked.length}` : STATUS[s.status]}
                    </span>
                  </div>
                </a>
              ))}
            </div>
          )}
        {project.loose.total ? (
          <section>
            <h2>其他图片（{project.loose.total}）</h2>
            <p class="muted small">不属于任何镜头的图，比如定妆图、只带项目名生成的图。{project.loose.total > project.loose.images.length ? `只显示最新 ${project.loose.images.length} 张。` : ""}</p>
            <div class="candidates">
              {project.loose.images.map((img: any) => (
                <button class="cand" onClick={() => img.url && setZoom(img.url)} aria-label={`图 #${img.id}`} key={img.id} disabled={!img.url}>
                  {img.url ? <img src={thumb(img.id)} alt="" loading="lazy" /> : <span class="muted small">已归档</span>}
                  <span class="id">#{img.id}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        <h2>给 agent 的留言（整个项目）</h2>
        <Notes project={name} notes={project.feedback} targets={[{ target: "project", id: null, label: "整个项目" }]} onChange={reload} />
      </div>
      {zoom ? (
        <div class="lightbox" onClick={() => setZoom(null)} role="dialog" aria-label="原图">
          <img src={zoom} alt="原图" />
        </div>
      ) : null}
    </>
  )
}

/* ---------------------------------------------------------------- notes */

type Target = { target: string; id: number | null; label: string }

function Notes({ project, notes, targets, onChange }: { project: string; notes: any[]; targets: Target[]; onChange: () => void }) {
  const [body, setBody] = useState("")
  const [which, setWhich] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => setWhich((w) => Math.min(w, targets.length - 1)), [targets.length])
  const label = (n: any) =>
    n.target === "project" ? "项目" : n.target === "page" ? "这一页" : n.target === "shot" ? "镜头" : `图 #${n.targetId}`
  const submit = async () => {
    if (!body.trim()) return
    setBusy(true)
    try {
      const t = targets[which]
      await call("/api/feedback", { project, target: t.target, targetId: t.id, body })
      setBody("")
      showToast("已留言，agent 下次查看待办时会看到")
      onChange()
    } catch (e: any) {
      showToast(e.message, true)
    } finally {
      setBusy(false)
    }
  }
  const resolve = async (id: number) => {
    try {
      await call(`/api/feedback/${id}/resolve`, { project })
      onChange()
    } catch (e: any) {
      showToast(e.message, true)
    }
  }
  return (
    <>
      <div class="notes">
        {notes.length === 0 ? <p class="muted small">还没有留言。</p> : null}
        {notes.map((n) => (
          <div class={"note" + (n.resolvedAt ? " resolved" : "")} key={n.id}>
            <div class="meta">
              <span>{n.author === "human" ? "你" : "agent"}</span>
              <span>→ {label(n)}</span>
              <span>{new Date(n.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
              <span class="spacer" />
              {n.resolvedAt ? <span>已处理</span> : n.author === "human" ? (
                <button class="small" style={{ minHeight: "30px", padding: "2px 10px" }} onClick={() => resolve(n.id)}>标为已处理</button>
              ) : null}
            </div>
            <div class="body">{n.body}</div>
          </div>
        ))}
      </div>
      <textarea
        value={body}
        onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
        placeholder="写给 agent：比如「手画坏了，重抽」「她应该在笑」"
        aria-label="留言内容"
      />
      <div class="row" style={{ marginTop: "8px" }}>
        {targets.length > 1 ? (
          <select value={which} onChange={(e) => setWhich(Number((e.target as HTMLSelectElement).value))} style={{ width: "auto", flex: 1 }} aria-label="留言对象">
            {targets.map((t, i) => <option value={i}>{t.label}</option>)}
          </select>
        ) : null}
        <button class="primary" onClick={submit} disabled={busy || !body.trim()}>留言</button>
      </div>
    </>
  )
}

/* ------------------------------------------------------- candidate picker */

function useCandidateKeys(count: number, sel: number, setSel: (i: number) => void, act: (a: string) => void, page?: { prev: number | null; next: number | null; go: (id: number) => void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("textarea, input, select")) return
      if (e.key === "ArrowRight" && count) setSel((sel + 1) % count)
      else if (e.key === "ArrowLeft" && count) setSel((sel - 1 + count) % count)
      else if (e.key === "p" || e.key === "P") act("pick")
      else if (e.key === "x" || e.key === "X") act("reject")
      else if (e.key === "r" || e.key === "R") act("reset")
      else if (e.key === "]" && page?.next) page.go(page.next)
      else if (e.key === "[" && page?.prev) page.go(page.prev)
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [count, sel, act, page])
}

function Candidates({ list, sel, setSel }: { list: any[]; sel: number; setSel: (i: number) => void }) {
  if (!list.length) return <p class="muted">还没有抽过。让 agent 用 novelai_draw 抽几张。</p>
  return (
    <div class="candidates" role="listbox" aria-label="候选图">
      {list.map((c, i) => (
        <button
          class={"cand" + (i === sel ? " sel" : "") + (c.verdict === "rejected" ? " rejected" : "")}
          onClick={() => setSel(i)}
          role="option"
          aria-selected={i === sel}
          aria-label={`候选图 #${c.id}`}
          key={c.id}
        >
          <img src={thumb(c.id)} alt="" loading="lazy" />
          <span class="badges">
            {c.verdict === "picked" ? <span class="b-pick">✔ 选中</span> : null}
            {c.favorite ? <span class="b-fav">★</span> : null}
            {c.verdict === "rejected" ? <span class="b-rej">✘</span> : null}
          </span>
          <span class="id">#{c.id}</span>
        </button>
      ))}
    </div>
  )
}

function ActionBar({ current, onAct, extra }: { current: any; onAct: (a: string) => void; extra?: any }) {
  if (!current) return null
  return (
    <div class="actions">
      <span class="small muted">#{current.id}</span>
      <button class="pick" onClick={() => onAct("pick")} disabled={current.verdict === "picked"}>选中</button>
      <button class="reject" onClick={() => onAct("reject")} disabled={current.verdict === "rejected"}>淘汰</button>
      {current.verdict !== "candidate" ? <button onClick={() => onAct("reset")}>恢复候选</button> : null}
      <span class="spacer" />
      {extra}
      <span class="kbd">← → 切换 · P 选中 · X 淘汰</span>
    </div>
  )
}

function useVerdict(reload: () => void) {
  return useCallback(async (id: number | undefined, action: string) => {
    if (id == null) return
    try {
      await call("/api/verdict", { imageIds: [id], action })
      showToast(action === "pick" ? "已选中" : action === "reject" ? "已淘汰" : "已恢复为候选")
      reload()
    } catch (e: any) {
      showToast(e.message, true)
    }
  }, [reload])
}

/** Start on the picked image, else the agent's favourite, else the newest. */
function initialIndex(list: any[]): number {
  const picked = list.findIndex((c) => c.verdict === "picked")
  if (picked >= 0) return picked
  const fav = list.findIndex((c) => c.favorite && c.verdict !== "rejected")
  return fav >= 0 ? fav : 0
}

/* ----------------------------------------------------- adopt from library */

/**
 * The project's images that belong to no shot, to take into this one as
 * candidates — say, a picture drawn with novelai_generate_image before the
 * shot existed.
 */
function AdoptPicker({ project, shotId, onDone }: { project: string; shotId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [data] = useLoad<any>(open ? `/api/projects/${encodeURIComponent(project)}` : null, [open])
  const adopt = async (id: number) => {
    try {
      await call(`/api/shots/${shotId}/adopt`, { imageIds: [id] })
      showToast(`#${id} 已加入候选`)
      setOpen(false)
      onDone()
    } catch (e: any) {
      showToast(e.message, true)
    }
  }
  if (!open) return <button onClick={() => setOpen(true)} style={{ marginTop: "10px" }}>从项目图库添加…</button>
  const loose = (data?.loose.images ?? []).filter((img: any) => img.url)
  return (
    <details open>
      <summary onClick={(e) => { e.preventDefault(); setOpen(false) }}>从项目图库添加（点图加入候选，点这里收起）</summary>
      {!data ? <p class="muted small">加载中…</p> : null}
      {data && loose.length === 0 ? <p class="muted small">这个项目里没有不属于镜头的图。</p> : null}
      <div class="candidates" style={{ marginTop: "10px" }}>
        {loose.map((img: any) => (
          <button class="cand" onClick={() => adopt(img.id)} aria-label={`把 #${img.id} 加入候选`} key={img.id}>
            <img src={thumb(img.id)} alt="" loading="lazy" />
            <span class="id">#{img.id}</span>
          </button>
        ))}
      </div>
    </details>
  )
}

/* ------------------------------------------------------------------ page */

function Page({ name, id }: { name: string; id: number }) {
  const [detail, error, reload] = useLoad<any>(`/api/pages/${id}`)
  const [sel, setSel] = useState(0)
  const [zoom, setZoom] = useState<string | null>(null)
  const list = detail?.candidates ?? []
  useEffect(() => setSel(initialIndex(list)), [detail?.page.id, list.length])
  const current = list[sel]
  const verdict = useVerdict(reload)
  const act = useCallback((a: string) => verdict(current?.id, a), [verdict, current?.id])
  const go = useCallback((pid: number) => (location.hash = href("p", name, "page", pid)), [name])
  useCandidateKeys(list.length, sel, setSel, act, detail ? { prev: detail.prev, next: detail.next, go } : undefined)
  const width = useMemo(() => Math.min(1100, window.innerWidth) * Math.min(2, window.devicePixelRatio || 1), [])

  if (error) return <><Bar title="页" back={href("p", name)} /><div class="wrap"><p class="muted">{error}</p></div></>
  if (!detail) return <Bar title="页" back={href("p", name)} />
  const p = detail.page
  const targets: Target[] = [
    { target: "page", id: p.id, label: "这一页" },
    ...(detail.shot ? [{ target: "shot", id: detail.shot.id, label: "这页的镜头（提示词）" }] : []),
    ...(current ? [{ target: "image", id: current.id, label: `当前这张图 #${current.id}` }] : []),
  ]
  return (
    <>
      <Bar
        title={`第 ${p.number} / ${p.total} 页`}
        back={href("p", name)}
        right={
          <div class="row">
            <button onClick={() => detail.prev && go(detail.prev)} disabled={!detail.prev} aria-label="上一页">‹ 上页</button>
            <button onClick={() => detail.next && go(detail.next)} disabled={!detail.next} aria-label="下一页">下页 ›</button>
          </div>
        }
      />
      <div class="wrap">
        <div class="row small muted" style={{ marginTop: "10px" }}>
          <span>{p.route ? `番外 ${p.route} · ` : ""}第 {p.chapter} 章{p.chapterTitle ? ` · ${p.chapterTitle}` : ""} · 第 {p.page} 页 · {p.chars} 字</span>
          <span class={"chip " + (p.status === "pick" ? "pick" : p.status === "done" ? "done" : "")}>{STATUS[p.status]}</span>
        </div>
        <div class="preview">
          {current ? (
            <img
              src={`/api/render/page/${p.id}?image=${current.id}&w=${Math.round(width)}`}
              alt={`第 ${p.number} 页用 #${current.id} 的排版预览`}
              onClick={() => setZoom(current.url)}
            />
          ) : (
            <div class="empty">{detail.shot ? "还没有候选图" : "这一页还没有镜头"}</div>
          )}
        </div>
        <h2>候选 {list.length ? `（${list.length}）` : ""}</h2>
        <Candidates list={list} sel={sel} setSel={setSel} />
        {detail.shot ? <AdoptPicker project={name} shotId={detail.shot.id} onDone={reload} /> : null}
        <details>
          <summary>这页原文</summary>
          <p class="prose">{p.text}</p>
        </details>
        {detail.shot ? (
          <details>
            <summary>镜头提示词 #{detail.shot.id}</summary>
            <p class="mono">{detail.shot.prompt || "（未写）"}</p>
            {detail.shot.negative ? <p class="mono muted">负面：{detail.shot.negative}</p> : null}
            {detail.shot.characters.map((c: any, i: number) => (
              <p class="mono muted" key={i}>角色 {i + 1}{c.x != null ? `（${c.x}, ${c.y}）` : ""}：{c.prompt}</p>
            ))}
          </details>
        ) : null}
        <h2>留言</h2>
        <Notes project={name} notes={detail.feedback} targets={targets} onChange={reload} />
        <ActionBar
          current={current}
          onAct={act}
          extra={current?.url ? <button onClick={() => setZoom(current.url)}>原图</button> : null}
        />
      </div>
      {zoom ? (
        <div class="lightbox" onClick={() => setZoom(null)} role="dialog" aria-label="原图">
          <img src={zoom} alt="原图" />
        </div>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ shot */

function Shot({ name, id }: { name: string; id: number }) {
  const [detail, error, reload] = useLoad<any>(`/api/shots/${id}`)
  const [sel, setSel] = useState(0)
  const [zoom, setZoom] = useState<string | null>(null)
  const list = detail?.candidates ?? []
  useEffect(() => setSel(initialIndex(list)), [detail?.shot.id, list.length])
  const current = list[sel]
  const verdict = useVerdict(reload)
  const act = useCallback((a: string) => verdict(current?.id, a), [verdict, current?.id])
  useCandidateKeys(list.length, sel, setSel, act)

  if (error) return <><Bar title="镜头" back={href("p", name)} /><div class="wrap"><p class="muted">{error}</p></div></>
  if (!detail) return <Bar title="镜头" back={href("p", name)} />
  const s = detail.shot
  return (
    <>
      <Bar title={s.title || `镜头 #${s.id}`} back={href("p", name)} />
      <div class="wrap">
        <div class="preview">
          {current ? (
            <img src={thumb(current.id)} alt={`#${current.id}`} onClick={() => setZoom(current.url)} />
          ) : (
            <div class="empty">还没有候选图</div>
          )}
        </div>
        <h2>候选 {list.length ? `（${list.length}）` : ""}</h2>
        <Candidates list={list} sel={sel} setSel={setSel} />
        <AdoptPicker project={name} shotId={s.id} onDone={reload} />
        <details>
          <summary>提示词</summary>
          <p class="mono">{s.prompt || "（未写）"}</p>
          {s.negative ? <p class="mono muted">负面：{s.negative}</p> : null}
        </details>
        <h2>留言</h2>
        <Notes
          project={name}
          notes={detail.feedback}
          targets={[
            { target: "shot", id: s.id, label: "这个镜头" },
            ...(current ? [{ target: "image", id: current.id, label: `当前这张图 #${current.id}` }] : []),
          ]}
          onChange={reload}
        />
        <ActionBar current={current} onAct={act} extra={current?.url ? <button onClick={() => setZoom(current.url)}>原图</button> : null} />
      </div>
      {zoom ? (
        <div class="lightbox" onClick={() => setZoom(null)} role="dialog" aria-label="原图">
          <img src={zoom} alt="原图" />
        </div>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------- app */

function App() {
  const route = useRoute()
  let view
  if (route[0] === "p" && route[1] && route[2] === "publish") view = <Publish name={route[1]} key={"publish-" + route[1]} />
  else if (route[0] === "p" && route[1] && route[2] === "page" && route[3]) view = <Page name={route[1]} id={Number(route[3])} key={route[3]} />
  else if (route[0] === "p" && route[1] && route[2] === "shot" && route[3]) view = <Shot name={route[1]} id={Number(route[3])} key={route[3]} />
  else if (route[0] === "p" && route[1]) view = <Project name={route[1]} key={route[1]} />
  else view = <Projects />
  return (
    <>
      {view}
      <Toast />
      <UpdateBanner />
    </>
  )
}

render(<App />, document.getElementById("app")!)
