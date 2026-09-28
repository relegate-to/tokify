//go:build darwin

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/go-faster/errors"
)

const (
	cliName = "tokify"
	// /usr/local/bin is on the default macOS PATH (/etc/paths), so a link there
	// works in every shell without editing anyone's rc files.
	cliLinkPath = "/usr/local/bin/" + cliName
)

// CLIStatus describes the `tokify` link in PATH for the Settings row.
type CLIStatus struct {
	Installed bool   `json:"installed"`
	Path      string `json:"path"`
	// Conflict is set when something other than this app already owns Path.
	Conflict string `json:"conflict"`
}

func appExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", errors.Wrap(err, "locate app binary")
	}
	return filepath.EvalSymlinks(exe)
}

// CLIStatus reports whether `tokify` in PATH points at this app.
func (a *App) CLIStatus() (CLIStatus, error) {
	status := CLIStatus{Path: cliLinkPath}
	exe, err := appExecutable()
	if err != nil {
		return status, err
	}
	info, err := os.Lstat(cliLinkPath)
	if errors.Is(err, os.ErrNotExist) {
		return status, nil
	}
	if err != nil {
		return status, err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		status.Conflict = cliLinkPath + " is another program"
		return status, nil
	}
	target, err := filepath.EvalSymlinks(cliLinkPath)
	if err == nil && target == exe {
		status.Installed = true
		return status, nil
	}
	// A link left by an older copy of the app (or one that was moved) is ours
	// to replace; a link into anything else is not.
	raw, _ := os.Readlink(cliLinkPath)
	if strings.HasSuffix(raw, ".app/Contents/MacOS/Tokify") {
		return status, nil
	}
	status.Conflict = cliLinkPath + " points to " + raw
	return status, nil
}

// InstallCLI links `tokify` into PATH. /usr/local/bin is usually root-owned, in
// which case macOS asks for an administrator password through its own dialog.
func (a *App) InstallCLI() (CLIStatus, error) {
	status, err := a.CLIStatus()
	if err != nil || status.Installed {
		return status, err
	}
	if status.Conflict != "" {
		return status, errors.New(status.Conflict + "; remove it first")
	}
	exe, err := appExecutable()
	if err != nil {
		return status, err
	}
	if linkErr := linkCLI(exe); linkErr != nil {
		script := "mkdir -p /usr/local/bin && ln -sfn " + shellQuote(exe) + " " + shellQuote(cliLinkPath)
		if err = runAsAdmin(script, "Tokify wants to add the tokify command to your PATH."); err != nil {
			return status, err
		}
	}
	return a.CLIStatus()
}

// UninstallCLI removes the link, but only while it still points at this app.
func (a *App) UninstallCLI() (CLIStatus, error) {
	status, err := a.CLIStatus()
	if err != nil || !status.Installed {
		return status, err
	}
	if rmErr := os.Remove(cliLinkPath); rmErr != nil {
		if err = runAsAdmin("rm -f "+shellQuote(cliLinkPath), "Tokify wants to remove the tokify command."); err != nil {
			return status, err
		}
	}
	return a.CLIStatus()
}

func linkCLI(exe string) error {
	if err := os.MkdirAll(filepath.Dir(cliLinkPath), 0o755); err != nil {
		return err
	}
	_ = os.Remove(cliLinkPath)
	return os.Symlink(exe, cliLinkPath)
}

func runAsAdmin(script, prompt string) error {
	src := "do shell script " + appleScriptString(script) +
		" with prompt " + appleScriptString(prompt) +
		" with administrator privileges"
	out, err := exec.Command("osascript", "-e", src).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if strings.Contains(msg, "-128") {
			return errors.New("cancelled")
		}
		return errors.Errorf("administrator command failed: %s", msg)
	}
	return nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func appleScriptString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}
