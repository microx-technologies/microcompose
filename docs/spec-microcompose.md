# microcompose — Env/Port Autofill Specification

## 1. Intent

- **Outcome:** compose stacks declare services without hardcoded host ports; at up-time each service gets an ephemeral free port inside (or outside) a declared range, and env-var connection strings referencing those ports are autofilled before the app/test reads them.
- **User:** any dev running ≥2 compose stacks (or parallel test suites) on one machine where fixed host ports (e.g. two `postgres:5432`) collide.
- **Why now:** parallel projects + parallel test runs make fixed host-port compose files conflict-prone; hand-editing ports per checkout doesn't scale.
- **Success:** two identical stacks boot side-by-side with zero manual port edits; `DATABASE_URL`-style vars resolve to the actually-bound ports.
- **Constraint:** full ephemeralness within the declared range — no two running stacks may hold the same host port, and a re-run MUST NOT reuse a port still held by a live stack.

## 2. Shape

TS-only library built on `testcontainers` (npm). No YAML, no `DockerComposeEnvironment`.

One TS stack declaration is the single source of truth for both automated
integration tests and manual runs — this kills the YAML-for-manual +
TS-duplicate-for-automated duplication problem.

```ts
import { defineStack } from 'microcompose';

export const stack = defineStack({
  defaultRange: [43000, 43999] as const,
  services: {
    pg: {
      image: 'postgres:16',
      ports: [{ container: 5432, range: [44000, 44999] as const }],
      env: { POSTGRES_PASSWORD: 'pw' }, // container env, passed into the container
    },
    redis: {
      image: 'redis:7',
      ports: [{ container: 6379 }], // no per-port range → uses defaultRange
    },
  },
  env: {
    // host env templates → written to process.env at up-time
    DATABASE_URL: 'postgresql://user:pw@{{host:pg}}:{{port:pg:5432}}/db',
    REDIS_URL: 'redis://{{host:redis}}:{{port:redis:6379}}',
  },
});
```

## 3. Stack declaration

```ts
type PortRange = readonly [min: number, max: number]; // inclusive both ends
interface PortDecl { container: number; range?: PortRange; }
interface ServiceDecl {
  image: string;
  ports?: PortDecl[];
  env?: Record<string, string>; // container env only, never templated
  waitFor?: WaitStrategy; // Testcontainers wait strategy replacing the default port-open wait, optional
}
interface StackDecl {
  services: Record<string, ServiceDecl>;
  defaultRange?: PortRange;
  env?: Record<string, string>; // host env templates, resolved at up-time
}
```

- `defineStack(decl)` is pure: it MUST NOT start containers, probe ports, or
  touch `process.env`. All fallible checks that need runtime state happen in `up()`.
  The `defineStack()` no-arg overload returns a `StackBuilder` (`service(name, opts)`
  then per-service `withX` chain then `build()`); builder `service()`/`build()` validate
  eagerly with the same errors, and a service with zero ports and no `waitFor` is ready
  right after start (no wait call).
- Service names MUST be non-empty strings (empty throws `InvalidServiceDeclError`);
  `image` MUST be a non-empty string (else `InvalidServiceDeclError`); container ports
  MUST be integers `1-65535` (else `InvalidServiceDeclError`); duplicate container
  ports within one service (`ports: [{container: 5432}, {container: 5432}]`) throw
  `DuplicatePortError` from `defineStack`.
- A range is valid iff both ends are integers, `1 <= min <= max <= 65535`.
  Anything else throws `InvalidRangeError` from `defineStack` (an invalid
  `up()` `defaultRange` throws `InvalidRangeError` from `up()`).
- `ServiceDecl.env` is passed into the container verbatim. It MUST NOT go
  through placeholder resolution and MUST NOT leak into `process.env`.
- `StackDecl.env` values are templates (see §5). They MUST NOT be passed into
  any container.
- The library defines NO built-in port range. Every exposed port needs an
  explicit range: per-port `range`, else the effective default
  (`up()` option `defaultRange` ?? declaration `defaultRange`). If neither
  exists, `up()` throws `MissingPortRangeError` naming service + container port.
  Precedence is strict: per-port range wins over `up()` `defaultRange` wins
  over declaration `defaultRange`. There is no other fallback.
