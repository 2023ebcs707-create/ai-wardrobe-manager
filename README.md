# AI Wardrobe Manager

A pnpm workspace containing an Express API, a Python (FastAPI) AI service, and an Expo (React Native) mobile app, sharing types through `packages/shared`. Auto-tags garments with a zero-shot CLIP classifier, extracts dominant colours with k-means, and composes outfit suggestions from declared colour, category and season rules.

## Prerequisites

- **Node 26.7.0** and **pnpm 11.22.0** on the host.
- **Docker** (with Docker Compose v2 or later, i.e. `docker compose`, not `docker-compose`) — runs MongoDB, MinIO, and the Python AI service. The AI service's Python 3.11 runtime and dependencies live entirely inside its Docker image; never install Python dependencies on the host. As of Stage 3 those dependencies include CPU PyTorch, `open_clip_torch`, Pillow, NumPy, and scikit-learn on top of FastAPI/Uvicorn/pytest (see `services/ai/requirements.txt`). **The CLIP weights (`ViT-B-32-quickgelu` / `openai`) are downloaded at image-build time**, not at run time — the first `docker compose build ai` needs network and takes a while, after which the image is roughly 1.9 GB and the suite runs entirely offline. Peak resident memory during inference is around 1.6 GB, on a Podman VM with 3.8 GB shared with MongoDB and MinIO.
- Either Docker Desktop or **Podman** provides that daemon. This project is developed against Podman (`podman machine start`, which publishes the API on `/var/run/docker.sock`, so the `docker` CLI and the `default` context work unchanged and `DOCKER_HOST` does not need setting). A stopped machine surfaces as `Cannot connect to the Docker daemon at unix:///var/run/docker.sock` from `pnpm dev:services` — start the machine, not the daemon.
- An Android phone with **Expo Go** installed, for device verification. No emulator is used — this project verifies on a physical device only.
- `adb`, from the Android SDK platform-tools. On macOS this is typically at `~/Library/Android/sdk/platform-tools/adb` and is not on `PATH`.

## Install

```bash
pnpm install
```

This installs all workspace packages (`apps/api`, `apps/mobile`, `packages/shared`) in one pass.

## Environment

Copy `.env.example` to `.env` and set `JWT_SECRET` before starting the API — every other variable has a built-in default that matches the Docker Compose services, but `JWT_SECRET` is required and the API will refuse to start without it:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `MONGO_URL` | `mongodb://localhost:27017/wardrobe` | MongoDB connection string |
| `MINIO_ENDPOINT` | `localhost` | MinIO host |
| `MINIO_PORT` | `9000` | MinIO port |
| `MINIO_ACCESS_KEY` | `wardrobe` | MinIO access key |
| `MINIO_SECRET_KEY` | `wardrobe123` | MinIO secret key |
| `MINIO_BUCKET` | `wardrobe-items` | MinIO bucket for uploaded images |
| `AI_SERVICE_URL` | `http://localhost:8000` | Base URL the API uses to reach the AI service |
| `PORT` | `3000` | Port the Express API listens on |
| `JWT_SECRET` | *(none — required)* | Secret used to sign auth tokens; the API throws on startup if this is missing or blank |
| `JWT_EXPIRES_IN` | `7d` | Auth token lifetime |

## Auth endpoints

All three live on the Express API (`apps/api/src/routes/auth.ts`), mounted at `/auth`. Request/response shapes are the shared `RegisterRequest`, `LoginRequest`, `AuthResponse`, and `MeResponse` types in `packages/shared/src/auth.ts`. Errors use the shared error envelope (see `packages/shared/src/errors.ts`).

| Endpoint | Auth required | Request body | Success response | Notable error codes |
| --- | --- | --- | --- | --- |
| `POST /auth/register` | No | `{ name, email, password }` | `201` `{ token, user }` | `409 EMAIL_TAKEN` if the email is already registered (enforced by a unique index on `User.email`) |
| `POST /auth/login` | No | `{ email, password }` | `200` `{ token, user }` | `401 INVALID_CREDENTIALS` for a wrong password or unknown email — both cases return the byte-identical body/timing on purpose, to avoid leaking which emails are registered |
| `GET /auth/me` | Yes — `Authorization: Bearer <token>` | — | `200` `{ user }` | `401 UNAUTHORIZED` for a missing/malformed header, an invalid/expired token, or a token whose user was deleted |

