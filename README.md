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
- Per-sandbox envd access tokens for v2 creates and v1 `secure: true`. The
  shim writes each token into envd through its private `/init` call, so envd
  itself enforces `X-Access-Token` and signed file URLs exactly as in E2B,
  even for callers that reach cube-proxy directly; the public edge checks the
  same token first. envd cannot change a token once set, so forks and
  sandboxes created from a snapshot taken through the shim reuse the source
  sandbox's token.
- A public E2B domain (`api.example.com`, `sandbox.example.com`, and
  `<port>-<sandbox-id>.example.com`) translated to Cube's internal domain.
- E2B semantic alignment for lifecycle convenience fields, connect status,
  metadata filtering/pagination, metrics, template aliases, and metadata
  normalization.
- Safe create-time environment injection: values are held out of CubeAPI and
  sent to envd's private `/init` endpoint only after the VM is ready. This
  avoids CubeAPI's variable-name and size restrictions.
- An E2B-style `fork` endpoint built from Cube full-memory snapshots.

- E2B template builds (`Template.build()` / v3 build API) executed on Cube:
  RUN, COPY, ENV, WORKDIR and USER steps, start and ready commands, from a
  base template or an image. See [Template builds](#template-builds).

- The rest of E2B's control plane for a single team: API keys, secrets,
  sandbox lifecycle events and webhooks, team metrics, the template catalog
  and tags, volume file access and the admin APIs. See
  [E2B API coverage](#e2b-api-coverage).

Filesystem-only pause and resume (`memory: false`) fail closed because Cube
cannot do them yet.

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

For a complete step-by-step guide to deploying in front of CubeSandbox (in
Chinese), including prerequisites, configuration, ingress, the `base`
template, verification and operations, see
[docs/deploy-cube.md](docs/deploy-cube.md).

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

## Template builds

CubeSandbox can only build a template from an OCI image, while E2B's
`Template.build()` sends a base plus build steps. The shim runs those steps
the way E2B's own builder does:

1. The base is resolved. `fromTemplate` accepts a template built through the
   shim (its user, workdir and env are inherited) or any Cube template ID or
   alias. `fromImage` becomes a Cube from-image template, cached per image.
2. A private build sandbox starts from it. It is hidden from sandbox lists.
3. Every step replays through envd with E2B's semantics. RUN and ENV run as
   the current build user (root by default). COPY archives are uploaded by
   the SDK to a presigned shim URL and follow Docker COPY rules. USER creates
   the account.
4. The final env, user and workdir are written into envd. `startCmd` is
   started and `readyCmd` is polled.
5. A Cube full-memory snapshot becomes the template, including the running
   start command. The E2B name (for example `my-app`) then works in
   `Sandbox.create()`, `Template.exists()`, `GET /templates/{name}` and
   `DELETE /templates/{name}`.

Notes:

- Frameworks that call `Template().fromTemplate("base")`, such as Mastra's
  default sandbox template, need a Cube template with the alias `base`, for
  example an Ubuntu image with bash, sudo and a `user` account.
- `cpuCount` and `memoryMB` apply to `fromImage` builds. A `fromTemplate`
  build inherits its base's resources.
- `fromImageRegistry` supports the generic `registry` type (username and
  password). AWS and GCP registries are rejected.
- Uploaded COPY archives live in `SHIM_BUILD_FILES_DIR`, which defaults to
  `template-files/` next to the database. `SHIM_TEMPLATE_DISK_SIZE` sets the
  writable layer of from-image templates (default `4G`).
- Upload URLs point at the origin the SDK called, using `X-Forwarded-Proto`
  when a proxy sets it. Set `SHIM_PUBLIC_API_URL` when that origin is not
  reachable by clients.
- Builds run inside the shim process. A restart marks unfinished builds as
  failed.

## End-to-end check with Mastra

`e2e/mastra` checks a deployed shim end to end, through the official E2B SDK
and through Mastra's `E2BSandbox` (`@mastra/e2b`), the way a Mastra app would
use it. It covers:

- v2 create and connect
- create-time env vars and command execution
- file reads and writes
- signed URLs and envd token enforcement
- metadata listing, pause/connect and metrics
- `Template.build()`
- the Mastra lifecycle

Everything it creates is deleted at the end.

```sh
cd e2e/mastra
npm install
E2B_API_KEY=your-shim-api-key \
E2B_DOMAIN=example.com \
E2E_TEMPLATE=your-cube-template-id-or-alias \
E2E_BUILD_BASE=base \
npm run e2e          # set E2E_SKIP_BUILD=1 to skip the Template.build check
```

Signed file URLs (`downloadUrl`/`uploadUrl`) do not contain the sandbox ID.
As on E2B, they are served from the per-sandbox hostname
`49983-<id>.<domain>`, so they need wildcard DNS for `SHIM_DOMAIN`, even when
SDK traffic uses a single `E2B_SANDBOX_URL` gateway.

## E2B API coverage

The shim implements every operation in E2B's current public OpenAPI specs:
74 control-plane operations in `spec/openapi.yml` and 7 volume-content
operations in `spec/openapi-volumecontent.yml` (checked against E2B SDK
2.51.0). `src/spec-coverage.test.ts` checks that each one is routed and
accepts the auth scheme E2B declares for it.

E2B is multi-tenant; a CubeSandbox deployment behind this shim is one team.

| Area | How it maps onto CubeSandbox |
|---|---|
| Sandboxes (v1 and v2 create/connect, lifecycle, fork, network, logs, metrics, snapshots) | CubeAPI, plus the shim alignments described above |
| Templates: builds, catalog, tags, logs | Steps run in build sandboxes and are saved as Cube memory snapshots; Cube-native templates appear in E2B's shapes; `public`, tags and spawn stats are stored by the shim |
| Volumes and volume content | CubeAPI volumes; file access goes through a per-volume helper sandbox |
| Auth, teams, API keys | `X-API-Key` (SHIM_API_KEYS or managed `e2b_` keys), Bearer access tokens (SHIM_ACCESS_TOKENS), admin token (SHIM_ADMIN_TOKEN) |
| Secrets | Stored encrypted. `${e2b.secrets.<name>}` placeholders in network rule headers are resolved when the config is forwarded to Cube's egress; callers only ever see the placeholders |
| Sandbox events, webhooks, team metrics | Events come from the shim's own calls and from polling Cube for changes the shim didn't make. Webhooks carry `e2b-signature` and are retried |
| Admin: sandboxes, builds, API keys | Kill team sandboxes, running counts, cancel builds, managed keys |
| Admin: nodes | CubeOps (`CUBE_OPS_URL`, `CUBE_OPS_TOKEN`). Isolation maps to `draining`/`standby`, un-isolation to `ready` |
| Admin: rigs | E2B's documented `501`: Cube has no cloud scaling groups |

Behaviour that differs from E2B:

- **Webhook payload.** The body is E2B's snake_case sandbox event. The
  signature is base64 SHA-256 of secret + body with the padding stripped.
- **Events for things Cube does on its own.** TTL kills and auto-pause are
  picked up by polling every `SHIM_EVENT_POLL_SECONDS` (default 15), so they
  can arrive late by up to that interval. On the first run the shim adopts
  the sandboxes that already exist without emitting events for them.
- **Team metrics.** They are sampled on the same schedule, and events,
  deliveries and metrics are kept for `SHIM_EVENT_RETENTION_DAYS`
  (default 7).
- **Volume content.** The helper sandbox uses `SHIM_VOLUME_HELPER_TEMPLATE`
  (default `base`), which needs bash and GNU findutils. The Cube volume must
  allow a second mount while other sandboxes use it.
- **Node fields Cube has no equivalent for** (create counters, hugepages,
  machine info) are reported as zero or empty.

## API surfaces

- **API surface**: `api.<domain>` serves E2B-compatible control-plane routes,
  authenticated as described in [E2B API coverage](#e2b-api-coverage).
  `/volumecontent/*` accepts only the per-volume token.
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