- Builder `withX` allowlist (same signatures as `GenericContainer`, applied after core
  ports/env/wait in call order): `withCommand`, `withEntrypoint`, `withLabels`,
  `withPlatform`, `withTmpFs`, `withUlimits`, `withSecurityOpt`, `withAddedCapabilities`,
  `withDroppedCapabilities`, `withExtraHosts`, `withBindMounts`, `withHealthCheck`,
  `withStartupTimeout`, `withDefaultLogDriver`, `withPrivilegedMode`, `withUser`,
  `withPullPolicy`, `withIpcMode`, `withWorkingDir`, `withResourcesQuota`,
  `withSharedMemorySize`, `withLogConsumer`, `withHostname`. Reserved (never exposed;
  type-level omission): `withExposedPorts`, `withEnvironment`, `withWaitStrategy`,
  `withReuse`, `withAutoRemove`, `withAutoCleanup`, `withName`, `withNetwork`,
  `withNetworkMode`, `withNetworkAliases`, all `withCopy*` methods.

## 4. Port allocation

At `up()`, each declared container port is bound to an explicitly allocated
free host port inside its effective range. The implementation MUST request an
explicit host-port binding from Docker; it MUST NOT rely on Docker's random
host-port assignment, which can fall outside the declared range.

- Scan order is ascending from range min. First free candidate wins.
  Deterministic, debuggable, boring on purpose.
- A candidate is free iff a host TCP bind probe on it succeeds. Probing is
  best-effort filtering; the atomic decision is Docker's bind.
- Race handling is explicit, not a fallback: if Docker rejects the bind
  (port taken between probe and bind, e.g. by a sibling stack starting
  concurrently), allocation continues with the next candidate in range.
  Classification is probe-only (no message matching): a start failure re-probes the
  tentative hosts; taken means bind race (retry next candidate), still-free means a
  genuine start error (original error propagates unwrapped). No lockfile protocol
  exists; probe + Docker atomic bind + continue-on-conflict is the whole story.
- Allocated host ports MUST be distinct within one stack, even when two
  declarations' ranges overlap. The allocator tracks a per-`up()` claimed set.
- Across stacks: a candidate held by any live stack MUST NOT be handed out.
  Covered by probe + bind-conflict path above.
- Exhaustion: when no candidate in range binds, `up()` throws
  `NoFreePortInRangeError` carrying `{ service, containerPort, range }`.
  It MUST fail fast: stop every container this `up()` already started, restore
  the `process.env` snapshot (see §6), leave no half-up stack behind, then throw.
  Retrying, waiting, or silently binding outside the range are all forbidden —
  a hanging `up()` in parallel CI is worse than a loud mis-sized range.
- `up()` MUST NOT resolve env or return until every service is started AND its
  wait condition holds. Default wait, when the service declares none, is
  port-open on each exposed container port — tests connecting immediately after
  `up()` is the core UX this library exists for.

## 5. Env templates and injection

Stack-level `env` values are string templates resolved after all containers are
up and their host ports are known, before `up()` returns.

- Placeholders (only these two forms exist):
  - `{{host:<service>}}` → that service's container host (`getHost()`).
  - `{{port:<service>:<containerPort>}}` → that service's allocated host port
    for the given container port, rendered as plain decimal.
- Shorthand: `{{host}}` / `{{port:<containerPort>}}` are allowed iff unambiguous
  — exactly one service in the stack (for `{{host}}`), exactly one service
  exposing that container port (for `{{port:...}}`). Otherwise `up()` throws
  `AmbiguousPlaceholderError` naming the placeholder and the matching services.
  The qualified form is always accepted.
