# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Origin server for a CloudFront distribution that hosts images. Deployed to a k3s
cluster by Flux, from manifests rendered in CI — never by `kubectl apply`.

**This repository is public.** Comments, docs and commit messages must describe
this service and nothing else: no infrastructure topology, no other workloads,
no capacity figures, no hostnames.

## Commands

```sh
npm start                                    # reads .env
npm test                                     # examples/uploader.js — a real round trip
npm audit                                    # must stay at 0

kubectl kustomize kustomize/overlays/prod    # the only local check that exists
```

There is **no test suite, no linter and no formatter.** `npm test` is a
single script that uploads every file in `images/`, updates it, reads it back
and deletes it; it needs a running server and database. Rendering the overlay
and reading the diff is the whole of the local safety net for manifests. Say
plainly when something is unverified.

`.env` needs `DIR` and the `PG*` variables — see `.env.example`. `pg` reads
`PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` from the environment itself; the
`Pool` is constructed with no connection options on purpose.

## Architecture

**Two tiers, and the split is the design.** `nginx-static` is the public front
door and the application is behind it:

- **nginx** serves `/images/` straight off disk and reverse-proxies `/source/`
  to the application. It owns the origin gate.
- **the application** (`index.js`) owns `/source/:filename` (a database lookup
  that redirects to the original source, or to the CDN copy when there is none)
  and the four `/api/*` write routes.

`/source/` is routed *through* nginx rather than straight to the application so
that one config owns the gate for every publicly reachable path.

**Routing is split across two ingress entrypoints, and the split is the
authorization model:**

| Path | Entrypoint | Gate |
|---|---|---|
| `/data`, `/data/` | public | origin header, in nginx |
| `/data/images/`, `/data/source/` | public | origin header, in nginx |
| `/.well-known/discord`, `/healthz` | public | none, deliberately |
| `/api/upload,sources,update,delete` | LAN-only | the entrypoint's source-address allow-list |

**The `/api/*` routes have no application-level authentication.** That is not an
oversight — they are published only on the LAN-restricted entrypoint, and the
allow-list stands in for the Bearer secret that used to be there. Anything that
publishes them publicly must add authentication back first.

**Paths are `Exact`, never `Prefix`, under `/api`.** The hostname is shared with
other routers, so a prefix rule would shadow paths this repo does not own.
`/data/images/` and `/data/source/` are `Prefix` because they are whole
namespaces this repo owns outright.

**`/.well-known/discord` is the one path that cannot move under `/data`.**
Domain verification fetches it on the bare domain, never through the CDN, so no
origin path is applied to it. It is `Exact`, so it shadows nothing.

### The origin gate

nginx compares the `from-cloudfront` header against a value injected from a
Secret and returns `444` on a mismatch. This is what stops traffic reaching the
origin directly and bypassing the CDN cache.

The header **name** is in `nginx.conf`; the **value** is not, because this repo
is public. It arrives through the nginx image's own
`docker-entrypoint.d/20-envsubst-on-templates.sh`, which renders
`/etc/nginx/templates/nginx.conf.template` over `/etc/nginx/nginx.conf` before
nginx starts.

`NGINX_ENVSUBST_FILTER=^CDN_` is **load-bearing**. Without it envsubst replaces
every `$variable` in the file — `$remote_addr`, `$host`, all of them — with the
empty string, and the config becomes nonsense.

The gate is applied **per-location, not at server level**. A server-level `if`
runs in the rewrite phase for every request and would also swallow `/healthz`
(the kubelet sends no CDN header, so every pod would fail its probe) and
`/.well-known/discord` (fetched directly, never through the CDN).

### Storage

A single host directory holds every image, mounted read-write into the
application at `/data/images` and read-only into nginx at `/srv/data/images`.
`DIR` in the ConfigMap **must** match the application's mount path.

