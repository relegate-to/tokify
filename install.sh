#!/bin/sh
set -e

# Tokify installer for macOS.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/finchett/tokify/main/install.sh | sh
#
# Environment overrides:
#   VERSION=v0.1.0   pin a specific tag instead of "latest"
#   INSTALL_DIR=...  install destination (default: /Applications)

OWNER="finchett"
REPO="tokify"
APP_NAME="Tokify.app"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"

if [ "$(uname -s)" != "Darwin" ]; then
    echo "Tokify currently only ships a macOS build."
    echo "On other platforms, build from source: https://github.com/${OWNER}/${REPO}#build-from-source"
    exit 1
fi

if [ -z "$VERSION" ]; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/${OWNER}/${REPO}/releases/latest" \
        | grep '"tag_name":' \
        | sed -E 's/.*"([^"]+)".*/\1/')
fi

if [ -z "$VERSION" ]; then
    echo "Could not determine the latest Tokify release."
    echo "Visit https://github.com/${OWNER}/${REPO}/releases to download manually."
    exit 1
fi

ASSET="Tokify-${VERSION}-macos-universal.zip"
DOWNLOAD_URL="https://github.com/${OWNER}/${REPO}/releases/download/${VERSION}/${ASSET}"

echo "Installing Tokify ${VERSION} to ${INSTALL_DIR}/${APP_NAME}"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${DOWNLOAD_URL}"
curl -fsSL "$DOWNLOAD_URL" -o "$TMP_DIR/$ASSET"

echo "Unpacking..."
unzip -q "$TMP_DIR/$ASSET" -d "$TMP_DIR"

if [ ! -d "$TMP_DIR/$APP_NAME" ]; then
    echo "Unexpected archive contents — ${APP_NAME} not found inside ${ASSET}."
    exit 1
fi

# Move into place. Use sudo only if the destination isn't writable.
if [ -w "$INSTALL_DIR" ]; then
    SUDO=""
else
    SUDO="sudo"
fi

if [ -d "$INSTALL_DIR/$APP_NAME" ]; then
    echo "Replacing existing ${INSTALL_DIR}/${APP_NAME}"
    $SUDO rm -rf "$INSTALL_DIR/$APP_NAME"
fi

$SUDO mv "$TMP_DIR/$APP_NAME" "$INSTALL_DIR/$APP_NAME"

# Tokify releases are not (yet) signed with an Apple Developer ID. Strip the
# quarantine attribute so Gatekeeper opens the app cleanly on first launch.
$SUDO xattr -dr com.apple.quarantine "$INSTALL_DIR/$APP_NAME" || true

echo ""
echo "Tokify ${VERSION} installed to ${INSTALL_DIR}/${APP_NAME}"
echo "Launch it from Spotlight, the Applications folder, or:"
echo "  open '${INSTALL_DIR}/${APP_NAME}'"
