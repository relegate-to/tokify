# Tokify

Tokify is a desktop time tracking application built as a respectful fork of
[**tock**](https://github.com/kriuchkov/tock) by
[Vladimir Kriuchkov](https://github.com/kriuchkov).

It ships:

- The original `tock` CLI, kept in sync with upstream.
- `tock-desktop` — a Wails-based desktop GUI that reuses tock's domain
  services so the CLI and GUI stay behaviorally identical.

## Relationship to upstream

Tokify is a fork, not a rewrite. The goal is to add a desktop UI on top of
tock without diverging from upstream behavior.

- `git remote get-url upstream` → `https://github.com/kriuchkov/tock.git`
- Upstream's default branch (`master`) is merged into our `main` regularly.
- Bug fixes and improvements that aren't desktop-specific are intended to
  flow back to upstream as PRs.
- The Go module path is left as `github.com/kriuchkov/tock` so that
  upstream merges apply cleanly. Tokify additions live in new packages and
  new `cmd/` entries (e.g. `cmd/tock-desktop`).

## License

Tokify inherits tock's license: **GPL-3.0-or-later**. See [`LICENSE`](LICENSE).
All upstream copyright notices are preserved unchanged.

## Upstream README

Tock's own README is preserved verbatim at [`docs/tock.md`](docs/tock.md) so
merges from upstream stay friction-free. The top-level [`README.md`](README.md)
documents Tokify itself.