The paths differ on purpose. nginx serves the public prefix with `root /srv`,
so the URL `/data/images/x.jpg` resolves to `/srv/data/images/x.jpg`. Mounting
it at `/data/images` instead would force either `root /` — serving from the
filesystem root — or `alias`, which must not be combined with `if` (see Traps).

The volume is `type: Directory`, so a pod refuses to start rather than quietly
serving an empty directory and accepting uploads into it.

`runAsUser`/`runAsGroup` are set to match ownership of the files already on that
directory. Changing them means chowning several thousand files.

### Database

One small table, `images`, mapping filename to source URL. **No migration
tooling and no schema initContainer** — see `kustomize/SECRETS.md` for the
manual step when rebuilding against an empty database.

The password exists in exactly one place: both the postgres container and the
application read `postgres-secret` directly. The application maps it onto
`PGUSER`/`PGPASSWORD` via `secretKeyRef` rather than composing a connection URL,
which is what keeps it to one copy. Do not introduce a `DATABASE_URL`.

## Traps

- **`matchExpressions`, not `matchLabels`, in the postgres anti-affinity.**
  Kustomize's label transformer runs with `includeSelectors` and rewrites every
  `matchLabels` it recognises, including inside `podAntiAffinity`. Written as
  `matchLabels` it renders as postgres anti-affine to *itself* — at one replica
  a silent no-op that places no constraint at all. `matchExpressions` is not in
  the transformer's fieldSpecs. Verified by rendering, which is the only way to
  see it.
- **The build is `linux/arm64` only.** The Dockerfile pins the arm64 *manifest*
  digest, not the multi-arch index digest, so a build on any other architecture
  fails outright instead of producing an image the cluster cannot run. This
  means `docker build` does not work on an x86 machine, by design.
- **nginx's upstream is a literal, so it resolves once at startup** and nginx
  refuses to start if the Service does not exist yet. That is the failure to
  recognise if nginx crash-loops on a first deploy into a fresh namespace.
- **`discord.txt` holds a live token, in plaintext, on purpose.** It is served
  publicly at a well-known URL by design, so sealing it would protect nothing
  and cost a `kubeseal` round-trip per change. Do not "fix" this into a Secret.
- **Never put `alias` in a location that also has an `if`.** nginx's own
  *IfIsEvil* page lists it as broken: the `if` becomes an implicit nested
  location and `alias` does not resolve inside it. The image locations use
  `root` for exactly this reason. `if { return ... }` alongside `root` or
  `proxy_pass` is fine — the broken form is a content handler *inside* the `if`
  body.
- **Changing a Secret does not restart pods.** `envFrom` and `secretKeyRef` are
  read once at pod start, and unlike the generated ConfigMaps there is no
  content hash in the name to force a roll. `rollout restart` by hand.
- **The ConfigMaps are generated, not static.** That hash suffix is what makes
  an `nginx.conf` edit actually take effect. A hand-written `configmap.yaml`
  would leave pods on the old config indefinitely.
- **The unmatched-route handler returns HTTP 200**, not 404, and serves
  `404.html`. Long-standing behaviour; a probe against any nonexistent path will
  look healthy.
- **`.dockerignore` feeds the image tag.** CI hashes the git blob IDs of
  everything entering the build context to decide whether to rebuild, so adding
  a path there changes the tag. Keep `kustomize/`, `docs/` and `CLAUDE.md` out
  of the context — none of them belong in the image.
- **There is no `/` or `/favicon.ico` handler and there must not be.** Those
  paths are not routed to this service.
- **`/api/metrics` does not exist** but is called by at least one consumer,
  which silently receives the 404 page. Pre-existing.

## Deployment

CI builds the image, renders `kustomize/overlays/prod` with it pinned, and
pushes the result as an OCI artifact; the cluster pulls and applies it. A merge
to `main` is the deploy. The `image:` field in the manifests is a bare name with
no tag — the tag is written at publish time, so editing it by hand accomplishes
nothing.

`docs/` is gitignored and local-only.
