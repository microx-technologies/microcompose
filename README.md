# microcompose

One TypeScript stack declaration for both automated integration tests and
manual runs — no YAML duplicate. Each service gets an ephemeral free host
port inside a declared range, and `DATABASE_URL`-style env vars are
autofilled with the actually-bound ports before your tests read them.
Two identical stacks boot side-by-side with zero manual port edits.

Requires **Node >= 22** and a running **Docker** daemon (via
[testcontainers](https://github.com/testcontainers/testcontainers-node)).

## Install

This package is installed from GitHub, not a registry:

```sh
# bun
bun add github:microx-technologies/microcompose

# pnpm
pnpm add github:microx-technologies/microcompose
```

Pin a ref for reproducible installs:

```sh
# bun
bun add github:microx-technologies/microcompose#v0.1.0

# pnpm
pnpm add github:microx-technologies/microcompose#v0.1.0
```

Then import:

```ts
import { defineStack, runManual } from "microcompose";
```

> `microcompose` needs `testcontainers` and `zod` at runtime — they are
> regular dependencies and install automatically.

## Quick start

### 1. Declare the stack once (`stack-def.ts`)

```ts
import { defineStack } from "microcompose";

export const stack = defineStack({
  defaultRange: [43000, 43999] as const,
  services: {
    pg: {
      image: "postgres:16",
      ports: [{ container: 5432, range: [44000, 44999] as const }],
      env: { POSTGRES_PASSWORD: "pw" }, // container env, into the container only
    },
    redis: {
      image: "redis:7",
      ports: [{ container: 6379 }], // falls back to defaultRange
    },
  },
  env: {
    // host env templates → written to process.env by up()
    DATABASE_URL: "postgresql://user:pw@{{host:pg}}:{{port:pg:5432}}/db",
    REDIS_URL: "redis://{{host:redis}}:{{port:redis:6379}}",
  },
});
```

The same file feeds both entry points below — no per-consumer edits.

### 2a. Automated tests

```ts
import { stack } from "./stack-def";

beforeAll(() => stack.up(), 120_000);
afterAll(() => stack.down());

test("...", () => {
  // process.env.DATABASE_URL already points at this run's ports
});
```

### 2b. Manual run (`scripts/dev-stack.ts`)

```ts
import { runManual } from "microcompose";
import { stack } from "./stack-def";

await runManual(stack);
```

`runManual` boots via the same `up()` path, prints one line per resolved
var to stdout (`export KEY='value'` — safe to `eval`), per-service
mappings (`pg: 5432 → 44012`) to stderr, and holds until Ctrl-C.

## API

| Export         | Does                                                        |
| -------------- | ----------------------------------------------------------- |
| `defineStack(decl)` | Declares the stack. Pure — starts nothing. Returns a handle. |
| `defineStack()`     | Returns a `StackBuilder` (`service()` → `withX()` → `build()`). |
| `stack.up(opts?)`   | Boots all services, waits for readiness, resolves + injects env. Returns the resolved `Record<string, string>`. Throws `StackAlreadyUpError` if already up. |
| `stack.down()`      | Stops containers, restores the `process.env` snapshot. Safe no-op when not up. |
| `stack.hostPort(service, containerPort)` | Allocated host port; throws `StackNotUpError` / `UnknownServiceError` / `UnknownPortError`. |
| `stack.mappings()`  | Per-service `{ service, host, ports }` in declaration order. |
| `stack.env`         | Last resolved map (fresh copy; `undefined` before first `up()`). |
| `runManual(stack, opts?)` | `up()` + print exports + wait for SIGINT/SIGTERM + `down()`. |
| `isProbeFree(port)` | TCP bind probe helper (best-effort check, not a reservation). |

Port ranges: every exposed port needs one — per-port `range`, else
`up({ defaultRange })`, else declaration `defaultRange`. If none exists,
`up()` throws `MissingPortRangeError`. There is no built-in default.

Env templates: `{{host:<service>}}` and
`{{port:<service>:<containerPort>}}`. Single-service shorthands
(`{{host}}`, `{{port:5432}}`) resolve only when unambiguous, else
`AmbiguousPlaceholderError`. `$VAR` / `${VAR}` pass through untouched —
no dotenv expansion. Details: `docs/spec-microcompose.md`.

## Scripts

```sh
# bun
bun run build # tsup bundle to `dist/` (ESM + CJS + dts)
bun test # unit tests (no Docker needed)
bun run test:integration # full suite incl. side-by-side stacks (needs Docker)
bun run check # `biome check` + `tsc --noEmit`

# pnpm
pnpm run build # tsup bundle to `dist/` (ESM + CJS + dts)
pnpm test # unit tests (no Docker needed)
pnpm run test:integration # full suite incl. side-by-side stacks (needs Docker)
pnpm run check # `biome check` + `tsc --noEmit`
```

## Releases

CI verifies every push (rebuild, stale-`dist/` check, `check`, unit tests).
To cut a release: bump `version` in `package.json`, rebuild, commit
(including `dist/`), then push a matching semver tag:

```sh
# bun
bun run build

# pnpm
pnpm run build
```

```sh
git tag v0.1.0   # MUST equal package.json version
git push --follow-tags
```

The tag triggers the release workflow (build → verify → pack →
GitHub Release with the tarball attached). Consumers install a release with:

```sh
# bun
bun add github:microx-technologies/microcompose#v0.1.0

# pnpm
pnpm add github:microx-technologies/microcompose#v0.1.0
```

## License

AGPL-3.0. See `LICENSE`.
