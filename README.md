# image-server

Origin server for [AWS CloudFront](https://d1irvsiobt1r8d.cloudfront.net/), used
to host images because imgur isn't enough for me. Used by my
[Discord bot](https://github.com/KrammyGod/pingbot).

Runs on a k3s cluster as two containers behind one ingress: nginx serves the
stored images and fronts the origin, and a small Express app owns the source
lookup and the write API. Deploys are pull-based — CI renders the manifests and
publishes them, and the cluster applies them itself.

## Layout

```
index.js                 the app: /source/:filename and the /api/* routes
hasher.js                filename generation
sql/schema.sql           the one table
kustomize/               base + prod overlay
  SECRETS.md             re-sealing runbook
examples/uploader.js     end-to-end round trip against a running server
```

## Running it locally

```sh
cp .env.example .env     # fill in DIR and the PG* variables
npm install
npm start
```

`npm test` uploads every file in `images/`, updates it, reads it back and
deletes it. It needs the server and a database running, and it will reupload
everything in that directory — do not point it at anything real.

The container image is built for `linux/arm64` only, so `docker build` will not
work on an x86 machine. That is deliberate.

## API

All four write routes are reachable only from the local network; there is no
application-level authentication on them.

| Method | Route | Body |
|---|---|---|
| `POST` | `/api/upload` | `multipart/form-data` — `images` (one or more), `sources` |
| `POST` | `/api/sources` | `{ filenames: string[] }` |
| `PUT` | `/api/update` | `{ filenames: string[], sources?: string[] }` |
| `DELETE` | `/api/delete` | `{ filenames: string[] }` |

`GET /source/<filename>` is public and redirects to the image's recorded source
URL, or to the CDN copy when no source is recorded.