`token` is a JWT signed with `JWT_SECRET` (see Environment above), valid for `JWT_EXPIRES_IN` (default `7d`). The mobile app stores it in `expo-secure-store` (`apps/mobile/src/auth/tokenStore.ts`) and attaches it to authenticated requests; `AuthProvider` (`apps/mobile/src/auth/AuthContext.tsx`) restores a session from the stored token on cold launch and clears it on sign-out or a `401` from the server.

## Running the stack

Everything below assumes commands are run from the repo root unless noted.

### 1. Start backing services (MongoDB, MinIO, AI service)

```bash
pnpm dev:services
```

This runs `docker compose up -d` followed by `scripts/wait-for-services.sh`, which blocks until MongoDB, MinIO, and the MinIO bucket are all confirmed ready.

### 2. Start the API

In its own terminal (this process does not exit):

```bash
pnpm dev:api
```

Runs `apps/api` via `ts-node` on `PORT` (default 3000). Verify with:

```bash
curl -s localhost:3000/health
```

Expect `{"api":"ok","database":"ok","storage":"ok","ai":"ok"}`. Note the endpoint returns HTTP 503 (with the same JSON shape, just one or more fields `"down"`) if any dependency is unreachable — check the JSON body, not just the status code.

### 3. Start the mobile app

In its own terminal (this process does not exit):

```bash
pnpm dev:mobile
```

Runs `expo start` for `apps/mobile`, serving Metro on port 8081.

> **Never run `pnpm dev:api`, `pnpm dev:mobile`, or any `expo start` in a context that expects the command to return.** Both are long-running dev servers. If you need to script around them (CI, an agent, a one-off check), background the process and redirect output to a log file, then poll the log or the port instead of waiting on the command to exit, e.g.:
> ```bash
> (cd apps/api && pnpm dev > /tmp/api.log 2>&1 &)
> (cd apps/mobile && pnpm start > /tmp/metro.log 2>&1 &)
> ```

## Connecting a physical Android device

This project verifies exclusively on a physical Android device via Expo Go — no emulator.

1. Install **Expo Go** from the Play Store. Every native module this project needs through Stage 9 (`expo-camera`, `expo-image-picker`, `expo-image-manipulator`, `expo-secure-store`) ships inside Expo Go, so no custom development build is required until the APK build in Stage 10.
   - Expo Go's Play Store listing can lag behind the SDK version this project uses. If you see "Project is incompatible with this version of Expo Go" / "Incompatible SDK version" after updating to the latest Play Store release, download the matching version directly from Expo's official releases at `https://github.com/expo/expo-go-releases/releases` (look up the right version for your SDK via `https://api.expo.dev/v2/versions/latest`, field `sdkVersions.<your-sdk>.androidClientUrl`) and install it with `adb install -r <apk>`. This is Expo's own documented distribution channel for exactly this situation, not a third-party source.
2. On the phone: **Settings > About phone**, tap "Build number" seven times to unlock Developer options.
3. **Settings > System > Developer options**, enable either:
   - **USB debugging**, then connect the phone to your computer with a cable, or
   - **Wireless debugging**, then pair with `adb pair <host:port>` (the phone shows the pairing code and port) followed by `adb connect <host:port>`.
4. Accept the "Allow debugging" prompt that appears on the phone.
5. From the repo root, run:
   ```bash
   pnpm device
   ```
   This runs `scripts/device-setup.sh`, which locates `adb`, confirms an authorised device (deduplicating by hardware serial, since wireless debugging can register the same phone as two transports), and forwards ports 3000 (API) and 8081 (Metro) from the phone to your machine with `adb reverse`.
6. With `pnpm dev:services`, `pnpm dev:api`, and `pnpm dev:mobile` all running, open **Expo Go** on the phone and load `exp://localhost:8081`.

Port forwarding is cleared whenever the connection drops (cable unplugged, Wi-Fi change, wireless-debugging session ended) or the phone reboots — re-run `pnpm device` after any of those. If the app shows "Cannot reach API," check the forward before suspecting the code.

## Running the test suites

| Command | What it runs |
| --- | --- |
| `pnpm test` | All workspace unit tests (`packages/shared`, `apps/api`, `apps/mobile`), sequentially |
| `pnpm test:integration` | The API's integration tests against live Docker Compose services (`pnpm dev:services` must be running first) |
| `pnpm test:ai` | The Python AI service's pytest suite, run inside its Docker image, rebuilding first so the suite never runs against a stale image (`docker compose run --rm --build ai pytest`). **The `--build` matters**: the image bakes the service's source in with `COPY . .`, so a plain `docker compose run ai pytest` tests whatever was in the image, not what is on disk |
| `pnpm typecheck` | `tsc --noEmit` across every TypeScript workspace package |

