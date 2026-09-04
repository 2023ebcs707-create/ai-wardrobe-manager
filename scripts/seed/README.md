# Seed data scripts

Phase 3 §9 lists "MongoDB database with schema definitions **and seed data scripts**" as a submitted deliverable. The schemas were always there; this is the seed half.

## Run it

```bash
pnpm dev:services                       # mongo, minio, ai
pnpm dev:api                            # API on :3000
node scripts/seed/seed-demo.mjs
```

`API_URL` overrides the target (default `http://localhost:3000`). `--reset` removes what the script owns before re-seeding.

## What it creates

Two users — **maya@demo.wardrobe** and **raj@demo.wardrobe**, password `demopass123` — with 12 garments between them, 3 outfits, 4 wear events with occasions and back-dated timestamps, one item each in the wash, 2 community posts, and cross-user likes and a save.

Two users rather than one is deliberate: the community feed's central claim is *"posts from all users"*, and a single-user seed cannot demonstrate it.

## Two properties worth knowing

**It seeds through the real HTTP endpoints, not by writing to Mongo.** A direct insert would produce documents no code path in this app has ever produced. Going through `POST /items` means every seeded garment was compressed, uploaded to object storage, auto-tagged by the Python service and signed exactly as a user's own item is — so the demo data exercises the pipeline it exists to demonstrate, and a failure here is a real failure rather than a fixture that happens not to match. It is slower for that reason.

**It is idempotent, and that is tested rather than asserted.** Users reconcile on email, items on position, outfits and posts on name and caption, wear events on `(outfit, calendar day)` — the last because wear history is an append-only log with no natural key, so a naive re-run stacks duplicates forever. Verified over three consecutive runs:

```
wear rows after run 1 / 2 / 3:  4 / 4 / 4
users 3 | items 12 | outfits 3 | wears 4 | posts 2 | likes 2 | saves 1
```

(The third user is the script's own index probe, below.)

## The index guard, and why it is there

The script refuses to seed unless `POST /auth/register` rejects a duplicate email with 409.

That check exists because this script's own second run created **two accounts sharing one email address**. The cause, measured both ways:

| procedure | `users` indexes | second register with the same email |
|---|---|---|
| fresh database, API started **afterwards** | `_id_`, **`email_1`** | **409**, one row |
| database dropped **while the API was running** | `_id_` only | **201**, two rows |

Mongoose builds a model's indexes once, when its connection opens. Dropping the database out from under a running server removes them and nothing rebuilds them — so `email: { unique: true }` silently stops being enforced and the `EMAIL_TAKEN` path becomes unreachable.

**This is not a defect in normal operation** — a server started against its database builds and enforces the index, as the first row shows. It is an operational hazard of the drop-while-connected sequence, and it is silent, which is what makes it worth a guard. If the guard fires: restart the API so Mongoose rebuilds its indexes, then run the script again.