- Template errors, all thrown from `up()` before any `process.env` mutation,
  with started containers stopped first (§4 exhaustion cleanup applies equally):
  - unknown service → `UnknownServiceError` (names the placeholder + known services);
  - service does not expose that container port → `UnknownPortError`;
  - unclosed `{{` or whitespace inside the braces (`{{port: pg:5432}}` is
    malformed, no lenient parsing) → `MalformedTemplateError` naming the env
    key and the offending template. Also malformed: `{{port:svc:abc}}`
    (non-numeric port), `{{foo:...}}` (unknown prefix), `{{}}`, `{{{x}}}`,
    `{{host:}}`/`{{port:}}`/`{{port:svc:}}`. `\\{{` renders a backslash plus a live
    placeholder; a shorthand matching zero services is `AmbiguousPlaceholderError`
    with empty `candidates` (not `UnknownPortError`).
- dotenv non-collision (normative): the resolver interprets ONLY `{{...}}`.
  `$VAR` / `${VAR}` / any dotenv or dotenv-expand syntax passes through
  byte-identical into `process.env`. The library MUST NOT perform dotenv
  expansion itself, MUST NOT pre-expand `$` forms, and MUST NOT strip or escape
  `$`. A template containing `${HOME}` MUST land in `process.env` containing
  `${HOME}` untouched.
- Escape: `\{{` renders a literal `{{` (the rest of that span stays literal text).
  `\\` renders one backslash; a lone `\` elsewhere is preserved verbatim.
- Injection semantics:
  1. Resolve every template fully first.
  2. Snapshot prior `process.env` values for every key in the stack `env`
     (recording absent-vs-present distinctly).
  3. Assign all resolved values to `process.env`.
  4. `up()` returns the resolved map AND writes it to `process.env` — both.
     The returned map is the escape hatch for callers that cannot use global env
     (it is how a future in-process-worker design would consume per-stack env
     without touching `process.env`; that design itself is out of scope, §10).
- `down()` restores the snapshot: previously-present keys get their old values
  back, previously-absent keys are deleted. Sequential suites sharing one
  process MUST NOT leak one stack's URLs into the next.
- Read accessors on the handle: `stack.env` (last resolved map, `undefined`
  before first `up()`, retained after `down()`; every read is a fresh copy),
  `stack.hostPort(service, containerPort)` (checks `StackNotUpError` first, then
  `UnknownServiceError` / `UnknownPortError`), `stack.mappings()` (per-service host +
  port pairs in declaration order for `runManual` status lines).

## 6. Lifecycle (automated runs)

```ts
const stack = defineStack({ /* ... */ });

beforeAll(() => stack.up(), 120_000);
afterAll(() => stack.down());
```

- `up(opts?: { defaultRange?: PortRange })`: boots all services, waits (§4),
  resolves + injects env (§5), returns the resolved `Record<string, string>`.
- Calling `up()` on an already-up handle throws `StackAlreadyUpError`. No
  reference counting, no silent re-entry — one handle owns one stack.
- `down()`: stops containers, restores the `process.env` snapshot. It MUST be
  a safe no-op when the stack is not up, so `afterAll(() => stack.down())`
  needs no guard and a failed `up()` never leaves `down()` throwing.
- Container start errors (bad image, pull failure) propagate as-is after the
  same cleanup §4 mandates: stop started siblings, restore env snapshot, throw
  the original error unwrapped.
- Parallelism model: one stack handle per OS process serves one suite file.
  Parallel suites are separate OS processes, each with its own handle, ports,
  and `process.env`. This is what makes inherited-env injection sound: a single
  global `DATABASE_URL` per process always points at that process's own stack.
- Timeouts are the runner's business (`beforeAll` timeout, CI timeout); `up()`
  takes no timeout parameter and MUST NOT implement its own retry-until-free
  loop (§4).

## 7. Manual runs

```ts
// scripts/dev-stack.ts
import { runManual } from 'microcompose';
import { stack } from './stack-def';

