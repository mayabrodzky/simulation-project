# Parked: the pre-TypeScript backend

Nothing in this directory is built, deployed, linted or imported. It is kept
deliberately, as the specification for the API Phase 3 will rebuild.

## What is here

- **`app.py`** — Flask. The newer of the two and the one the `Procfile` names.
  Also served the HTML itself, which is why the pages' relative `/api/...`
  calls worked when running it locally.
- **`server.js`** — Express. Superseded by `app.py`, which is a near
  line-for-line port of it. Left here because it is the only record of the
  Node version of the same contract.
- **`requirements.txt`**, **`Procfile`** — deployment for the Flask version.

## Why keep it rather than delete it

These files are the only written definition of ten endpoints, four Supabase
table shapes, the JWT scheme and the password hashing the front end already
expects:

| Method | Path |
|---|---|
| POST | `/api/auth/register`, `/api/auth/login` |
| GET | `/api/auth/me` |
| POST | `/api/signups` |
| GET | `/api/admin/signups` |
| GET, POST | `/api/business` |
| GET, POST | `/api/sessions` |
| GET, DELETE | `/api/sessions/:id` |

Phase 3 reimplements that surface as TypeScript serverless functions on Vercel,
sharing types with the front end. Once that is deployed and working, this
directory is deleted in a single clearly labelled commit.

## Known problems, to fix rather than port

- `GET /api/admin/signups` has **no authentication** in either implementation
  and returns the entire waitlist.
- Both default `JWT_SECRET` to a literal string when the environment variable
  is missing, so a deploy that forgets to set it accepts tokens signed with a
  value published in this repository.
- Neither validates request bodies.

## Running one locally

Flask still works: `pip install -r legacy/requirements.txt` then
`python legacy/app.py`, and the Vite dev server proxies `/api` to it. The
Express version would need its dependencies reinstalled — they were removed
from `package.json` when that became the front-end manifest.
