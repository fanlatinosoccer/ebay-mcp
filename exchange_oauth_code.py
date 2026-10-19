#!/usr/bin/env python3
"""Exchange eBay OAuth authorization code for refresh token; write into .env."""
import json, os, re, sys, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path('/workspace/fls/ebay-mcp')
ENV_PATH = ROOT / '.env'

def load_env():
    env = {}
    for line in ENV_PATH.read_text().splitlines():
        if '=' in line and not line.strip().startswith('#'):
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env

def q(v: str) -> str:
    return '"' + str(v).replace('\\', '\\\\').replace('"', '\\"') + '"'

def upsert_env(updates: dict):
    lines = ENV_PATH.read_text().splitlines()
    out = []
    seen = set()
    for line in lines:
        if '=' in line and not line.strip().startswith('#'):
            k = line.split('=', 1)[0].strip()
            if k in updates:
                out.append(f'{k}={q(updates[k])}')
                seen.add(k)
                continue
        out.append(line)
    for k, v in updates.items():
        if k not in seen:
            out.append(f'{k}={q(v)}')
    ENV_PATH.write_text('\n'.join(out) + '\n')

def extract_code(raw: str) -> str:
    raw = raw.strip().strip('"').strip("'")
    if 'code=' in raw:
        q = urllib.parse.urlparse(raw).query
        # also handle fragment
        if not q and '#' in raw:
            q = raw.split('#', 1)[1]
        params = urllib.parse.parse_qs(q)
        if 'code' in params:
            return urllib.parse.unquote(params['code'][0])
    return urllib.parse.unquote(raw)

def main():
    if len(sys.argv) < 2:
        print('Usage: exchange_oauth_code.py <callback-url-or-code>', file=sys.stderr)
        sys.exit(2)
    code = extract_code(sys.argv[1])
    env = load_env()
    client_id = env['EBAY_CLIENT_ID']
    client_secret = env['EBAY_CLIENT_SECRET']
    redirect = env['EBAY_REDIRECT_URI']
    body = urllib.parse.urlencode({
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': redirect,
    }).encode()
    req = urllib.request.Request(
        'https://api.ebay.com/identity/v1/oauth2/token',
        data=body,
        method='POST',
        headers={
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    )
    import base64
    basic = base64.b64encode(f'{client_id}:{client_secret}'.encode()).decode()
    req.add_header('Authorization', f'Basic {basic}')
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        # print error body if available
        err = getattr(e, 'read', lambda: b'')()
        print('EXCHANGE_FAILED', e, err.decode() if err else '', file=sys.stderr)
        sys.exit(1)
    refresh = data.get('refresh_token')
    access = data.get('access_token')
    if not refresh:
        print('NO_REFRESH', list(data.keys()), file=sys.stderr)
        sys.exit(1)
    upsert_env({
        'EBAY_USER_REFRESH_TOKEN': refresh,
        'EBAY_USER_ACCESS_TOKEN': access or '',
        'EBAY_READ_ONLY': 'false',
        'EBAY_MCP_MEDIA_DIRS': '/workspace/fls/ebay-drafts:/workspace/fls/ebay-assets',
    })
    print('OK refresh_len', len(refresh), 'access_len', len(access or ''), 'expires_in', data.get('expires_in'))

if __name__ == '__main__':
    main()
