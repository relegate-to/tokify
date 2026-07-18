# AGENTS.md

Orientation file for future Codex sessions in this repo. Read this first.

## What this project is

Tokify is a macOS menu-bar time tracker. It is a **respectful fork** of
[tock](https://github.com/kriuchkov/tock) by Vladimir Kriuchkov: the original
`tock` CLI is preserved and kept in sync with upstream, and a new
`cmd/tock-desktop/` Wails app reuses tock's domain services so the CLI and GUI
stay behaviorally identical.

Activities are stored as a plain-text log (`~/.tock.txt`) shared with the
upstream CLI. See [`TOKIFY.md`](TOKIFY.md) for the fork's relationship to upstream
and [`docs/tock.md`](docs/tock.md) for the upstream README preserved verbatim.

License: **GPL-3.0-or-later**, inherited from tock.

## Important fork constraints

- The Go module path is **`github.com/kriuchkov/tock`** — do not rename it.
  It's kept that way so upstream merges apply cleanly.
- Tokify additions live in **new packages** and **new `cmd/` entries**
  (`cmd/tock-desktop`). Avoid editing upstream files unless the change is
  intended to flow back upstream as a PR — bug fixes and non-desktop
  improvements should be upstreamable.
- Upstream copyright notices are preserved unchanged.

## Layout

```
cmd/tock              upstream CLI entrypoint (don't add desktop concerns)
cmd/tock-desktop      Wails desktop app (Tokify additions live here)
  app.go              Wails-bound App struct; owns tock Runtime; tray code
  main.go             wails.Run + systray wiring (darwin-only build tag)
  frontend/           React + TypeScript + Vite + Tailwind v4 + shadcn/ui
  build/              Wails output (.app) and platform assets
cmd/tock-teams-auth   short-lived WKWebView subprocess for the Teams sign-in
                      flow (cgo, darwin-only); built by `make teams-auth-build`
                      and copied into Tokify.app/Contents/MacOS/ at release time
internal/             shared domain — used by both CLI and desktop
  app/                application services (runtime, export, watching, …)
  adapters/           repository implementations (sqlite, text log)
  core/               models, ports, errors — the domain
  integrations/teams  Teams status integration (Keychain-backed tokens,
                      presence API client, opt-in project allowlist)
  services/activity   activity service
docs/tock.md          upstream README (preserve verbatim)
skills/tock/          tock CLI skill manifest (for OpenClaw)
scripts/              helper scripts (gen-notices, test data refresh)
TOKIFY.md             fork relationship + license posture
```

## Build, test, lint

All from the repo root via Makefile targets:

```sh
make desktop-dev               # Wails dev server, Vite hot reload (also
                               # rebuilds tock-teams-auth)
make desktop-build             # host-arch .app (fast incremental); bundles
                               # tock-teams-auth into Contents/MacOS/
make desktop-build-universal   # arm64 + amd64 fat binary for release
make desktop-run               # build, then `open Tokify.app`
make desktop-doctor            # verify Wails toolchain
make teams-auth-build          # build cmd/tock-teams-auth to ./bin/ (cgo)
make teams-auth-build-universal# universal cgo build via clang -arch + lipo

make test                      # Go tests inside Docker (golang:1.26.3)
make linter                    # golangci-lint inside Docker
make build                     # build the upstream `tock` CLI in Docker
make notices                   # regenerate THIRD_PARTY_NOTICES.txt
```

Notes:

- Go version is pinned in `go.mod` (currently `go 1.26.3`); the Docker
  targets pin the toolchain image to match.
- Wails **cannot cross-compile macOS in Docker**, so `desktop-*` targets run
  on the host. Install the Wails CLI first:
  `go install github.com/wailsapp/wails/v2/cmd/wails@latest`.
- After `desktop-build`, the bundle is renamed from `tock-desktop.app` to
  `Tokify.app` by the Makefile — Wails derives the bundle directory from the
  project name in `wails.json`.

## Frontend (cmd/tock-desktop/frontend)

Stack:

- React 18 + TypeScript, bundled by Vite 8
- **Tailwind CSS v4** (CSS-first config via `@theme inline` in
  `src/style.css`; no `tailwind.config.js`)
- **shadcn/ui** under `src/components/ui/` — style is `radix-nova`,
  base color `neutral`, configured in `components.json`
- `lucide-react` for icons, `sonner` for toasts, `date-fns` for time
  formatting, `next-themes`-style `dark` class toggling done by hand in
  `App.tsx` (theme state lives in `localStorage` under `tokify.theme`)
- Geist Variable font via `@fontsource-variable/geist`
- Wails Go bindings are generated into `frontend/wailsjs/` — import from
  `../wailsjs/go/main/App` and `../wailsjs/go/models`; never hand-edit.
- TS path alias: `@` → `src/` (see `tsconfig.json`). Use `cn()` from
  `@/lib/utils` for class composition.

### Frontend development guidelines

- **Use the [`frontend-design` skill](https://github.com/anthropics/skills/tree/main/frontend-design)
  from Anthropic** whenever the task involves visual design choices —
  shaping a new screen, redesigning an existing one, picking typography,
  spacing, color, or making the UI feel intentional rather than templated.
  Trigger it before reaching for shadcn defaults. It is registered as
  `frontend-design:frontend-design` in this environment; invoke it via the
  Skill tool.
- Prefer extending existing shadcn primitives in `src/components/ui/` to
  installing new ones. If you must add one, use `shadcn add` with the
  `radix-nova` style so it stays consistent.
- Tailwind v4 is **CSS-first**: design tokens are CSS variables in
  `:root` / `.dark` blocks of `src/style.css`. Don't try to add a
  `tailwind.config.js` — extend the `@theme inline` block instead.
- Animations: keep using `tw-animate-css` utilities (`animate-in`,
  `fade-in-0`, etc.) plus the spring-flavored easings already defined in
  `App.tsx` (`EASE_THUNK`, `EASE_OUT`). Match the existing feel — the app
  has a deliberate calm/tactile aesthetic, not bouncy or generic.
- Drag regions: window chrome uses `dragStyle` / `noDragStyle` in
  `App.tsx` (CSS custom property `--wails-draggable` + `WebkitAppRegion`).
  Any new title-bar element must opt in/out explicitly.
- The window is **frameless with inset traffic lights** (`mac.TitleBarHiddenInset`
  in `cmd/tock-desktop/main.go`). The Masthead's left padding of `pl-28`
  reserves room for them — preserve that.
- Persisted UI state lives in `localStorage` keys prefixed `tokify.*`
  (`tokify.theme`, `tokify.activityView`, `tokify.showScrollbars`,
  `tokify.showAccount`, `tokify.displayName`, `tokify.email`). Use the same
  prefix and `try { … } catch {}` pattern for any new key.
- Closing the window leaves the app in the menu bar
  (`HideWindowOnClose: true`). The tray code lives in `cmd/tock-desktop/app.go`
  — re-render its title via `refreshTrayTitle` after any mutation that
  affects what's running.

### Useful skills

These are registered in this environment and worth reaching for when they fit:

- `frontend-design:frontend-design` — visual design guidance (see above).
- `verify` — launch the built app and confirm a change actually works.
  Wraps the "build + open Tokify.app + drive it" loop.
- `run` — generic "launch the app" skill; for this repo it boils down to
  `make desktop-dev` (with hot reload) or `make desktop-run` (built .app).
- `code-review` / `simplify` — review or auto-fix the current diff.
- `security-review` — pre-PR security pass.

## Backend (Go) notes

- Domain logic must stay in `internal/`. `cmd/tock-desktop/app.go` is just a
  thin Wails-bound surface that owns a `runtime.Runtime` and forwards calls
  to upstream services. Resist the urge to embed business rules in `app.go`.
- The desktop entrypoint has `//go:build darwin` build tags. Anything new
  in `cmd/tock-desktop/` should respect that — the package will not
  compile on Linux/Windows.
- SQLite backend uses `mattn/go-sqlite3` + `doug-martin/goqu`. The text-log
  backend (`~/.tock.txt`) is the default and the source of truth for the
  fork.
- `make linter` uses `golangci-lint` v2 with `.golangci.yaml`. Run it
  before declaring a Go change done.
- Mocks are generated by `mockery` (`.mockery.yaml`). Don't hand-write
  mocks for ports under `internal/core/ports`.

## Working agreements

- **Don't add features, abstractions, or files that the task doesn't
  require.** This codebase favors small, focused changes.
- **Don't write comments that restate the code.** The existing code uses
  comments sparingly and only for non-obvious *why*. Match that.
- **No emojis in code or commits** unless the user asks for them.
- For UI changes: actually run the app (`make desktop-dev` or
  `make desktop-run`) and exercise the change before reporting done.
  Type-checks alone do not verify UI behavior.
- For changes that could flow back upstream (anything outside
  `cmd/tock-desktop/`), keep them minimal and self-contained so they're
  easy to extract as an upstream PR.
- Don't commit unless the user asks. When you do, follow the existing
  commit-message style (`git log` — short imperative subject, no
  conventional-commit prefix).

## Quick references

- Main branch: `main`. PRs target `main`.
- Upstream remote: `https://github.com/kriuchkov/tock.git` (branch `master`).
- Releases via `.goreleaser.yaml`; install one-liner in `install.sh`.
- Configuration example: `tock.yaml.example`.
- Third-party notices: `cmd/tock-desktop/build/darwin/Resources/THIRD_PARTY_NOTICES.txt`
  regenerated by `make notices` (requires `go-licenses`,
  `license-checker-rseidelsohn`, and `jq` on PATH).
