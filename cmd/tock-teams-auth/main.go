//go:build darwin

// tock-teams-auth is a short-lived helper that drives one Microsoft sign-in
// round-trip in a real WKWebView window so we can intercept the
// teams.microsoft.com/go fragment redirect without asking the user to paste
// anything. It's invoked as a subprocess by the main Tokify app, runs the
// macOS run-loop in its own process so it doesn't fight with Wails' webview,
// prints the captured redirect URL to stdout, and exits.
//
// Usage: tock-teams-auth [--silent] <auth-url>
//
//	--silent  run with no visible window or Dock icon, give AAD ~15s to
//	          complete a prompt=none redirect, then exit. Used for silent
//	          re-auth via the persistent WKWebView cookie jar.
//	auth-url  the full Microsoft authorize URL the parent has built (with
//	          PKCE challenge, state, etc. already baked in)
//
// Exit codes:
//
//	0 success — captured redirect URL printed to stdout
//	1 invocation error (bad args)
//	2 user closed the window before completing sign-in (interactive) or
//	  silent attempt timed out without a redirect
package main

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	webview "github.com/webview/webview_go"
)

const redirectPrefix = "https://teams.microsoft.com/go"

func main() {
	args := os.Args[1:]
	silent := false
	if len(args) > 0 && args[0] == "--silent" {
		silent = true
		args = args[1:]
	}
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: tock-teams-auth [--silent] <auth-url>")
		os.Exit(1)
	}
	loginURL := args[0]

	if silent {
		// Suppress the Dock icon for the background refresh. Must run before
		// the WKWebView is built — webview.New() finalizes the NSApplication.
		makeAccessory()
	}

	w := webview.New(false)
	defer w.Destroy()
	w.SetTitle("Sign in to Microsoft Teams")
	w.SetSize(900, 720, webview.HintNone)

	if !silent {
		// Without an Edit menu attached to NSApp, Cmd+V never makes it to the
		// WKWebView's focused text field. webview_go creates the NSApplication
		// but no menu; we attach one here.
		installEditMenu()
	} else {
		// Hide the WKWebView's host window. The WKWebView keeps running and
		// follows redirects; only the on-screen NSWindow is suppressed.
		hideWindow(w.Window())
		// AAD's prompt=none either redirects within a second or two, or never
		// (network failure). Cap the wait so we don't pin a subprocess forever.
		go func() {
			time.Sleep(15 * time.Second)
			w.Terminate()
		}()
	}

	var (
		mu       sync.Mutex
		captured string
	)

	// __tokifyURL is called from injected JS whenever the page URL changes.
	// We can't observe navigation events from outside the webview, so we
	// poll inside the document context. Cross-origin pages still see this
	// script because Init uses WKUserScript which applies to all frames at
	// document-start.
	if err := w.Bind("__tokifyURL", func(url string) {
		if !strings.HasPrefix(url, redirectPrefix) {
			return
		}
		// A bare landing on teams.microsoft.com/go with no query AND no
		// fragment means MS bounced us without issuing anything — surface
		// that as an explicit failure rather than a silent close so the
		// caller doesn't think the user cancelled.
		if !strings.ContainsAny(url, "?#") {
			fmt.Fprintln(os.Stderr, "auth completed with no code or error in URL — MS likely rejected the request")
			w.Terminate()
			return
		}
		mu.Lock()
		if captured == "" {
			captured = url
		}
		mu.Unlock()
		// Terminate from any goroutine is safe; webview marshals to its
		// own thread internally.
		w.Terminate()
	}); err != nil {
		fmt.Fprintf(os.Stderr, "bind: %v\n", err)
		os.Exit(1)
	}

	w.Init(`
        (function () {
            var last = '';
            function ping() {
                try {
                    if (location.href !== last) {
                        last = location.href;
                        window.__tokifyURL(location.href);
                    }
                } catch (e) { /* binding not ready yet */ }
            }
            ping();
            setInterval(ping, 120);
        })();
    `)

	w.Navigate(loginURL)
	w.Run()

	mu.Lock()
	out := captured
	mu.Unlock()
	if out == "" {
		os.Exit(2)
	}
	fmt.Println(out)
}