await runManual(stack);
```

- `runManual(stack, opts?: { defaultRange?: PortRange })` boots via the same `up(opts)`
  path (same allocation, same resolution — manual and automated runs cannot drift),
  then prints one line per resolved var to stdout: `export KEY='value'`
  (single-quote-escaped as `'\''`), so a second terminal can `eval` them or
  copy-paste a `DATABASE_URL`. Export lines follow stack `env` declaration order.
- It then holds the process alive until SIGINT/SIGTERM, then runs the same
  `down()` path (containers stopped, env snapshot restored — a no-op
  observable-wise in a dedicated process, but the same code path) and exits 0.
  An `up()` failure prints to stderr and exits 1; a `down()` failure also exits 1.
- Status lines (`Stack up. Press Ctrl-C to stop.`, per-service
  `pg: 5432 → 44012` mappings in declaration order) go to stderr; stdout carries
  ONLY the `export ...` lines so it stays machine-consumable.
- The declaration file MUST be importable by both the test setup and the manual
  script with no per-consumer edits — one declaration, two entry points.

## 8. Errors

All errors are dedicated classes exported from the package root, each carrying
the fields listed. String-matching on `.message` is never the contract.

| Class | Fields | Thrown from |
|---|---|---|
| `InvalidRangeError` | `{ range }` | `defineStack` / `up()` (for `up()` `defaultRange`) |
| `DuplicatePortError` | `{ service, containerPort }` | `defineStack` |
| `InvalidServiceDeclError` | `{ service, reason }` | `defineStack` |
| `MissingPortRangeError` | `{ service, containerPort }` | `up()` |
| `NoFreePortInRangeError` | `{ service, containerPort, range }` | `up()` |
| `UnknownServiceError` | `{ placeholder, knownServices }` / `{ service }` for accessors | `up()` / accessors |
| `UnknownPortError` | `{ service, containerPort }` | `up()` / accessors |
| `AmbiguousPlaceholderError` | `{ placeholder, candidates }` | `up()` |
| `MalformedTemplateError` | `{ key, template }` | `up()` |
| `StackAlreadyUpError` | — | `up()` |
| `StackNotUpError` | — | `stack.hostPort` / `stack.mappings` |

Every `up()` failure path MUST leave: zero running containers from this handle
and `process.env` identical to before the call. Failed `up()` MUST be
retryable (e.g. after widening the range) on the same handle.

## 9. Acceptance

- **A1 side-by-side:** two handles from the identical declaration boot in two
  processes; allocated host ports are disjoint; the two `DATABASE_URL`s differ
  and both accept TCP connections. Zero manual port edits.
- **A2 no reuse:** a handle `up()` while an identical stack is live gets
  different host ports; at no point do two live stacks hold the same host port.
- **A3 exhaustion:** with a range of size 1, the second concurrent `up()`
  throws `NoFreePortInRangeError` with correct `{ service, containerPort,
  range }`, leaks no containers, and leaves `process.env` untouched.
- **A4 dotenv passthrough:** a template value containing `${HOME}`/`$FOO`
  lands in `process.env` byte-identical; no expansion, no error.
- **A5 ambiguity:** `{{port:5432}}` with two services exposing `5432` throws
  `AmbiguousPlaceholderError`; the qualified `{{port:pg:5432}}` resolves.
- **A6 missing range:** a port with neither per-port range nor effective
  default throws `MissingPortRangeError` (no implicit default range exists).
- **A7 env hygiene:** keys overwritten by `up()` hold pre-`up()` values again
  after `down()`; keys that were absent are absent again.
- **A8 manual smoke:** `runManual` prints only `export ...` lines to stdout,
  per-service mappings to stderr, holds the stack until SIGINT, then exits 0
  with no running containers.

## 10. Out of scope

- YAML parsing and `DockerComposeEnvironment` support. There is no compose
  file; the TS declaration is the only stack definition. (This is what removes
  the manual-YAML/automated-TS duplication.)
- In-process parallel workers/suites sharing one `process.env`. One global
  `DATABASE_URL` cannot address two stacks; such runners MUST use the resolved
  map returned from `up()` directly instead of inherited env. That consumption
  pattern is supported but no worker fan-out helper is built.
- Silent binding outside the declared range, retry-until-free loops, and
  cross-process reservation protocols (lockfiles, daemons). Probe + Docker
  atomic bind + continue-in-range + fail-fast on exhaustion is the complete
  mechanism.
- Container image builds, volumes, networks, and health semantics beyond the
  opaque `waitFor` passthrough. If the app needs readiness beyond port-open, it
  declares a wait strategy; the library adds no readiness model of its own.
