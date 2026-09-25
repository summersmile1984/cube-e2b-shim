# Cube E2B Shim

An E2B-compatible API and secure edge façade for a self-hosted
[CubeSandbox](https://cnb.cool/CubeSandbox/CubeSandbox) deployment.

CubeSandbox implements much of E2B's sandbox API, but its public envd gateway
is anonymous and a few lifecycle and query semantics differ from E2B. This
service sits in front of CubeAPI and cube-proxy so E2B SDK clients can use one
standard API shape without receiving the backend CubeAPI credential.

## What it adds to CubeSandbox

- The current E2B SDK routes (`POST /v2/sandboxes`,
  `POST /v2/sandboxes/{id}/connect`), which CubeAPI does not serve. v2
  sandboxes are always secured, as in E2B.
- A separate `X-API-Key` authentication boundary for the E2B API surface.
- Per-sandbox envd access tokens for v2 creates and v1 `secure: true`, checked by the public edge
  surface before envd traffic reaches cube-proxy.
- A public E2B domain (`api.example.com`, `sandbox.example.com`, and
  `<port>-<sandbox-id>.example.com`) translated to Cube's internal domain.
- E2B semantic alignment for lifecycle convenience fields, connect status,
  metadata filtering/pagination, metrics, template aliases, and metadata
  normalization.
- Safe create-time environment injection: values are held out of CubeAPI and
  sent to envd's private `/init` endpoint only after the VM is ready. This
  avoids CubeAPI's variable-name and size restrictions.
- An E2B-style `fork` endpoint built from Cube full-memory snapshots.

It does **not** implement E2B organization APIs (teams, users, API-key
management, secrets, or admin). Filesystem-only pause (`memory: false`) fails
closed because Cube cannot safely restore it yet. Template v3 build-step APIs
are also intentionally partial.

## Requirements

- Node.js 22.5 or newer (the state store uses `node:sqlite`).
- A reachable CubeAPI endpoint and private cube-proxy endpoint.
- Persistent disk for the SQLite state database in production.
- A reverse proxy or Cloudflare Tunnel that routes `api`, `sandbox`, and
  wildcard sandbox hostnames to this service.

## Run locally

```sh
npm ci
npm run build

export SHIM_API_KEYS="replace-with-a-long-random-key"
export CUBE_API_URL="http://127.0.0.1:3000"
export CUBE_API_KEY="your-private-cube-api-key"
export CUBE_PROXY_URL="http://192.168.9.100"
export CUBE_DOMAIN="cube.app"
export SHIM_DOMAIN="example.com"
export SHIM_DB_PATH="$PWD/cube-e2b-shim.sqlite"
npm start
```

Keep `CUBE_API_KEY`, `SHIM_API_KEYS`, and the private cube-proxy endpoint out
of source control and out of public ingress. `SHIM_DOMAIN` must be the public
root domain used in sandbox responses, for example `example.com`.

## Use from E2B SDK clients

With the standard E2B host layout, clients need only the API key and domain:

```sh
export E2B_API_KEY="the-value-from-SHIM_API_KEYS"
export E2B_DOMAIN="example.com"
```

The E2B SDK derives `https://api.example.com` and
`https://sandbox.example.com`. Clients that require explicit endpoints can use:

```sh
export E2B_API_URL="https://api.example.com"
export E2B_SANDBOX_URL="https://sandbox.example.com"
```

The shim accepts normal E2B fields such as `envVars`, `secure`, lifecycle,
network, and volume options. API calls use `X-API-Key`; authenticated envd
traffic uses the returned `envdAccessToken` as `X-Access-Token` (or the
equivalent signed URL parameters supplied by E2B clients).

## Server deployment

The included systemd unit assumes the repository is installed at
`/opt/cube-e2b-shim` and uses a dedicated `cube-shim` service account.

```sh
sudo git clone https://github.com/YOUR_GITHUB_USER/cube-e2b-shim.git /opt/cube-e2b-shim
cd /opt/cube-e2b-shim
sudo npm ci
sudo npm run build
sudo npm prune --omit=dev

sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin cube-shim
sudo cp contrib/cube-e2b-shim.service /etc/systemd/system/cube-e2b-shim.service
sudo install -m 0600 contrib/cube-e2b-shim.env.example /etc/cube-e2b-shim.env
sudoedit /etc/cube-e2b-shim.env
sudo systemctl daemon-reload
sudo systemctl enable --now cube-e2b-shim
```

Use `sudo systemctl status cube-e2b-shim` and
`sudo journalctl -u cube-e2b-shim -f` to inspect it. For Cloudflare Tunnel
ingress and wildcard DNS, see [the cloudflared deployment guide](contrib/cloudflared-deployment.md).

## Verify

```sh
npm test
npm run typecheck
npm run build

# Requires a ready Cube template; it always deletes the created sandbox.
E2B_API_URL=https://api.example.com \
E2B_API_KEY=your-shim-api-key \
E2B_TEMPLATE_ID=your-ready-template-id \
E2B_EXPECTED_DOMAIN=example.com \
npm run test:e2e
```

## API surfaces

- **API surface**: `api.<domain>` serves E2B-compatible control-plane routes.
  It requires `X-API-Key` from `SHIM_API_KEYS`.
- **Edge surface**: `sandbox.<domain>` and
  `<port>-<sandbox-id>.<domain>` proxy sandbox traffic. envd (port `49983`)
  is token-protected; non-envd ports continue through Cube's normal proxy
  behavior. WebSocket upgrades are supported.

`SHIM_DB_PATH` is required and must be durable in production. It stores
issued envd tokens and the lifecycle state needed to preserve E2B-compatible
connect responses across service restarts; losing it makes envd reject every
existing sandbox. `:memory:` is accepted only when set explicitly, for
throwaway development.

## License

[MIT](LICENSE). This standalone extraction preserves the original
Open-Inspect contributor copyright notice.
