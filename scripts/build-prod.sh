#!/usr/bin/env bash
# Build a production-ready zip for deployment to the Namecheap UpQ server.
# Usage: bash scripts/build-prod.sh [output-dir]
#
# The zip is written to <output-dir> (default: project root).
# Run npm ci --omit=dev on the server after uploading and extracting.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="${1:-$PROJECT_DIR}"

VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"
ZIP_NAME="UPQ-PROD-${VERSION}.zip"
ZIP_PATH="$OUTPUT_DIR/$ZIP_NAME"

cd "$PROJECT_DIR"

# Remove any previous build with the same name.
rm -f "$ZIP_PATH"

echo "Building $ZIP_NAME ..."

zip -r "$ZIP_PATH" \
  src/ \
  config/ \
  namecheap-maintenance/ \
  scripts/create-admin.js \
  scripts/reset-user-password.js \
  scripts/get-verify-url.js \
  scripts/delete-test-user.js \
  package.json \
  package-lock.json \
  .env.example \
  LICENSE.txt \
  -x "**/.DS_Store" -x "*/.DS_Store" -x ".DS_Store"

echo ""
echo "Created: $ZIP_PATH"
echo "Size:    $(du -sh "$ZIP_PATH" | cut -f1)"
echo ""
echo "Deploy steps:"
echo "  1. Upload $ZIP_NAME to the server"
echo "  2. unzip $ZIP_NAME"
echo "  3. cd into the extracted directory"
echo "  4. npm ci --omit=dev"
echo "  5. Copy / update .env with production values"
echo "  6. Restart the app (pm2 restart all, or equivalent)"
