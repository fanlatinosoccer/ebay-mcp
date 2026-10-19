#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
export PATH="$HOME/.local/bin:$PATH"
NODE_BIN=/usr/bin/node
# Export .env via Python so '#' inside eBay tokens is preserved
eval "$(python3 - <<'PY'
from pathlib import Path
import shlex
for line in Path('.env').read_text().splitlines():
    s=line.strip()
    if not s or s.startswith('#') or '=' not in s:
        continue
    k,v=s.split('=',1)
    k=k.strip(); v=v.strip()
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        v=v[1:-1]
    # unescape common dotenv escapes
    v=v.replace('\\"','"').replace('\\\\','\\')
    print(f'export {k}={shlex.quote(v)}')
PY
)"
export EBAY_READ_ONLY=false
export EBAY_MCP_MEDIA_DIRS=/workspace/fls/ebay-drafts:/workspace/fls/ebay-assets
export EBAY_ENVIRONMENT=production
export EBAY_MARKETPLACE_ID=EBAY_US
export EBAY_CONTENT_LANGUAGE=en-US
# sanity without printing secrets
python3 - <<'PY'
import os, sys
print('boot refresh_len', len(os.environ.get('EBAY_USER_REFRESH_TOKEN','')),
      'access_len', len(os.environ.get('EBAY_USER_ACCESS_TOKEN','')),
      'readonly', os.environ.get('EBAY_READ_ONLY'), file=sys.stderr)
PY

# Self-heal: rebuild if build/index.js or node_modules is missing (stderr only; keep MCP stdio clean)
if [[ ! -f build/index.js || ! -d node_modules ]]; then
  {
    echo "start-mcp.sh: missing build/index.js or node_modules; running pnpm install + build..."
    echo "start-mcp.sh: node=$("$NODE_BIN" -v) pnpm=$(pnpm -v 2>/dev/null || echo missing)"
    if ! command -v pnpm >/dev/null 2>&1; then
      echo "start-mcp.sh: ERROR: pnpm not found on PATH (need 10.14.0 in \$HOME/.local/bin)" >&2
      exit 1
    fi
    if ! pnpm install --frozen-lockfile --ignore-scripts; then
      echo "start-mcp.sh: ERROR: pnpm install --frozen-lockfile --ignore-scripts failed" >&2
      exit 1
    fi
    if ! pnpm run build; then
      echo "start-mcp.sh: ERROR: pnpm run build failed" >&2
      exit 1
    fi
    if [[ ! -f build/index.js ]]; then
      echo "start-mcp.sh: ERROR: build/index.js still missing after rebuild" >&2
      exit 1
    fi
    echo "start-mcp.sh: rebuild OK"
  } >&2
fi

exec "$NODE_BIN" build/index.js
