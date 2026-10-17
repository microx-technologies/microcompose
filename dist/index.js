// src/errors.ts
var InvalidRangeError = class extends Error {
  range;
  constructor(range) {
    super(
      `Invalid port range: ${JSON.stringify(range)} (expected [min, max] integers with 1 <= min <= max <= 65535)`
    );
    this.name = "InvalidRangeError";
    this.range = range;
  }
};
var DuplicatePortError = class extends Error {
  service;
  containerPort;
  constructor(service, containerPort) {
    super(`Duplicate container port ${containerPort} in service "${service}"`);
    this.name = "DuplicatePortError";
    this.service = service;
    this.containerPort = containerPort;
  }
};
var MissingPortRangeError = class extends Error {
  service;
  containerPort;
  constructor(service, containerPort) {
    super(
      `No port range for ${service}:${containerPort} (provide a per-port range, an up() defaultRange, or a declaration defaultRange)`
    );
    this.name = "MissingPortRangeError";
    this.service = service;
    this.containerPort = containerPort;
  }
};
var NoFreePortInRangeError = class extends Error {
  service;
  containerPort;
  range;
  constructor(service, containerPort, range) {
    super(
      `No free port in range [${range[0]}, ${range[1]}] for ${service}:${containerPort}`
    );
    this.name = "NoFreePortInRangeError";
    this.service = service;
    this.containerPort = containerPort;
    this.range = range;
  }
};
var UnknownServiceError = class extends Error {
  placeholder;
  knownServices;
  service;
  constructor(fields) {
    super(
      fields.placeholder !== void 0 ? `Unknown service in placeholder ${fields.placeholder} (known: ${(fields.knownServices ?? []).join(", ")})` : `Unknown service "${fields.service}"`
    );
    this.name = "UnknownServiceError";
    this.placeholder = fields.placeholder;
    this.knownServices = fields.knownServices;
    this.service = fields.service;
  }
};
var UnknownPortError = class extends Error {
  service;
  containerPort;
  constructor(service, containerPort) {
    super(
      `Service "${service}" does not expose container port ${containerPort}`
    );
    this.name = "UnknownPortError";
    this.service = service;
    this.containerPort = containerPort;
  }
};
var AmbiguousPlaceholderError = class extends Error {
  placeholder;
  candidates;
  constructor(placeholder, candidates) {
    super(
      `Ambiguous placeholder ${placeholder} (matches: ${candidates.join(", ")})`
    );
    this.name = "AmbiguousPlaceholderError";
    this.placeholder = placeholder;
    this.candidates = candidates;
  }
};
var MalformedTemplateError = class extends Error {
  key;
  template;
  constructor(key, template) {
    super(`Malformed template in env key "${key}": ${template}`);
    this.name = "MalformedTemplateError";
    this.key = key;
    this.template = template;
  }
};
var StackAlreadyUpError = class extends Error {
  constructor() {
    super("Stack is already up (one handle owns one stack; call down() first)");
    this.name = "StackAlreadyUpError";
  }
};
var StackNotUpError = class extends Error {
  constructor() {
    super("Stack is not up");
    this.name = "StackNotUpError";
  }
};
var InvalidServiceDeclError = class extends Error {
  service;
  reason;
  constructor(service, reason) {
    super(`Invalid service declaration "${service}": ${reason}`);
    this.name = "InvalidServiceDeclError";
    this.service = service;
    this.reason = reason;
  }
};

