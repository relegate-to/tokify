# Tokify and tock

Tokify began as a fork of [tock](https://github.com/kriuchkov/tock) by
[Vladimir Kriuchkov](https://github.com/kriuchkov). It retains and extends
tock's original domain code, but ships as the Tokify macOS application and a
Tokify-native `tokify` command-line interface. It does not ship the old `tock`
executable or its separate backend/config system.

The Go module path remains `github.com/kriuchkov/tock` to preserve source
history and attribution. It is an internal implementation detail, not a second
installed product.

Tokify inherits tock's **GPL-3.0-or-later** license. See [`LICENSE`](LICENSE).
Existing upstream copyright notices remain intact.
