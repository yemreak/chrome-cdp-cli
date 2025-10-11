#!/usr/bin/env bash
set -e

VERSION=$(cat package.json | grep '"version"' | head -1 | awk -F: '{ print $2 }' | sed 's/[",]//g' | tr -d '[[:space:]]')

echo "Publishing @yemreak/chrome-cdp v${VERSION} to npm..."

npm publish --access public

echo "✓ Published @yemreak/chrome-cdp v${VERSION}"
echo ""
echo "Install: bun install -g @yemreak/chrome-cdp"
echo "Verify: https://www.npmjs.com/package/@yemreak/chrome-cdp"
