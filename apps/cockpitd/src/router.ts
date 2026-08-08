import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Effect } from "effect"
import { fileURLToPath } from "node:url"
import * as NodePath from "node:path"
import { apiRoutes, isLoopbackUrl } from "./api.js"

const defaultUiDist = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "../../ui/dist")

const staticPath = (root: string, urlPath: string): string => {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    decoded = urlPath // malformed %-escape; containment check below still applies to the raw string
  }
  const joined = NodePath.join(root, decoded)
  // path.join(root, "/") keeps a trailing separator, which would dodge the "=== root" check below.
  const resolved = joined.endsWith(NodePath.sep) ? joined.slice(0, -1) : joined
  return resolved === root || resolved.startsWith(root + NodePath.sep) ? resolved : root
}

// A bare "//" makes `new URL(url, base)` throw (parsed as a protocol-relative authority), so read the path off the request line directly.
const requestPath = (url: string): string => url.split("?")[0] || "/"

const serveUi = (root: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const requested = staticPath(root, requestPath(request.url))
    // requested === root means "/" or a rejected traversal; HttpServerResponse.file hangs on a directory, so route straight to index.html.
    const target = requested === root ? NodePath.join(root, "index.html") : requested
    return yield* HttpServerResponse.file(target).pipe(
      Effect.catchAll(() => HttpServerResponse.file(NodePath.join(root, "index.html"))),
    )
  })

/**
 * The daemon binds 127.0.0.1, but any name that resolves there reaches it just as well (DNS
 * rebinding), and neither a websocket nor a `text/plain` form post is subject to CORS. The Host
 * header carries the name the client was told to use, which is the one thing that separates a
 * page the user opened here from a page that merely points here.
 */
export const localOnly = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    return isLoopbackUrl(`http://${request.headers.host ?? ""}`)
      ? yield* app
      : yield* HttpServerResponse.json(
          { error: "forbidden", detail: "cockpit serves loopback hosts only" },
          { status: 403 },
        ).pipe(Effect.orDie)
  }),
)

/** Every server — the daemon and the tests — goes through the same guard. */
export const serveRoutes = HttpRouter.Default.serve(localOnly)

export const makeRoutesLayer = (uiDist: string = defaultUiDist) =>
  HttpRouter.Default.use((router) =>
    Effect.gen(function* () {
      yield* router.get("/healthz", HttpServerResponse.json({ status: "ok" }))
      yield* apiRoutes(router)
      yield* router.all("/api/*", HttpServerResponse.json({ error: "not found" }, { status: 404 }))
      yield* router.get("*", serveUi(uiDist))
    }),
  )