Run an individual package's tests with pnpm's filter flag, e.g. `pnpm -F @wardrobe/api test`.

To prove the AI suite is genuinely hermetic — that the CLIP weights are baked into the image rather than fetched at test time — run it with no network:

```bash
pnpm test:ai                                                    # rebuild, so the image is current
docker run --rm --network none ai-wardrobe-manager-ai:latest pytest
```

Note that this is `docker run`, not `docker compose run`: **`docker compose run` has no `--network` flag** (verified on Compose v5.1.1 — `unknown flag: --network`), so the isolation has to be applied to a plain `docker run` against the image Compose just built.

## Repository layout

```
apps/
  api/            Express API (TypeScript, ts-node in dev)
  mobile/         Expo Router app (five tabs: Wardrobe, Community, Add, Outfits, Calendar)
                  Profile is a pushed route, reached from the wardrobe header avatar
                  src/theme/  the "Soft" design system — tokens, type scale, components
packages/
  shared/         Types shared between the API and the mobile app
services/
  ai/             FastAPI AI service (Python, Docker-only)
scripts/
  device-setup.sh       Locates adb, forwards ports 3000/8081/9000 to a connected phone
  wait-for-services.sh  Blocks until MongoDB, MinIO, and the MinIO bucket are ready
  seed/                 Idempotent demo data, seeded through the real HTTP endpoints
  perf/                 Measurement harness — no product code references it
```

## Constraints worth knowing

