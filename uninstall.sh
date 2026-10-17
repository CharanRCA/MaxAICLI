#!/bin/sh
PREFIX="${MAXAI_PREFIX:-$HOME/.local}"
rm -f "$PREFIX/bin/maxai" "$PREFIX/bin/maxaicli"
rm -rf "$PREFIX/share/maxaicli"
echo "removed maxaicli from $PREFIX (config in ~/.config/maxai and state in ~/.local/state/maxai were left alone)"
