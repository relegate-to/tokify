# Tokify

> A calm desktop time tracker for macOS.

<p align="center">
  <img src="cmd/tock-desktop/build/appicon.png" width="128" alt="Tokify app icon" />
</p>

<p align="center">
  <a href="https://github.com/finchett/tokify/releases">
    <img src="https://img.shields.io/github/v/release/finchett/tokify?style=flat-square" alt="Release" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/github/license/finchett/tokify?style=flat-square" alt="License" />
  </a>
  <img src="https://img.shields.io/badge/platform-macOS%2011%2B-lightgrey?style=flat-square" alt="Platform" />
</p>

Tokify is a small, focused time tracker that lives in your menu bar. Start an
activity, get on with your work, glance at the bar to see how long you've been
at it. Close the window and Tokify keeps tracking from the menu bar; click it to
bring the window back, or quit when you're done.

Activities are stored as a plain-text log in your home directory — the same
human-readable file format used by the [tock][tock] command-line tool, so you
can read, grep, edit, or back up your data with anything that handles text.

## Install

### macOS — one-liner

```sh
curl -fsSL https://raw.githubusercontent.com/finchett/tokify/main/install.sh | sh
```

This downloads the latest release, unpacks `Tokify.app` into `/Applications`, and
clears the macOS quarantine flag so it opens cleanly the first time.

### macOS — manual

1. Grab `Tokify-<version>-macos-universal.zip` from the
   [Releases page](https://github.com/finchett/tokify/releases/latest).
2. Unzip and drag `Tokify.app` into `/Applications`.
3. On first launch macOS may warn that the app is from an unidentified
   developer (Tokify is not yet signed with an Apple Developer ID). Either:
   - Right-click `Tokify.app` → **Open** → **Open** in the confirmation dialog, or
   - Run `xattr -dr com.apple.quarantine /Applications/Tokify.app` once.

### Build from source

You'll need Go (matching `go.mod`), Node 18+, and the [Wails CLI][wails]:

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@latest
git clone https://github.com/finchett/tokify
cd tokify
make desktop-build-universal
open cmd/tock-desktop/build/bin/Tokify.app
```

`make desktop-doctor` will verify the toolchain is ready.

## What it looks like

<!-- <p align="center">
  <img src="screenshots/Now-Light.png" alt="Tokify — tracking an activity" width="720" />
</p>

<p align="center">
  <img src="screenshots/History-Dark.png" alt="Tokify — activity history (dark)" width="720" />
</p> -->

The menu bar shows `● 0:42` while tracking, `○` when idle. The window has a
single input for what you're working on, a list of today's activities (and any
earlier days you scroll back to), and an account/settings page reachable from
the title bar.

## Microsoft Teams status (optional)

Tokify can keep your Microsoft Teams **status message** in sync with whatever
you're currently tracking — turn it on in Settings → Integrations.

How it works:

- You sign in once with the same Microsoft account you use for Teams. A
  real Microsoft sign-in window opens (not a web view inside Tokify) and the
  access token is written to your macOS **Keychain**, never to a file.
- You pick which projects the integration applies to. Activities under other
  projects are left private — your Teams status doesn't change.
- When you start an activity under a tracked project, its description
  becomes your Teams status message. When you stop, the message is cleared.

A few things to know:

- The integration uses the standard Microsoft sign-in flow that the Teams
  web client itself uses — no admin approval, no Azure AD app registration
  required. Tenants with strict Conditional Access policies may still
  block it.
- On the sign-in prompt, you **must** choose **Yes** for "Stay signed in?"
  — sign-in won't complete otherwise.
- Tokify only ever writes your status message. It does not read your Teams
  messages, send messages, or access any other Teams data.

## Export

From the menu in the top-right of the window, you can export your activity log
as **CSV**, **JSON**, or plain **TXT**. You can scope the export to a date
range and an optional project. The resulting file is saved wherever you like —
handy for invoicing, reporting, or piping into a spreadsheet.

## Data and configuration

Tokify reads and writes the same files as the [tock CLI][tock]:

- Activity log: `~/.tock.txt` (plain-text, one entry per line)
- Configuration: `~/.config/tock/tock.yaml` (optional — defaults are fine)

This means you can use Tokify and `tock` side by side, sync the log file with any
tool that handles text, or move to a different backend (TimeWarrior, TodoTXT,
SQLite) by editing the config. See [`tock.yaml.example`](tock.yaml.example) for
the full list of options.

## Relationship to tock

Tokify is a desktop frontend built as a respectful fork of
[**tock**][tock] by [Vladimir Kriuchkov][kriuchkov].
The fork adds `cmd/tock-desktop/` (a Wails app) and reuses tock's domain
services so the CLI and GUI stay behaviorally identical. The Go module path is
kept as `github.com/kriuchkov/tock` so upstream merges apply cleanly.

The upstream tock README is preserved verbatim at
[`docs/tock.md`](docs/tock.md). See [`TOKIFY.md`](TOKIFY.md) for how the fork
relates to upstream.

## Development

```sh
make desktop-dev     # Wails dev server with hot reload
make desktop-build   # host-architecture .app, fast incremental
make desktop-build-universal   # arm64 + amd64 fat binary
make test            # Go tests (runs in Docker)
make linter          # golangci-lint (runs in Docker)
```

The frontend (`cmd/tock-desktop/frontend/`) is React + TypeScript with
Tailwind v4 and shadcn/ui. Backend bindings are auto-generated by Wails into
`frontend/wailsjs/`.

More notes for working on the desktop app are in
[`cmd/tock-desktop/README.md`](cmd/tock-desktop/README.md).

## License

GPL-3.0-or-later, inherited from upstream tock. See [`LICENSE`](LICENSE).

[tock]: https://github.com/kriuchkov/tock
[kriuchkov]: https://github.com/kriuchkov
[wails]: https://wails.io
