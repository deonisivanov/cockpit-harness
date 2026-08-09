import { memo, useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createOnigurumaEngine } from "shiki/engine/oniguruma"
import { parseDiff, type DiffLine, type ProsePara } from "./presentation.js"

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

  const box = "rounded-md border border-white/9 bg-code px-3 py-2.5 overflow-x-auto font-mono text-[11.5px] leading-[1.75]"
  if (html) return <div className={box} dangerouslySetInnerHTML={{ __html: html }} />
  return (
    <pre className={`${box} text-ink-2 whitespace-pre`}>
      <code>{text}</code>
    </pre>
  )
})

const TERM_THEME = {
  background: "#0f0f16",
  foreground: "#8f8f9c",
  cursor: "#0f0f16",
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
      className="rounded-md border border-white/9 bg-term px-3 py-2.5"
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
      className="rounded-md border border-white/9 bg-code py-2.5 overflow-x-auto font-mono text-[11.5px] leading-[1.75]"
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

const PARA_STYLE: Record<ProsePara["kind"], string> = {
  p: "font-sans text-[13.5px] leading-[1.72] text-[#c9c9d6] [text-wrap:pretty]",
  b: "font-sans text-[12.5px] leading-[1.65] text-[#a8a8b6]",
  k: "font-mono text-[11.5px] leading-[1.6] text-[#8f8f9c]",
}

const PROSE_TEXT = "font-sans text-[13.5px] leading-[1.72] text-[#c9c9d6] [text-wrap:pretty]"

/** Agent prose arrives as markdown; these keep the reference typography instead of mono. */
const PROSE_MD_COMPONENTS = {
  p: (p: { children?: React.ReactNode }) => <p className={`${PROSE_TEXT} py-0.5`}>{p.children}</p>,
  strong: (p: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-[#e4e4ec]">{p.children}</strong>
  ),
  h1: (p: { children?: React.ReactNode }) => (
    <div className="pb-0.5 font-sans text-[14px] font-semibold text-[#e4e4ec]">{p.children}</div>
  ),
  h2: (p: { children?: React.ReactNode }) => (
    <div className="pb-0.5 font-sans text-[13.5px] font-semibold text-[#e4e4ec]">{p.children}</div>
  ),
  h3: (p: { children?: React.ReactNode }) => (
    <div className="pb-0.5 font-sans text-[13.5px] font-semibold text-[#e4e4ec]">{p.children}</div>
  ),
  ul: (p: { children?: React.ReactNode }) => (
    <ul className="list-disc space-y-1 py-0.5 pl-5 marker:text-ink-4">{p.children}</ul>
  ),
  ol: (p: { children?: React.ReactNode }) => (
    <ol className="list-decimal space-y-1 py-0.5 pl-5 marker:text-ink-4">{p.children}</ol>
  ),
  li: (p: { children?: React.ReactNode }) => <li className={PROSE_TEXT}>{p.children}</li>,
  code: (p: { children?: React.ReactNode }) => (
    <code className="font-mono text-[12px] text-amber">{p.children}</code>
  ),
  pre: (p: { children?: React.ReactNode }) => (
    <pre className="overflow-x-auto rounded-md border border-white/9 bg-code px-3 py-2.5 font-mono text-[11.5px] leading-[1.75] whitespace-pre-wrap text-ink-2">
      {p.children}
    </pre>
  ),
  a: (p: { children?: React.ReactNode; href?: string }) => (
    <a href={p.href} className="text-vio-hi">
      {p.children}
    </a>
  ),
}

export function ProseParas({ paras }: { paras: readonly ProsePara[] }) {
  return (
    <>
      {paras.map((para, i) =>
        para.kind === "p" ? (
          <div key={i} className="[text-wrap:pretty]">
            <ReactMarkdown components={PROSE_MD_COMPONENTS}>{para.text}</ReactMarkdown>
          </div>
        ) : (
          <div key={i} className={PARA_STYLE[para.kind]}>
            {para.kind === "b" ? `—  ${para.text}` : para.text}
          </div>
        ),
      )}
    </>
  )
}

/** The green-tinted result box the reference uses inside expanded events. */
export function ProseBox({ paras }: { paras: readonly ProsePara[] }) {
  return (
    <div
      data-testid="prose-result"
      className="flex flex-col gap-2 rounded-lg border border-white/10 border-l-2 border-l-green/45 bg-green/3 px-[15px] py-3"
    >
      <ProseParas
        paras={paras.length > 0 ? paras : [{ kind: "p", text: "No textual result was reported." }]}
      />
    </div>
  )
}

/** Raw payload JSON lives here and nowhere else — closed until someone asks for it. */
export function RawSection({ value }: { value: unknown }) {
  return (
    <details data-testid="raw-section">
      <summary className="cursor-pointer font-mono text-[9.5px] font-medium tracking-[0.13em] text-[#7e7e8a] select-none">
        RAW
      </summary>
      <div className="mt-1.5">
        <Code text={JSON.stringify(value, null, 2) ?? "null"} lang="json" />
      </div>
    </details>
  )
}

/** One artifact body, rendered by the kind the daemon recorded for it. */
export function ArtifactBodyView({ kind, path, text }: { kind: string; path: string; text: string }) {
  if (kind === "diff" || path.endsWith(".patch")) return <Diff text={text} />
  if (kind === "terminal") return <Ansi text={text} />
  if (kind === "markdown") return <Markdown text={text} />
  if (kind === "json") return <Code text={text} lang="json" />
  return <Code text={text} lang={langOf(path)} />
}
