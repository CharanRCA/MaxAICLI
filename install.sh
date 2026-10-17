#!/bin/sh
# Install maxaicli ("maxai") for the current user. No root needed.
#   ./install.sh            from a checkout: builds the single-file bundle and installs it
#   MAXAI_PREFIX=~/tools ./install.sh
# Needs Node >= 18 (use a prebuilt standalone binary from the releases page to avoid even that).
set -eu
PREFIX="${MAXAI_PREFIX:-$HOME/.local}"
HERE="$(cd "$(dirname "$0")" && pwd)"

command -v node >/dev/null 2>&1 || { echo "maxai: Node.js >= 18 is required (https://nodejs.org), or download a standalone binary from the releases page." >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "maxai: Node >= 18 required, found $(node -v)" >&2; exit 1; }

mkdir -p "$PREFIX/bin" "$PREFIX/share/maxaicli"
if [ -f "$HERE/package.json" ] && [ -f "$HERE/scripts/build.mjs" ]; then
  # `npm ci` installs the dev-only bundler; the installed program itself has zero dependencies.
  (cd "$HERE" && { [ -d node_modules/esbuild ] || npm install --no-audit --no-fund >/dev/null; } && node scripts/build.mjs >/dev/null)
  cp "$HERE/dist/maxaicli.cjs" "$PREFIX/share/maxaicli/maxaicli.cjs"
else
  echo "maxai: run this from a checkout of the repository" >&2; exit 1
fi

NODE_BIN="$(command -v node)"
for name in maxai maxaicli; do
  cat > "$PREFIX/bin/$name" <<WRAP
#!/bin/sh
exec "$NODE_BIN" "$PREFIX/share/maxaicli/maxaicli.cjs" "\$@"
WRAP
  chmod +x "$PREFIX/bin/$name"
done

echo "installed: $PREFIX/bin/maxai (also: maxaicli)"
case ":$PATH:" in *":$PREFIX/bin:"*) ;; *) echo "note: add $PREFIX/bin to your PATH, e.g.  echo 'export PATH=\"$PREFIX/bin:\$PATH\"' >> ~/.profile" ;; esac
echo "next: maxai install   # fetch the agent CLIs,   maxai ui   # web UI,   maxai   # interactive"
