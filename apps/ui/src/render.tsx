import { memo, useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createOnigurumaEngine } from "shiki/engine/oniguruma"
import { parseDiff, type DiffLine } from "./presentation.js"

type Lang = "typescript" | "javascript" | "json" | "bash" | "ruby" | "python"

const EXT_LANG: Record<string, Lang> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  sh: "bash",
  bash: "bash",
  rb: "ruby",
  py: "python",
}

export const langOf = (path: string): Lang | null => {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return EXT_LANG[ext] ?? null
}

let pending: Promise<HighlighterCore> | null = null
const highlighter = (): Promise<HighlighterCore> =>
  (pending ??= createHighlighterCore({
    themes: [import("shiki/themes/vitesse-dark.mjs")],
    langs: [
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/javascript.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/bash.mjs"),
      import("shiki/langs/ruby.mjs"),
      import("shiki/langs/python.mjs"),
    ],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  }))

export const Code = memo(function Code({ text, lang }: { text: string; lang: Lang | null }) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    if (!lang) return
    let live = true
    void highlighter()
      .then((h) => h.codeToHtml(text, { lang, theme: "vitesse-dark" }))
      .then((out) => {
        if (live) setHtml(out)
      })
      .catch(() => {
        if (live) setHtml(null)
      })
    return () => {
      live = false
    }
  }, [text, lang])

  const box = "rounded-md border border-white/6 bg-code px-3 py-2.5 overflow-x-auto font-mono text-[11.5px] leading-[1.75]"
  if (html) return <div className={box} dangerouslySetInnerHTML={{ __html: html }} />
  return (
    <pre className={`${box} text-ink-2 whitespace-pre`}>
      <code>{text}</code>
    </pre>
  )
})

const TERM_THEME = {
  background: "#040406",
  foreground: "#8f8f9c",
  cursor: "#040406",
  black: "#2a2a32",
  red: "#cf6060",
  green: "#58a87c",
  yellow: "#c99a4a",
  blue: "#79a0d8",
  magenta: "#a78bf5",
  cyan: "#6d8ef0",
  white: "#d6d6de",
  brightBlack: "#4a4a54",
  brightRed: "#d08585",
  brightGreen: "#7cc79c",
  brightYellow: "#d8b878",
  brightBlue: "#9fb2f5",
  brightMagenta: "#c3c3ff",
  brightCyan: "#9fb2f5",
  brightWhite: "#e4e4ec",
}

const MAX_TERM_ROWS = 22

/** Raw stdout/stderr keeps its ANSI: xterm renders it exactly as the terminal would. */
export const Ansi = memo(function Ansi({ text }: { text: string }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 11,
      lineHeight: 1.45,
      scrollback: 2000,
      theme: TERM_THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try {
      fit.fit()
    } catch {
      // A zero-width host (collapsed row) simply keeps xterm's default geometry.
    }
    term.write(text)

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* same as above */
      }
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      term.dispose()
    }
  }, [text])

  const rows = Math.min(text.split("\n").length + 1, MAX_TERM_ROWS)
  return (
    <div
      ref={host}
      data-testid="ansi-terminal"
      className="rounded-md border border-white/6 bg-term px-3 py-2.5"
      style={{ height: rows * 17 + 20 }}
    />
  )
})

const DIFF_STYLE: Record<DiffLine["kind"], string> = {
  add: "text-green-hi bg-green/8",
  del: "text-red-hi bg-red/8",
  hunk: "text-vio bg-vio/5",
  file: "text-ink-3",
  ctx: "text-ink-2",
}

export const Diff = memo(function Diff({ text }: { text: string }) {
  const lines = useMemo(() => parseDiff(text), [text])
  return (
    <div
      data-testid="diff-view"
      className="rounded-md border border-white/6 bg-code py-2.5 overflow-x-auto font-mono text-[11.5px] leading-[1.75]"
    >
      {lines.map((l, i) => (
        <div key={i} className={`px-3 whitespace-pre ${DIFF_STYLE[l.kind]}`}>
          {l.emphasis ? (
            <>
              {l.text.slice(0, l.emphasis[0])}
              <span className={l.kind === "add" ? "rounded-xs bg-green/25" : "rounded-xs bg-red/25"}>
                {l.text.slice(l.emphasis[0], l.emphasis[1])}
              </span>
              {l.text.slice(l.emphasis[1])}
            </>
          ) : (
            l.text
          )}
        </div>
      ))}
    </div>
  )
})

const MD_COMPONENTS = {
  h1: (p: { children?: React.ReactNode }) => <div className="font-semibold text-vio-hi text-[12.5px] pb-1">{p.children}</div>,
  h2: (p: { children?: React.ReactNode }) => <div className="font-semibold text-vio-hi text-[12px] pb-1">{p.children}</div>,
  h3: (p: { children?: React.ReactNode }) => <div className="font-semibold text-vio-hi text-[11.5px] pb-1">{p.children}</div>,
  p: (p: { children?: React.ReactNode }) => <p className="text-ink py-0.5">{p.children}</p>,
  ul: (p: { children?: React.ReactNode }) => <ul className="py-0.5">{p.children}</ul>,
  ol: (p: { children?: React.ReactNode }) => <ol className="py-0.5">{p.children}</ol>,
  li: (p: { children?: React.ReactNode }) => (
    <li className="text-ink flex gap-2">
      <span className="text-ink-4">•</span>
      <span className="min-w-0">{p.children}</span>
    </li>
  ),
  code: (p: { children?: React.ReactNode }) => <code className="text-amber">{p.children}</code>,
  pre: (p: { children?: React.ReactNode }) => (
    <pre className="text-amber whitespace-pre-wrap py-1">{p.children}</pre>
  ),
  a: (p: { children?: React.ReactNode; href?: string }) => (
    <a href={p.href} className="text-vio-hi">
      {p.children}
    </a>
  ),
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="border-l-2 border-vio/30 pl-3.5 font-mono text-[11.5px] leading-[1.75]">
      <ReactMarkdown components={MD_COMPONENTS}>{text}</ReactMarkdown>
    </div>
  )
})

/** One artifact body, rendered by the kind the daemon recorded for it. */
export function ArtifactBodyView({ kind, path, text }: { kind: string; path: string; text: string }) {
  if (kind === "diff" || path.endsWith(".patch")) return <Diff text={text} />
  if (kind === "terminal") return <Ansi text={text} />
  if (kind === "markdown") return <Markdown text={text} />
  if (kind === "json") return <Code text={text} lang="json" />
  return <Code text={text} lang={langOf(path)} />
}