// src/manual.ts
function escapeShellSingle(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
async function runManual(stack, opts) {
  let resolved;
  try {
    resolved = opts?.defaultRange !== void 0 ? await stack.up({ defaultRange: opts.defaultRange }) : await stack.up();
  } catch (err) {
    process.stderr.write(`${String(err)}
`);
    try {
      await stack.down();
    } catch {
    }
    process.exitCode = 1;
    return;
  }
  for (const [key, value] of Object.entries(resolved)) {
    process.stdout.write(`export ${key}=${escapeShellSingle(value)}
`);
  }
  process.stderr.write("Stack up. Press Ctrl-C to stop.\n");
  for (const mapping of stack.mappings()) {
    const ports = [...mapping.ports].sort((a, b) => a.container - b.container);
    for (const { container, host } of ports) {
      process.stderr.write(`${mapping.service}: ${container} \u2192 ${host}
`);
    }
  }
  const keepAlive = setInterval(() => {
  }, 1e6);
  const { promise, resolve } = Promise.withResolvers();
  const release = () => {
    clearInterval(keepAlive);
    resolve();
  };
  process.once("SIGINT", release);
  process.once("SIGTERM", release);
  await promise;
  try {
    await stack.down();
  } catch (err) {
    process.stderr.write(`${String(err)}
`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

// src/stack.ts
import { createServer } from "net";
import {
  GenericContainer,
  Wait
} from "testcontainers";

// src/template.ts
var DIGITS = /^\d+$/;
var WHITESPACE = /\s/;
function resolveTemplates(templates, ctx) {
  const resolved = {};
  for (const [key, template] of Object.entries(templates)) {
    resolved[key] = resolveOne(key, template, ctx);
  }
  return resolved;
}
function resolveOne(key, template, ctx) {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c === "\\" && template[i + 1] === "\\") {
      out += "\\";
      i += 2;
    } else if (c === "\\" && template[i + 1] === "{" && template[i + 2] === "{") {
      out += "{{";
      i += 3;
    } else if (c === "\\") {
      out += "\\";
      i += 1;
    } else if (c === "{" && template[i + 1] === "{") {
      const close = template.indexOf("}}", i + 2);
      if (close === -1) {
        throw new MalformedTemplateError(key, template);
      }
      const inner = template.slice(i + 2, close);
      out += resolvePlaceholder(key, template, inner, ctx);
      i = close + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}
function resolvePlaceholder(key, template, inner, ctx) {
  if (inner === "" || inner.includes("{") || inner.includes("}") || WHITESPACE.test(inner)) {
    throw new MalformedTemplateError(key, template);
  }
  const placeholder = `{{${inner}}}`;
  const parts = inner.split(":");
  const [p0, p1, p2] = parts;
  if (parts.length === 1 && p0 === "host") {
    const firstService = ctx.serviceNames[0];
    if (ctx.serviceNames.length === 1 && firstService !== void 0) {
      return ctx.hostOf(firstService);
    }
    throw new AmbiguousPlaceholderError(placeholder, [...ctx.serviceNames]);
  }
  if (parts.length === 2 && p0 === "host" && p1 !== void 0 && p1 !== "") {
    if (!ctx.serviceNames.includes(p1)) {
      throw new UnknownServiceError({
        placeholder,
        knownServices: [...ctx.serviceNames]
      });
    }
    return ctx.hostOf(p1);
  }
  if (parts.length === 2 && p0 === "port" && p1 !== void 0 && DIGITS.test(p1)) {
    const containerPort = Number(p1);
    const matching = ctx.serviceNames.filter(
      (s) => ctx.exposes(s, containerPort)
    );
    const firstMatching = matching[0];
    if (matching.length === 1 && firstMatching !== void 0) {
      return String(ctx.portOf(firstMatching, containerPort));
    }
    throw new AmbiguousPlaceholderError(placeholder, matching);
  }
  if (parts.length === 3 && p0 === "port" && p1 !== void 0 && p1 !== "" && p2 !== void 0 && DIGITS.test(p2)) {
    const service = p1;
    const containerPort = Number(p2);
    if (!ctx.serviceNames.includes(service)) {
      throw new UnknownServiceError({
        placeholder,
        knownServices: [...ctx.serviceNames]
      });
    }
    if (!ctx.exposes(service, containerPort)) {
      throw new UnknownPortError(service, containerPort);
    }
    return String(ctx.portOf(service, containerPort));
  }
  throw new MalformedTemplateError(key, template);
}

// src/validate.ts
import { z } from "zod";
var MIN_PORT = 1;
var MAX_PORT = 65535;
function isValidRange(range) {
  if (!Array.isArray(range) || range.length !== 2) {
    return false;
  }
  const [min, max] = range;
  if (typeof min !== "number" || typeof max !== "number") {
    return false;
  }
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    return false;
  }
  return min >= MIN_PORT && max >= MIN_PORT && min <= MAX_PORT && max <= MAX_PORT && min <= max;
}
function assertValidRange(range) {
  if (!isValidRange(range)) {
    throw new InvalidRangeError(range);
  }
}
var PortRangeSchema = z.custom(
  (v) => isValidRange(v),
  "PortRange must be [min, max] integers with 1 <= min <= max <= 65535"
);
var PortDeclSchema = z.object({
  container: z.unknown(),
  range: PortRangeSchema.optional()
});
var ServiceDeclSchema = z.object({
  image: z.unknown(),
  ports: z.array(PortDeclSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  waitFor: z.custom(
    (v) => typeof v === "object" && v !== null,
    "waitFor must be a Testcontainers wait strategy object"
  ).optional()
});
var StackDeclSchema = z.object({
  services: z.record(z.string(), ServiceDeclSchema),
  defaultRange: PortRangeSchema.optional(),
  env: z.record(z.string(), z.string()).optional()
});
function nonEmptyServiceName(raw) {
  if (raw === "") {
    throw new InvalidServiceDeclError(
      raw,
      "service name must be a non-empty string"
    );
  }
  return raw;
}
function checkedImage(service, image) {
  if (typeof image !== "string" || image === "") {
    throw new InvalidServiceDeclError(
      service,
      `service "${service}" image must be a non-empty string`
    );
  }
  return image;
}
function checkedContainerPort(service, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    throw new InvalidServiceDeclError(
      service,
      `service "${service}" has invalid container port ${String(value)}: must be integer 1-65535`
    );
  }
  return value;
}
function normalizeStackDecl(input) {
  const parsed = StackDeclSchema.safeParse(input);
  if (!parsed.success) {
    throw firstDeclError(input, parsed.error);
  }
  const raw = parsed.data;
  const services = {};
  const serviceOrder = [];
  for (const [rawName, svc] of Object.entries(raw.services)) {
    const service = nonEmptyServiceName(rawName);
    const image = checkedImage(service, svc.image);
    const seen = /* @__PURE__ */ new Set();
    const ports = (svc.ports ?? []).map((p) => {
      const container = checkedContainerPort(service, p.container);
      if (seen.has(container)) {
        throw new DuplicatePortError(service, container);
      }
      seen.add(container);
      const out2 = { container };
      if (p.range !== void 0) {
        out2.range = p.range;
      }
      return out2;
    });
    const entry = { image, ports, env: svc.env ?? {} };
    if (svc.waitFor !== void 0) {
      entry.waitFor = svc.waitFor;
    }
    services[service] = entry;
    serviceOrder.push(service);
  }
  const out = {
    services,
    serviceOrder,
    env: raw.env ?? {}
  };
  if (raw.defaultRange !== void 0) {
    out.defaultRange = raw.defaultRange;
  }
  return out;
}
function firstDeclError(input, error) {
  const issue = error.issues[0];
  const path = issue?.path ?? [];
  if (typeof input !== "object" || input === null) {
    throw new InvalidServiceDeclError("", "stack declaration is invalid");
  }
  if (path.length >= 1 && (path[0] === "defaultRange" || path[0] === "env")) {
    if (path[0] === "defaultRange" && "defaultRange" in input) {
      throw new InvalidRangeError(input.defaultRange);
    }
    if (path[0] === "defaultRange") {
      throw new InvalidRangeError(void 0);
    }
    const envKey = typeof path[1] === "string" ? path[1] : String(path[1] ?? "");
    throw new InvalidServiceDeclError(
      envKey,
      `stack env "${envKey}" must map to a string`
    );
  }
  if (path[0] === "services" && typeof path[1] === "string" && "services" in input) {
    const name = path[1];
    const service = name === "" ? "" : name;
    let svc;
    if (typeof name === "string" || typeof name === "number") {
      const servicesField = input.services;
      if (typeof servicesField === "object" && servicesField !== null && !Array.isArray(servicesField) && name in servicesField) {
        svc = servicesField[name];
      }
    }
    const rest = path.slice(2);
    if (rest.length === 0) {
      if (service === "") {
        throw new InvalidServiceDeclError(
          "",
          "service name must be a non-empty string"
        );
      }
      throw new InvalidServiceDeclError(
        service,
        `service "${service}" declaration is invalid`
      );
    }
    if (rest[0] === "image") {
      throw new InvalidServiceDeclError(
        service,
        `service "${service}" image must be a non-empty string`
      );
    }
    if (rest[0] === "ports" && typeof rest[1] === "number") {
      let entry;
      if (typeof svc === "object" && svc !== null && "ports" in svc && Array.isArray(svc.ports)) {
        const candidate = svc.ports[rest[1]];
        if (typeof candidate === "object" && candidate !== null) {
          entry = candidate;
        }
      }
      if (rest[2] === "range") {
        const range = typeof entry === "object" && entry !== null && "range" in entry ? entry.range : void 0;
        throw new InvalidRangeError(range);
      }
      const container = typeof entry === "object" && entry !== null && "container" in entry ? entry.container : void 0;
      throw new InvalidServiceDeclError(
        service,
        `service "${service}" has invalid container port ${String(container)}: must be integer 1-65535`
      );
    }
    if (rest[0] === "ports") {
      throw new InvalidServiceDeclError(
        service,
        `service "${service}" ports must be an array`
      );
    }
    if (rest[0] === "env") {
      throw new InvalidServiceDeclError(
        service,
        `service "${service}" env values must be strings`
      );
    }
    if (rest[0] === "waitFor") {
      throw new InvalidServiceDeclError(
        service,
        `service "${service}" waitFor must be a Testcontainers wait strategy object`
      );
    }
  }
  if (path[0] === "services") {
    throw new InvalidServiceDeclError(
      "",
      "stack services must be a record of service declarations"
    );
  }
  throw new InvalidServiceDeclError("", "stack declaration is invalid");
}

// src/stack.ts
function checkedServiceState(services, current) {
  if (current === void 0) {
    throw new InvalidServiceDeclError(
      "",
      "withX methods need a service declared first (call service(name, opts))"
    );
  }
  const state = services.get(current);
  if (state === void 0) {
    throw new InvalidServiceDeclError(
      current,
      `service "${current}" declaration is invalid`
    );
  }
  return state;
}
var StackBuilder = class {
  services = /* @__PURE__ */ new Map();
  order = [];
  current;
  defaultRangeValue;
  envValue = {};
  service(name, opts) {
    if (name === "") {
      throw new InvalidServiceDeclError(
        "",
        "service name must be a non-empty string"
      );
    }
    if (this.services.has(name)) {
      throw new InvalidServiceDeclError(
        name,
        `service "${name}" declared twice`
      );
    }
    const state = {
      image: opts.image,
      ports: opts.ports ?? [],
      env: opts.env ?? {},
      waitFor: void 0,
      appliers: []
    };
    if (opts.waitFor !== void 0) {
      state.waitFor = opts.waitFor;
    }
    this.services.set(name, state);
    this.order.push(name);
    this.current = name;
    return this;
  }
  env(vars) {
    this.envValue = { ...this.envValue, ...vars };
    return this;
  }
  defaultRange(range) {
    assertValidRange(range);
    this.defaultRangeValue = [range[0], range[1]];
    return this;
  }
  withCommand(command) {
    return this.pushApplier((c) => {
      c.withCommand(command);
    });
  }
  withEntrypoint(entrypoint) {
    return this.pushApplier((c) => {
      c.withEntrypoint(entrypoint);
    });
  }
  withLabels(labels) {
    return this.pushApplier((c) => {
      c.withLabels(labels);
    });
  }
  withPlatform(platform) {
    return this.pushApplier((c) => {
      c.withPlatform(platform);
    });
  }
  withTmpFs(tmpFs) {
    return this.pushApplier((c) => {
      c.withTmpFs(tmpFs);
    });
  }
  withUlimits(ulimits) {
    return this.pushApplier((c) => {
      c.withUlimits(ulimits);
    });
  }
  withSecurityOpt(...securityOptions) {
    return this.pushApplier((c) => {
      c.withSecurityOpt(...securityOptions);
    });
  }
  withAddedCapabilities(...capabilities) {
    return this.pushApplier((c) => {
      c.withAddedCapabilities(...capabilities);
    });
  }
  withDroppedCapabilities(...capabilities) {
    return this.pushApplier((c) => {
      c.withDroppedCapabilities(...capabilities);
    });
  }
  withExtraHosts(extraHosts) {
    return this.pushApplier((c) => {
      c.withExtraHosts(extraHosts);
    });
  }
  withBindMounts(bindMounts) {
    return this.pushApplier((c) => {
      c.withBindMounts(bindMounts);
    });
  }
  withHealthCheck(healthCheck) {
    return this.pushApplier((c) => {
      c.withHealthCheck(healthCheck);
    });
  }
  withStartupTimeout(startupTimeoutMs) {
    return this.pushApplier((c) => {
      c.withStartupTimeout(startupTimeoutMs);
    });
  }
  withDefaultLogDriver() {
    return this.pushApplier((c) => {
      c.withDefaultLogDriver();
    });
  }
  withPrivilegedMode() {
    return this.pushApplier((c) => {
      c.withPrivilegedMode();
    });
  }
  withUser(user) {
    return this.pushApplier((c) => {
      c.withUser(user);
    });
  }
  withPullPolicy(pullPolicy) {
    return this.pushApplier((c) => {
      c.withPullPolicy(pullPolicy);
    });
  }
  withIpcMode(ipcMode) {
    return this.pushApplier((c) => {
      c.withIpcMode(ipcMode);
    });
  }
  withWorkingDir(workingDir) {
    return this.pushApplier((c) => {
      c.withWorkingDir(workingDir);
    });
  }
  withResourcesQuota(resourcesQuota) {
    return this.pushApplier((c) => {
      c.withResourcesQuota(resourcesQuota);
    });
  }
  withSharedMemorySize(bytes) {
    return this.pushApplier((c) => {
      c.withSharedMemorySize(bytes);
    });
  }
  withLogConsumer(logConsumer) {
    return this.pushApplier((c) => {
      c.withLogConsumer(logConsumer);
    });
  }
  withHostname(hostname) {
    return this.pushApplier((c) => {
      c.withHostname(hostname);
    });
  }
  withCopyFilesToContainer(_files) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withCopyFilesToContainer is reserved: file copies stay library-owned"
    );
  }
  withCopyDirectoriesToContainer(_dirs) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withCopyDirectoriesToContainer is reserved: file copies stay library-owned"
    );
  }
  withCopyContentToContainer(_contents) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withCopyContentToContainer is reserved: file copies stay library-owned"
    );
  }
  withCopyArchivesToContainer(_archives) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withCopyArchivesToContainer is reserved: file copies stay library-owned"
    );
  }
  withCopyToContainerOptions(_opts) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withCopyToContainerOptions is reserved: file copies stay library-owned"
    );
  }
  withName(_name) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withName is reserved: fixed Docker names break side-by-side stacks"
    );
  }
  withNetwork(_network) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withNetwork is reserved: networks stay library-owned"
    );
  }
  withNetworkMode(_mode) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withNetworkMode is reserved: networks stay library-owned"
    );
  }
  withNetworkAliases(..._aliases) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withNetworkAliases is reserved: networks stay library-owned"
    );
  }
  withExposedPorts(..._ports) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withExposedPorts is reserved: port allocation stays library-owned"
    );
  }
  withEnvironment(_env) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withEnvironment is reserved: container env comes from the service declaration"
    );
  }
  withWaitStrategy(_strategy) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withWaitStrategy is reserved: use the service waitFor field"
    );
  }
  withReuse() {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withReuse is reserved: container reuse breaks stack isolation"
    );
  }
  withAutoRemove(_autoRemove) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withAutoRemove is reserved: container lifecycle stays library-owned"
    );
  }
  withAutoCleanup(_autoCleanup) {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withAutoCleanup is reserved: container lifecycle stays library-owned"
    );
  }
  pushApplier(applier) {
    checkedServiceState(this.services, this.current).appliers.push(applier);
    return this;
  }
  build() {
    const services = {};
    for (const name of this.order) {
      const state = this.services.get(name);
      if (!state) {
        throw new InvalidServiceDeclError(
          name,
          `service "${name}" declaration is missing`
        );
      }
      if (typeof state.image !== "string" || state.image === "") {
        throw new InvalidServiceDeclError(
          name,
          `service "${name}" image must be a non-empty string`
        );
      }
      const seen = /* @__PURE__ */ new Set();
      const ports = state.ports.map((p) => {
        if (!Number.isInteger(p.container) || p.container < 1 || p.container > 65535) {
          throw new InvalidServiceDeclError(
            name,
            `service "${name}" has invalid container port ${String(p.container)}: must be integer 1-65535`
          );
        }
        if (seen.has(p.container)) {
          throw new DuplicatePortError(name, p.container);
        }
        seen.add(p.container);
        if (p.range !== void 0) {
          assertValidRange(p.range);
        }
        return p;
      });
      const entry = {
        image: state.image,
        ports,
        env: state.env
      };
      if (state.waitFor !== void 0) {
        entry.waitFor = state.waitFor;
      }
      services[name] = entry;
    }
    const decl = {
      services,
      serviceOrder: [...this.order],
      env: this.envValue
    };
    if (this.defaultRangeValue !== void 0) {
      decl.defaultRange = this.defaultRangeValue;
    }
    const appliers = /* @__PURE__ */ new Map();
    for (const name of this.order) {
      const svc = this.services.get(name);
      if (!svc) {
        throw new InvalidServiceDeclError(
          name,
          `service "${name}" declaration is missing`
        );
      }
      appliers.set(name, [...svc.appliers]);
    }
    return createStackHandle(decl, appliers);
  }
};
function defineStack(decl) {
  if (decl === void 0) {
    return new StackBuilder();
  }
  return createStackHandle(normalizeStackDecl(decl), /* @__PURE__ */ new Map());
}
function isProbeFree(port) {
  const { promise, resolve } = Promise.withResolvers();
  const server = createServer();
  server.once("error", () => {
    server.close(() => resolve(false));
  });
  server.listen(port, "0.0.0.0", () => {
    server.close(() => resolve(true));
  });
  return promise;
}
function createStackHandle(decl, appliers) {
  let upFlag = false;
  let storedEnv;
  let live = /* @__PURE__ */ new Map();
  let preUpEnv = {};
  async function stopAll(containers) {
    for (const container of [...containers].reverse()) {
      try {
        await container.stop();
      } catch {
      }
    }
  }
  function restoreEnv(snapshot) {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === void 0) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
  async function allocatePorts(service, svc, effectiveDefault, claimed) {
    const tentative = [];
    for (const p of svc.ports) {
      const range = p.range ?? effectiveDefault;
      if (range === void 0) {
        throw new MissingPortRangeError(service, p.container);
      }
      let host;
      for (let port = range[0]; port <= range[1]; port += 1) {
        if (claimed.has(port)) {
          continue;
        }
        if (await isProbeFree(port)) {
          host = port;
          break;
        }
      }
      if (host === void 0) {
        throw new NoFreePortInRangeError(service, p.container, [
          range[0],
          range[1]
        ]);
      }
      claimed.add(host);
      tentative.push(host);
    }
    return tentative;
  }
  async function recheckTaken(hosts) {
    for (const host of hosts) {
      if (!await isProbeFree(host)) {
        return true;
      }
    }
    return false;
  }
  async function startService(service, svc, effectiveDefault, claimed) {
    let tentative = await allocatePorts(
      service,
      svc,
      effectiveDefault,
      claimed
    );
    for (; ; ) {
      const container = new GenericContainer(svc.image).withExposedPorts(
        ...svc.ports.map((p, i) => {
          const host = tentative[i];
          if (host === void 0) {
            throw new Error(
              `Missing allocated host port for service "${service}" container port ${p.container}`
            );
          }
          return {
            container: p.container,
            host
          };
        })
      ).withEnvironment(svc.env);
      if (svc.waitFor !== void 0) {
        container.withWaitStrategy(svc.waitFor);
      } else if (svc.ports.length > 0) {
        container.withWaitStrategy(Wait.forListeningPorts());
      }
      for (const apply of appliers.get(service) ?? []) {
        apply(container);
      }
      try {
        return await container.start();
      } catch (err) {
        if (await recheckTaken(tentative)) {
          for (const host of tentative) {
            claimed.delete(host);
          }
          tentative = await allocatePorts(
            service,
            svc,
            effectiveDefault,
            claimed
          );
          continue;
        }
        throw err;
      }
    }
  }
  async function up(opts) {
    if (upFlag) {
      throw new StackAlreadyUpError();
    }
    if (opts?.defaultRange !== void 0) {
      assertValidRange(opts.defaultRange);
    }
    const effectiveDefault = opts?.defaultRange ?? decl.defaultRange;
    const entrySnapshot = {};
    for (const key of Object.keys(decl.env)) {
      entrySnapshot[key] = process.env[key];
    }
    const claimed = /* @__PURE__ */ new Set();
    const started = [];
    const hostOf = /* @__PURE__ */ new Map();
    const portMaps = /* @__PURE__ */ new Map();
    let failed = true;
    try {
      for (const service of decl.serviceOrder) {
        const svc = decl.services[service];
        if (!svc) {
          throw new InvalidServiceDeclError(
            service,
            `service "${service}" is missing from declaration`
          );
        }
        const container = await startService(
          service,
          svc,
          effectiveDefault,
          claimed
        );
        started.push(container);
        hostOf.set(service, container.getHost());
        const perService = /* @__PURE__ */ new Map();
        for (const p of svc.ports) {
          perService.set(p.container, container.getMappedPort(p.container));
        }
        portMaps.set(service, perService);
      }
      const templateCtx = {
        serviceNames: decl.serviceOrder,
        hostOf: (s) => {
          const h = hostOf.get(s);
          if (h === void 0) {
            throw new UnknownServiceError({ service: s });
          }
          return h;
        },
        exposes: (s, port) => {
          const svcDecl = decl.services[s];
          if (!svcDecl) {
            return false;
          }
          return svcDecl.ports.some((p) => p.container === port);
        },
        portOf: (s, port) => {
          const pm = portMaps.get(s);
          if (!pm) {
            throw new UnknownServiceError({ service: s });
          }
          const mapped = pm.get(port);
          if (mapped === void 0) {
            throw new UnknownPortError(s, port);
          }
          return mapped;
        }
      };
      const resolved = resolveTemplates(decl.env, templateCtx);
      preUpEnv = entrySnapshot;
      for (const [key, value] of Object.entries(resolved)) {
        process.env[key] = value;
      }
      storedEnv = { ...resolved };
      live = new Map(
        decl.serviceOrder.map((service, i) => {
          const container = started[i];
          const host = hostOf.get(service);
          if (!container || host === void 0) {
            throw new Error(
              `Service "${service}" failed to initialize completely`
            );
          }
          return [
            service,
            {
              container,
              host,
              hostPorts: portMaps.get(service) ?? /* @__PURE__ */ new Map()
            }
          ];
        })
      );
      upFlag = true;
      failed = false;
      return { ...resolved };
    } finally {
      if (failed) {
        await stopAll(started);
        restoreEnv(entrySnapshot);
      }
    }
  }
  async function down() {
    if (!upFlag) {
      return;
    }
    try {
      const containers = [...live.values()].map((svc) => svc.container);
      live = /* @__PURE__ */ new Map();
      await stopAll(containers);
    } finally {
      restoreEnv(preUpEnv);
      preUpEnv = {};
      upFlag = false;
    }
  }
  function hostPort(service, containerPort) {
    if (!upFlag) {
      throw new StackNotUpError();
    }
    const svc = live.get(service);
    if (svc === void 0) {
      throw new UnknownServiceError({ service });
    }
    const port = svc.hostPorts.get(containerPort);
    if (port === void 0) {
      throw new UnknownPortError(service, containerPort);
    }
    return port;
  }
  function mappings() {
    if (!upFlag) {
      throw new StackNotUpError();
    }
    return decl.serviceOrder.map((service) => {
      const svc = live.get(service);
      if (!svc) {
        throw new UnknownServiceError({ service });
      }
      return {
        service,
        host: svc.host,
        ports: [...svc.hostPorts.entries()].map(([container, host]) => ({
          container,
          host
        }))
      };
    });
  }
  return {
    up,
    down,
    get env() {
      return storedEnv === void 0 ? void 0 : { ...storedEnv };
    },
    hostPort,
    mappings
  };
}
export {
  AmbiguousPlaceholderError,
  DuplicatePortError,
  InvalidRangeError,
  InvalidServiceDeclError,
  MalformedTemplateError,
  MissingPortRangeError,
  NoFreePortInRangeError,
  StackAlreadyUpError,
  StackBuilder,
  StackNotUpError,
  UnknownPortError,
  UnknownServiceError,
  defineStack,
  escapeShellSingle,
  isProbeFree,
  resolveTemplates,
  runManual
};
//# sourceMappingURL=index.js.map