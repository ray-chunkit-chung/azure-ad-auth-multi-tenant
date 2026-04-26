#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_DIR="$DIST_DIR/package"

rm -rf "$DIST_DIR"
mkdir -p "$PACKAGE_DIR"

python -m pip install --upgrade pip
python -m pip install -r "$ROOT_DIR/requirements.txt" -t "$PACKAGE_DIR"
cp "$ROOT_DIR/src/handler.py" "$PACKAGE_DIR/handler.py"

(
  cd "$PACKAGE_DIR"
  zip -rq "$DIST_DIR/lambda.zip" .
)

echo "Built Lambda package at $DIST_DIR/lambda.zip"
