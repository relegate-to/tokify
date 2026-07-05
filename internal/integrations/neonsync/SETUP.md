# Neon sync setup

Sets up the Postgres side of Toki's end-to-end-encrypted activity sync. The
server holds only ciphertext: `schema.sql` defines two tables of opaque base64
blobs and Row-Level Security that scopes every row to the user who wrote it.
Neon never sees plaintext activities or their timestamps.

## Prerequisites

- A Neon project.
- **Neon Auth** enabled on the project. This issues the JWTs the desktop app
  signs into, and is the source of the `sub` claim used to scope rows.
- The **Data API** enabled on the project. This is the PostgREST-over-HTTP
  layer that exposes the `public` schema and provides the `authenticated` role
  and the `auth.user_id()` helper (which returns the caller's JWT `sub`).

## Apply the schema

Run `schema.sql` once against the project's database, either way:

- **Neon SQL Editor**: open the project, paste the contents of `schema.sql`,
  run it.
- **psql**: `psql "$NEON_CONNECTION_STRING" -f schema.sql` using an owner/admin
  connection string from the Neon console.

The script is idempotent, so re-running it to pick up changes is safe.

## Find the Data API base URL

In the Neon console, open the project and go to the Data API section. Copy the
Data API base URL (the PostgREST endpoint for the project). The app reads it
from settings, or from the `TOKI_NEON_DATA_URL` environment variable.

## How auth wiring fits together

- `auth.user_id()` and the `authenticated` role are provided by Neon's Data
  API / RLS integration; you do not create them.
- The JWT is issued by Neon Auth — the same account the desktop app signs into.
  The Data API validates it and exposes its `sub` claim through
  `auth.user_id()`, which the RLS policies compare against each row's
  `user_id`.

## Verify RLS

Sign in as two different users and grab each JWT. With user A's rows present,
call the Data API as user B:

```sh
curl -s "$TOKI_NEON_DATA_URL/entries" \
  -H "Authorization: Bearer $USER_B_JWT"
```

The response must contain none of user A's rows (expect `[]` if user B has
written nothing). The same must hold for `user_keys`. If a caller ever sees
another user's rows, RLS is not in effect — recheck that the Data API is
enabled and that `schema.sql` applied cleanly.
