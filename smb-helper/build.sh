#!/usr/bin/env bash
# Builds the SMB2/3 helper binary `amelie-smb` (Go, static, ~3.5MB) that gets
# embedded into the AppImage. The Go toolchain is needed ONLY here (build machine);
# the end user receives the ready-made binary.
#
# Usage:  ./smb-helper/build.sh          (uses the system `go` if present)
#         the binary stays in smb-helper/amelie-smb (bundled via extraResources)
set -euo pipefail
cd "$(dirname "$0")"

# Find a usable Go: first the system one, then a portable one downloaded
# into a local cache (no root required).
GO=""
if command -v go >/dev/null 2>&1; then
  GO="go"
else
  GOVER="go1.25.12"
  CACHE="${TMPDIR:-/tmp}/amelie-go-toolchain"
  if [ ! -x "$CACHE/go/bin/go" ]; then
    echo "Go non trovato — scarico $GOVER (portabile, solo per il build)…"
    mkdir -p "$CACHE"
    curl -fsSL "https://go.dev/dl/${GOVER}.linux-amd64.tar.gz" -o "$CACHE/go.tgz"
    tar -xzf "$CACHE/go.tgz" -C "$CACHE"
  fi
  export GOROOT="$CACHE/go"; export PATH="$GOROOT/bin:$PATH"
  export GOPATH="$CACHE/gopath"; export GOCACHE="$CACHE/gocache"
  GO="$CACHE/go/bin/go"
fi

echo "Compilo amelie-smb (statico, x86-64)…"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 "$GO" build -ldflags "-s -w" -trimpath -o amelie-smb .
chmod +x amelie-smb
echo "Fatto: $(du -h amelie-smb | cut -f1)  →  smb-helper/amelie-smb"
file amelie-smb | grep -q "statically linked" && echo "✓ statico (nessuna dipendenza a runtime)" || echo "! ATTENZIONE: non statico"
