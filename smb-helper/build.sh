#!/usr/bin/env bash
# Compila il binario SMB2/3 helper `amelie-smb` (Go, statico, ~3.5MB) che viene
# incorporato nell'AppImage. Serve la toolchain Go SOLO qui (macchina di build);
# l'utente finale riceve il binario già pronto.
#
# Uso:  ./smb-helper/build.sh          (usa il `go` di sistema se c'è)
#       il binario resta in smb-helper/amelie-smb (bundlato via extraResources)
set -euo pipefail
cd "$(dirname "$0")"

# Trova un Go utilizzabile: prima quello di sistema, poi uno portabile scaricato
# in una cache locale (nessun root richiesto).
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
