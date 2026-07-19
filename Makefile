
linter:
	docker run -t --rm -v $$(pwd):/app -w /app \
	-v $$(go env GOCACHE):/.cache/go-build -e GOCACHE=/.cache/go-build \
	-v $$(go env GOMODCACHE):/.cache/mod -e GOMODCACHE=/.cache/mod \
	-v ~/.cache/golangci-lint:/.cache/golangci-lint -e GOLANGCI_LINT_CACHE=/.cache/golangci-lint \
	-e CGO_CFLAGS="-D_LARGEFILE64_SOURCE" \
	golangci/golangci-lint:v2.12.2-alpine golangci-lint run --fix --config .golangci.yaml --timeout 5m --concurrency 4

test:
	docker run -t --rm -v $$(pwd):/app -w /app \
	-v $$(go env GOCACHE):/.cache/go-build -e GOCACHE=/.cache/go-build \
	-v $$(go env GOMODCACHE):/.cache/mod -e GOMODCACHE=/.cache/mod \
	--entrypoint "" golang:1.26.3 sh -c "go test -v -count=1 -p 4 -coverprofile=coverage.out ./... && go tool cover -func=coverage.out && go tool cover -html=coverage.out -o coverage.html"

build:
	docker run -t --rm -v $$(pwd):/app -w /app \
	-v $$(go env GOCACHE):/.cache/go-build -e GOCACHE=/.cache/go-build \
	-v $$(go env GOMODCACHE):/.cache/mod -e GOMODCACHE=/.cache/mod \
	--entrypoint "" golang:1.26.3 sh -c "go build -o tock ./cmd/tock"

# Refresh test data by running the script that generates it.
# By default, it refreshes data for the last 1 day,
refresh-test-data:
	python3 scripts/refresh_test_data.py --days $(or $(DAYS),1)

# ── Desktop app (Wails) ──────────────────────────────────────────────────
# These targets run on the host (Wails can't cross-compile macOS in Docker).
# Install the CLI first:  go install github.com/wailsapp/wails/v2/cmd/wails@latest

WAILS ?= wails
DESKTOP_DIR := cmd/tock-desktop
TEAMS_AUTH_DIR := cmd/tock-teams-auth
BIN_DIR := bin

# Neon endpoints baked into distributable .app builds via -ldflags. They live in
# a gitignored .env (copy .env.example) so the project URLs stay out of the repo;
# override per-invocation to point a release at a different project. Only the
# release build targets inject these — desktop-dev leaves them unset so local dev
# falls back to the TOKIFY_NEON_*_URL env vars or the on-disk settings file.
-include .env
NEON_AUTH_URL ?=
NEON_DATA_URL ?=
DESKTOP_LDFLAGS := -X github.com/kriuchkov/tock/internal/integrations/neonauth.DefaultAuthURL=$(NEON_AUTH_URL) -X github.com/kriuchkov/tock/internal/integrations/neonsync.DefaultDataURL=$(NEON_DATA_URL)

# App version stamped into release builds for the Settings "Check for updates"
# panel, derived from the current git tag (e.g. v0.1.0). Overridable per-invoke.
# Only the build targets inject it; desktop-dev leaves it at the source default.
DESKTOP_VERSION ?= $(patsubst v%,%,$(shell git describe --tags --always --dirty 2>/dev/null))
ifneq ($(strip $(DESKTOP_VERSION)),)
DESKTOP_LDFLAGS += -X main.version=$(DESKTOP_VERSION)
endif

# Build the Teams sign-in helper binary. Used in dev mode (found via the
# parent directory of the dev binary) and copied into the .app bundle on
# release builds. Built outside the Wails pipeline so we control the cgo
# flags and architecture explicitly.
teams-auth-build:
	@mkdir -p $(BIN_DIR)
	go build -o $(BIN_DIR)/tock-teams-auth ./$(TEAMS_AUTH_DIR)
	@echo "Built $(BIN_DIR)/tock-teams-auth"

teams-auth-build-universal:
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=1 GOOS=darwin GOARCH=arm64 \
		CC="clang -arch arm64" CXX="clang++ -arch arm64" \
		go build -o $(BIN_DIR)/tock-teams-auth-arm64 ./$(TEAMS_AUTH_DIR)
	CGO_ENABLED=1 GOOS=darwin GOARCH=amd64 \
		CC="clang -arch x86_64" CXX="clang++ -arch x86_64" \
		go build -o $(BIN_DIR)/tock-teams-auth-amd64 ./$(TEAMS_AUTH_DIR)
	lipo -create -output $(BIN_DIR)/tock-teams-auth \
		$(BIN_DIR)/tock-teams-auth-arm64 $(BIN_DIR)/tock-teams-auth-amd64
	@rm $(BIN_DIR)/tock-teams-auth-arm64 $(BIN_DIR)/tock-teams-auth-amd64
	@echo "Built universal $(BIN_DIR)/tock-teams-auth"

# Build a .app for the host architecture (fastest).
desktop-build: teams-auth-build
	cd $(DESKTOP_DIR) && $(WAILS) build -clean -ldflags "$(DESKTOP_LDFLAGS)"
	@rm -rf $(DESKTOP_DIR)/build/bin/Tokify.app
	@mv $(DESKTOP_DIR)/build/bin/tock-desktop.app $(DESKTOP_DIR)/build/bin/Tokify.app
	@cp $(BIN_DIR)/tock-teams-auth $(DESKTOP_DIR)/build/bin/Tokify.app/Contents/MacOS/tock-teams-auth
	@echo "Built $(DESKTOP_DIR)/build/bin/Tokify.app"

# Build a universal (arm64 + amd64) .app suitable for distribution.
desktop-build-universal: teams-auth-build-universal
	cd $(DESKTOP_DIR) && $(WAILS) build -clean -platform darwin/universal -ldflags "$(DESKTOP_LDFLAGS)"
	@rm -rf $(DESKTOP_DIR)/build/bin/Tokify.app
	@mv $(DESKTOP_DIR)/build/bin/tock-desktop.app $(DESKTOP_DIR)/build/bin/Tokify.app
	@cp $(BIN_DIR)/tock-teams-auth $(DESKTOP_DIR)/build/bin/Tokify.app/Contents/MacOS/tock-teams-auth
	@echo "Built $(DESKTOP_DIR)/build/bin/Tokify.app"

# Build and open the resulting .app.
desktop-run: desktop-build
	open $(DESKTOP_DIR)/build/bin/Tokify.app

# Live-reload dev server with Go bindings exposed at http://localhost:34115.
# Builds the auth helper first so Connect works in dev. The desktop binary's
# helper-lookup walks up to repo root and finds it under ./bin/.
desktop-dev: teams-auth-build
	cd $(DESKTOP_DIR) && \
		TOKIFY_NEON_AUTH_URL="$(NEON_AUTH_URL)" TOKIFY_NEON_DATA_URL="$(NEON_DATA_URL)" \
		$(WAILS) dev

# Check that the Wails CLI and its prerequisites are installed.
desktop-doctor:
	cd $(DESKTOP_DIR) && $(WAILS) doctor

# Regenerate THIRD_PARTY_NOTICES.txt for bundled Go and npm deps.
# Requires go-licenses, license-checker-rseidelsohn, and jq on PATH.
notices:
	./scripts/gen-notices.sh

.PHONY: desktop-build desktop-build-universal desktop-run desktop-dev desktop-doctor notices teams-auth-build teams-auth-build-universal