- **Jest is pinned to 29.x across the whole workspace** (`packages/shared`, `apps/api`, and `apps/mobile`), because `apps/mobile` depends on `jest-expo`, which requires Jest 29's internals. pnpm hoists a single shared copy of packages like `jest-environment-node` and `jest-mock`; mixing Jest major versions across workspace packages causes the hoisted copy to win the race for everyone, producing runtime/environment mismatches. Each workspace package's own `jest`/`@types/jest` version is pinned to `^29.x`, but that alone is not sufficient: `ts-jest` and `@testing-library/react-native` both declare optional peers that accept `^29.0.0 || ^30.0.0`, and pnpm was resolving those unpinned peers (`jest-util`, `babel-jest`, `jest-diff`, `jest-matcher-utils`, etc.) to the 30.x line under the hood, even though every package.json said 29. That straddle is closed with a `pnpm-workspace.yaml` `overrides` block that forces the entire `jest-*` / `@jest/*` / `babel-jest` family to the 29 line workspace-wide, so the hoisted fallback copy can't drift to 30.x again. Keep all workspace `jest` and `@types/jest` versions aligned, and keep the overrides block in sync, unless you deliberately re-architect this.
- **The AI service only runs in Docker.** The host's Python is a different (newer) version that doesn't have reliable ML wheels; never add a host-level Python dependency for this service.
- **Tests are hermetic.** No test may reach the public network. For the AI service this is enforceable and enforced: `docker run --rm --network none ai-wardrobe-manager-ai:latest pytest` passes 87/87 (Stage 3 Task 6).
- **Never colocate a test file inside `apps/mobile/app/`.** Expo Router's Android require-context (`_ctx.android.js`) scans every `.tsx`/`.ts`/`.jsx`/`.js` file under the app root as a candidate route — it only excludes `+api`/`+html`/`+middleware` files, not `.test.` files. A test colocated next to the route it tests (e.g. `app/(tabs)/add.test.tsx`) gets bundled as if it were a screen, dragging its whole import chain — including `@testing-library/react-native`, which imports Node's `console` — into the production Android build and breaking it outright with "Android Bundling failed." This is invisible to Jest (which never goes through Metro's router scanning) and to `tsc` (a bundling failure, not a type error); only a real device/Expo Go load surfaces it. Found in Stage 2 Task 8 — put route-level tests in `apps/mobile/__tests__/` instead, importing the route file with a relative path (e.g. `../app/(tabs)/add`). A `__tests__/` subdirectory *inside* `app/` is not a way around this: the require-context is recursive and knows nothing about `__tests__`, so `app/items/__tests__/[id].test.tsx` is bundled exactly as a colocated file would be, and `@expo/cli`'s `TYPED_ROUTES_EXCLUSION_REGEX` (`/(_layout|[^/]*?\+[^/]*?)\.[tj]sx?$/`) does not exclude it either. Re-verified against expo-router 57.0.15 in Stage 4 Task 5; that task's test lives at `apps/mobile/__tests__/items/[id].test.tsx`.
- **Expo SDK 57 replaces the global `fetch`/`FormData` with its own implementation, and it does not accept React Native's classic file-part shape.** `expo/src/winter/fetch/convertFormData.ts` only accepts a genuine `Blob` or an object exposing `.bytes()` for a FormData file part — the long-standing RN idiom `form.append('field', { uri, name, type })` throws `Error: Unsupported FormDataPart implementation` on a real device. Every Jest test stays green regardless, because the installed test-environment `FormData` (`react-native/Libraries/Network/FormData`, see the mobile app's `jest.setup.js`) still accepts that shape — the divergence is real-runtime-only. The equally-tempting fix, building a `Blob` yourself (including via `expo-file-system`'s `File#slice()`), also fails on-device with `Error: Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported` — React Native's `Blob` on Android cannot be constructed from raw binary data in JS at all. The working pattern (see `apps/mobile/src/items/uploadItem.ts`) is to construct an `expo-file-system` `File` and pass that object directly to `FormData.append` — its native-module-backed `.bytes()` satisfies `convertFormData` without any JS-side `Blob` construction. Found in Stage 2 Task 8.
- **The mobile test suite cannot see layout.** `@testing-library/react-native` builds the element tree and runs no layout pass, so a control squeezed to 2pt, an element behind another, or anything clipped by `overflow: hidden` is invisible to every one of the 1,100 mobile tests while the markup, the roles and the testIDs all assert green. This is not a gap to close with more RNTL tests — it is the reason the tab bar shipped icon-only (see `src/theme/TabBar.tsx`). Anything whose defect is geometric has to be looked at: render the app through react-native-web at device size, or load it in Expo Go on the phone.
- **Do not set `tabBarStyle.height` to make the tab bar taller.** `getTabBarHeight` in `@react-navigation/bottom-tabs` returns a custom height verbatim and drops the device's own bottom inset with it, so a taller bar sits under the home indicator on a gesture-navigation phone. A bar that must size to its own contents has to read the inset itself — which is why `src/theme/TabBar.tsx` draws it rather than configuring the stock one. Keep `app/(tabs)/_layout.tsx` hook-free so its test can call it as a plain function.
- **React Native has no `filter: blur()`.** Any softness transcribed from a CSS mockup has to be rebuilt from `expo-linear-gradient` — in `Glow` (`src/theme/ui.tsx`) that is a low-opacity colour gradient with a three-stop scrim of the surface colour stacked over it, so the light dissolves into the surface instead of ending at an edge. The trap is that a blurred halo in CSS has no edges at all, so an inset gradient is covered by the content it should surround and one that overhangs is a hard-edged block; a wash of this kind must run from the screen edge and dissolve, not be anchored to the element or to a scroll view whose bounds differ from the screen's.
- **A custom font family on Android synthesises neither weight nor italic.** `fontWeight: '600'` or `fontStyle: 'italic'` against `Fraunces_400Regular` either does nothing or silently drops back to the system font. Every face has to be loaded and named individually — see the list in `src/theme/fonts.ts` and the presets that name them in `src/theme/type.ts`; the two must stay in step, because a preset naming an unregistered family renders as the system font with no error. For the same reason, assert the face in a test rather than `fontStyle`.
- **Colour is measured here, not eyeballed.** `src/theme/tokens.test.ts` walks every ink/surface pair the app actually renders text in and computes WCAG 1.4.3 contrast from relative luminance, so a passing pair is legible in greyscale and to a colour-blind reader. It exists because the signed-off mockup's own palette failed: its secondary grey — the colour of most of the words in this app — was 3.98:1, and its error red 4.27:1, against a 4.5:1 requirement that applies because the smallest type here is 11pt (large text starts at 18pt, or 14pt bold). A warm low-contrast palette stays pleasant right up until somebody cannot read it, which is exactly the failure eyes do not catch. Add a colour to `tokens.ts` and the test walks it too.
- **Do not add a model warm-up or preload to the AI service.** `services/ai/app/main.py` deliberately does *not* load the CLIP model at import; the first `POST /tag` pays the load. Phase 3 §4 documents a 3-5 second cold start as a known bottleneck, and Stage 9 has to be able to measure it — warming at startup would erase the measurement. Measured on the real device path at **1.47-1.73 s** at the API->AI boundary (with `model_loaded: false` asserted first), against 57-199 ms warm.
