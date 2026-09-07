# Deploy Cube E2B shim behind cloudflared

This is the deployment shape that mirrors the runbook's tunnel setup. With the shim in front of
CubeAPI, the cloudflared tunnel records must change:

- **API surface**: `api.example.com` → `http://127.0.0.1:3100`.
- **Edge surface**: `*.example.com` → `http://127.0.0.1:3100`. The
  shim dispatches by Host header.
- **DNS**: point `api`, `sandbox`, and `*` at the Cloudflare tunnel. Keep more-specific hostnames
  ahead of the wildcard ingress rule.

The cloudflared configuration (`cloudflared tunnel ingress`) for the existing tunnel can be updated
either by the dashboard or via the API:

```
PUT https://api.cloudflare.com/client/v4/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations
{
  "config": {
    "ingress": [
      { "hostname": "api.example.com",       "service": "http://127.0.0.1:3100" },
      { "hostname": "sandbox.example.com",   "service": "http://127.0.0.1:3100" },
      { "hostname": "*.example.com",         "service": "http://127.0.0.1:3100" },
      { "service": "http_status:404" }
    ]
  }
}
```

Cloudflare issues the wildcard certificate through the tunnel.

Set `SHIM_DOMAIN=example.com` to match the public root domain.

## Why two surfaces on one port

The shim runs on a single Node HTTP listener. `Host` decides which surface serves:

- API: anything not ending in `${SHIM_DOMAIN}` → E2B control-plane API (`/sandboxes`,
  `/v2/sandboxes`, `/templates`, etc.). Auth: `X-API-Key` against `SHIM_API_KEYS`.
- Edge: `<port>-<id>.${SHIM_DOMAIN}` or `sandbox.${SHIM_DOMAIN}` → reverse-proxy to cube-proxy with
  Host rewritten to `${port}-${id}.cube.app`, envd (49983) gated by
  `envdAccessToken`/`X-Access-Token`.

## Setting up a new shim host

```sh
# 1. Install systemd unit + environment
sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin cube-shim
sudo cp contrib/cube-e2b-shim.service /etc/systemd/system/cube-e2b-shim.service
sudo install -m 0600 contrib/cube-e2b-shim.env.example /etc/cube-e2b-shim.env
sudoedit /etc/cube-e2b-shim.env          # fill SHIM_API_KEYS, CUBE_API_KEY, SHIM_DOMAIN
sudo systemctl daemon-reload
sudo systemctl enable --now cube-e2b-shim

# 2. Update cloudflared tunnel ingress (see snippet above), then:
sudo systemctl reload cloudflared
```

## Verifying

```sh
# API surface
curl https://api.example.com/health    # -> {"status":"ok"}

# Edge surface: create a sandbox, write to envd via the shim
E2B_API_KEY=... E2B_API_URL=https://api.example.com \
  python -c "from e2b_code_interpreter import Sandbox; print(Sandbox.create())"
```
