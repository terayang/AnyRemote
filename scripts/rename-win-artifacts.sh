#!/usr/bin/env bash
# Rename Windows build outputs to versioned, flavor-distinct filenames:
#   AnyRemote.exe                      -> AnyRemote-<version>-windows-x64-portable.exe
#   AnyRemote-amd64-installer.exe      -> AnyRemote-<version>-windows-x64-installer.exe
# (<version> is read from the root package.json)
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"

cd build/bin
for f in AnyRemote.exe AnyRemote-amd64-installer.exe; do
  [ -f "$f" ] || { echo "error: expected artifact missing: $f" >&2; exit 1; }
done
mv -f AnyRemote.exe "AnyRemote-${VERSION}-windows-x64-portable.exe"
mv -f AnyRemote-amd64-installer.exe "AnyRemote-${VERSION}-windows-x64-installer.exe"
ls -lh ./*.exe
