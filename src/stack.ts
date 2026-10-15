import { createServer } from "node:net";
import type { Readable } from "node:stream";
import {
  type ContentToCopy,
  type CopyToContainerOptions,
  type Environment,
  type FileToCopy,
  GenericContainer,
  type HealthCheck,
  type ImagePullPolicy,
  type Labels,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import type {
  BindMount,
  DirectoryToCopy,
  ExtraHost,
  ResourcesQuota,
  TmpFs,
  Ulimits,
} from "testcontainers/build/types.js";
import {
  DuplicatePortError,
  MissingPortRangeError,
  NoFreePortInRangeError,
  StackAlreadyUpError,
  StackNotUpError,
  UnknownPortError,
  UnknownServiceError,
} from "@/src/errors.ts";
import { resolveTemplates, type TemplateContext } from "@/src/template.ts";
import type {
  PortRange,
  ServiceMapping,
  StackDecl,
  StackHandle,
  UpOptions,
} from "@/src/types.ts";
import {
  assertValidRange,
  InvalidServiceDeclError,
  type NormalizedServiceDecl,
  type NormalizedStackDecl,
  normalizeStackDecl,
} from "@/src/validate.ts";

export type { ServiceMapping, StackDecl, StackHandle, UpOptions };

type ContainerApplier = (container: GenericContainer) => void;

interface BuilderServiceState {
  image: string;
  ports: { container: number; range?: PortRange }[];
  env: Record<string, string>;
  waitFor: NormalizedServiceDecl["waitFor"];
  appliers: ContainerApplier[];
}

function checkedServiceState(
  services: Map<string, BuilderServiceState>,
  current: string | undefined,
): BuilderServiceState {
  if (current === undefined) {
    throw new InvalidServiceDeclError(
      "",
      "withX methods need a service declared first (call service(name, opts))",
    );
  }
  const state = services.get(current);
  if (state === undefined) {
    throw new InvalidServiceDeclError(
      current,
      `service "${current}" declaration is invalid`,
    );
  }
  return state;
}

export class StackBuilder {
  private readonly services = new Map<string, BuilderServiceState>();
  private readonly order: string[] = [];
  private current: string | undefined;
  private defaultRangeValue?: PortRange;
  private envValue: Record<string, string> = {};

  service(
    name: string,
    opts: {
      image: string;
      ports?: { container: number; range?: PortRange }[];
      env?: Record<string, string>;
      waitFor?: NormalizedServiceDecl["waitFor"];
    },
  ): this {
    if (name === "") {
      throw new InvalidServiceDeclError(
        "",
        "service name must be a non-empty string",
      );
    }
    if (this.services.has(name)) {
      throw new InvalidServiceDeclError(
        name,
        `service "${name}" declared twice`,
      );
    }
    const state: BuilderServiceState = {
      image: opts.image,
      ports: opts.ports ?? [],
      env: opts.env ?? {},
      waitFor: undefined,
      appliers: [],
    };
    if (opts.waitFor !== undefined) {
      state.waitFor = opts.waitFor;
    }
    this.services.set(name, state);
    this.order.push(name);
    this.current = name;
    return this;
  }

  env(vars: Record<string, string>): this {
    this.envValue = { ...this.envValue, ...vars };
    return this;
  }

  defaultRange(range: PortRange): this {
    assertValidRange(range);
    this.defaultRangeValue = [range[0], range[1]];
    return this;
  }

  withCommand(command: string[]): this {
    return this.pushApplier((c) => {
      c.withCommand(command);
    });
  }

  withEntrypoint(entrypoint: string[]): this {
    return this.pushApplier((c) => {
      c.withEntrypoint(entrypoint);
    });
  }

  withLabels(labels: Labels): this {
    return this.pushApplier((c) => {
      c.withLabels(labels);
    });
  }

  withPlatform(platform: string): this {
    return this.pushApplier((c) => {
      c.withPlatform(platform);
    });
  }

  withTmpFs(tmpFs: TmpFs): this {
    return this.pushApplier((c) => {
      c.withTmpFs(tmpFs);
    });
  }

  withUlimits(ulimits: Ulimits): this {
    return this.pushApplier((c) => {
      c.withUlimits(ulimits);
    });
  }

  withSecurityOpt(...securityOptions: string[]): this {
    return this.pushApplier((c) => {
      c.withSecurityOpt(...securityOptions);
    });
  }

  withAddedCapabilities(...capabilities: string[]): this {
    return this.pushApplier((c) => {
      c.withAddedCapabilities(...capabilities);
    });
  }

  withDroppedCapabilities(...capabilities: string[]): this {
    return this.pushApplier((c) => {
      c.withDroppedCapabilities(...capabilities);
    });
  }

  withExtraHosts(extraHosts: ExtraHost[]): this {
    return this.pushApplier((c) => {
      c.withExtraHosts(extraHosts);
    });
  }

  withBindMounts(bindMounts: BindMount[]): this {
    return this.pushApplier((c) => {
      c.withBindMounts(bindMounts);
    });
  }

  withHealthCheck(healthCheck: HealthCheck): this {
    return this.pushApplier((c) => {
      c.withHealthCheck(healthCheck);
    });
  }

  withStartupTimeout(startupTimeoutMs: number): this {
    return this.pushApplier((c) => {
      c.withStartupTimeout(startupTimeoutMs);
    });
  }

  withDefaultLogDriver(): this {
    return this.pushApplier((c) => {
      c.withDefaultLogDriver();
    });
  }

  withPrivilegedMode(): this {
    return this.pushApplier((c) => {
      c.withPrivilegedMode();
    });
  }

  withUser(user: string): this {
    return this.pushApplier((c) => {
      c.withUser(user);
    });
  }

  withPullPolicy(pullPolicy: ImagePullPolicy): this {
    return this.pushApplier((c) => {
      c.withPullPolicy(pullPolicy);
    });
  }

  withIpcMode(ipcMode: string): this {
    return this.pushApplier((c) => {
      c.withIpcMode(ipcMode);
    });
  }

  withWorkingDir(workingDir: string): this {
    return this.pushApplier((c) => {
      c.withWorkingDir(workingDir);
    });
  }

  withResourcesQuota(resourcesQuota: ResourcesQuota): this {
    return this.pushApplier((c) => {
      c.withResourcesQuota(resourcesQuota);
    });
  }

  withSharedMemorySize(bytes: number): this {
    return this.pushApplier((c) => {
      c.withSharedMemorySize(bytes);
    });
  }

  withLogConsumer(logConsumer: (stream: Readable) => unknown): this {
    return this.pushApplier((c) => {
      c.withLogConsumer(logConsumer);
    });
  }

  withHostname(hostname: string): this {
    return this.pushApplier((c) => {
      c.withHostname(hostname);
    });
  }

  withCopyFilesToContainer(_files: FileToCopy[]): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withCopyFilesToContainer is reserved: file copies stay library-owned",
    );
  }

  withCopyDirectoriesToContainer(_dirs: DirectoryToCopy[]): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withCopyDirectoriesToContainer is reserved: file copies stay library-owned",
    );
  }

  withCopyContentToContainer(_contents: ContentToCopy[]): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withCopyContentToContainer is reserved: file copies stay library-owned",
    );
  }

  withCopyArchivesToContainer(_archives: never[]): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withCopyArchivesToContainer is reserved: file copies stay library-owned",
    );
  }

  withCopyToContainerOptions(_opts: CopyToContainerOptions): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withCopyToContainerOptions is reserved: file copies stay library-owned",
    );
  }

  withName(_name: string): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withName is reserved: fixed Docker names break side-by-side stacks",
    );
  }

  withNetwork(_network: never): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withNetwork is reserved: networks stay library-owned",
    );
  }

  withNetworkMode(_mode: string): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withNetworkMode is reserved: networks stay library-owned",
    );
  }

  withNetworkAliases(..._aliases: string[]): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withNetworkAliases is reserved: networks stay library-owned",
    );
  }

  withExposedPorts(..._ports: never[]): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withExposedPorts is reserved: port allocation stays library-owned",
    );
  }

  withEnvironment(_env: Environment): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withEnvironment is reserved: container env comes from the service declaration",
    );
  }

  withWaitStrategy(_strategy: never): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withWaitStrategy is reserved: use the service waitFor field",
    );
  }

  withReuse(): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withReuse is reserved: container reuse breaks stack isolation",
    );
  }

  withAutoRemove(_autoRemove: boolean): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withAutoRemove is reserved: container lifecycle stays library-owned",
    );
  }

  withAutoCleanup(_autoCleanup: boolean): this {
    throw new InvalidServiceDeclError(
      this.current ?? "",
      "withAutoCleanup is reserved: container lifecycle stays library-owned",
    );
  }

  private pushApplier(applier: ContainerApplier): this {
    checkedServiceState(this.services, this.current).appliers.push(applier);
    return this;
  }

  build(): StackHandle {
    const services: Record<string, NormalizedServiceDecl> = {};
    for (const name of this.order) {
      const state = this.services.get(name);
      if (!state) {
        throw new InvalidServiceDeclError(
          name,
          `service "${name}" declaration is missing`,
        );
      }
      if (typeof state.image !== "string" || state.image === "") {
        throw new InvalidServiceDeclError(
          name,
          `service "${name}" image must be a non-empty string`,
        );
      }
      const seen = new Set<number>();
      const ports = state.ports.map((p) => {
        if (
          !Number.isInteger(p.container) ||
          p.container < 1 ||
          p.container > 65535
        ) {
          throw new InvalidServiceDeclError(
            name,
            `service "${name}" has invalid container port ${String(p.container)}: must be integer 1-65535`,
          );
        }
        if (seen.has(p.container)) {
          throw new DuplicatePortError(name, p.container);
        }
        seen.add(p.container);
        if (p.range !== undefined) {
          assertValidRange(p.range);
        }
        return p;
      });
      const entry: NormalizedServiceDecl = {
        image: state.image,
        ports,
        env: state.env,
      };
      if (state.waitFor !== undefined) {
        entry.waitFor = state.waitFor;
      }
      services[name] = entry;
    }
    const decl: NormalizedStackDecl = {
      services,
      serviceOrder: [...this.order],
      env: this.envValue,
    };
    if (this.defaultRangeValue !== undefined) {
      decl.defaultRange = this.defaultRangeValue;
    }
    const appliers = new Map<string, ContainerApplier[]>();
    for (const name of this.order) {
      const svc = this.services.get(name);
      if (!svc) {
        throw new InvalidServiceDeclError(
          name,
          `service "${name}" declaration is missing`,
        );
      }
      appliers.set(name, [...svc.appliers]);
    }
    return createStackHandle(decl, appliers);
  }
}

export function defineStack(decl: StackDecl): StackHandle;
export function defineStack(): StackBuilder;
export function defineStack(decl?: StackDecl): StackHandle | StackBuilder {
  if (decl === undefined) {
    return new StackBuilder();
  }
  return createStackHandle(normalizeStackDecl(decl), new Map());
}

interface LiveService {
  container: StartedTestContainer;
  host: string;
  hostPorts: Map<number, number>;
}

export function isProbeFree(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const server = createServer();
  server.once("error", () => {
    server.close(() => resolve(false));
  });
  server.listen(port, "0.0.0.0", () => {
    server.close(() => resolve(true));
  });
  return promise;
}

function createStackHandle(
  decl: NormalizedStackDecl,
  appliers: Map<string, ContainerApplier[]>,
): StackHandle {
  let upFlag = false;
  let storedEnv: Record<string, string> | undefined;
  let live = new Map<string, LiveService>();
  let preUpEnv: Record<string, string | undefined> = {};

  async function stopAll(containers: StartedTestContainer[]): Promise<void> {
    for (const container of [...containers].reverse()) {
      try {
        await container.stop();
      } catch {}
    }
  }

  function restoreEnv(snapshot: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  async function allocatePorts(
    service: string,
    svc: NormalizedServiceDecl,
    effectiveDefault: PortRange | undefined,
    claimed: Set<number>,
  ): Promise<number[]> {
    const tentative: number[] = [];
    for (const p of svc.ports) {
      const range = p.range ?? effectiveDefault;
      if (range === undefined) {
        throw new MissingPortRangeError(service, p.container);
      }
      let host: number | undefined;
      for (let port = range[0]; port <= range[1]; port += 1) {
        if (claimed.has(port)) {
          continue;
        }
        if (await isProbeFree(port)) {
          host = port;
          break;
        }
      }
      if (host === undefined) {
        throw new NoFreePortInRangeError(service, p.container, [
          range[0],
          range[1],
        ]);
      }
      claimed.add(host);
      tentative.push(host);
    }
    return tentative;
  }

  async function recheckTaken(hosts: number[]): Promise<boolean> {
    for (const host of hosts) {
      if (!(await isProbeFree(host))) {
        return true;
      }
    }
    return false;
  }

  async function startService(
    service: string,
    svc: NormalizedServiceDecl,
    effectiveDefault: PortRange | undefined,
    claimed: Set<number>,
  ): Promise<StartedTestContainer> {
    let tentative = await allocatePorts(
      service,
      svc,
      effectiveDefault,
      claimed,
    );
    for (;;) {
      const container = new GenericContainer(svc.image)
        .withExposedPorts(
          ...svc.ports.map((p, i) => {
            const host = tentative[i];
            if (host === undefined) {
              throw new Error(
                `Missing allocated host port for service "${service}" container port ${p.container}`,
              );
            }
            return {
              container: p.container,
              host,
            };
          }),
        )
        .withEnvironment(svc.env);
      if (svc.waitFor !== undefined) {
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
            claimed,
          );
          continue;
        }
        throw err;
      }
    }
  }

  async function up(opts?: UpOptions): Promise<Record<string, string>> {
    if (upFlag) {
      throw new StackAlreadyUpError();
    }
    if (opts?.defaultRange !== undefined) {
      assertValidRange(opts.defaultRange);
    }
    const effectiveDefault = opts?.defaultRange ?? decl.defaultRange;

    const entrySnapshot: Record<string, string | undefined> = {};
    for (const key of Object.keys(decl.env)) {
      entrySnapshot[key] = process.env[key];
    }

    const claimed = new Set<number>();
    const started: StartedTestContainer[] = [];
    const hostOf = new Map<string, string>();
    const portMaps = new Map<string, Map<number, number>>();
    let failed = true;

    try {
      for (const service of decl.serviceOrder) {
        const svc = decl.services[service];
        if (!svc) {
          throw new InvalidServiceDeclError(
            service,
            `service "${service}" is missing from declaration`,
          );
        }
        const container = await startService(
          service,
          svc,
          effectiveDefault,
          claimed,
        );
        started.push(container);
        hostOf.set(service, container.getHost());
        const perService = new Map<number, number>();
        for (const p of svc.ports) {
          perService.set(p.container, container.getMappedPort(p.container));
        }
        portMaps.set(service, perService);
      }

      const templateCtx: TemplateContext = {
        serviceNames: decl.serviceOrder,
        hostOf: (s: string) => {
          const h = hostOf.get(s);
          if (h === undefined) {
            throw new UnknownServiceError({ service: s });
          }
          return h;
        },
        exposes: (s: string, port: number) => {
          const svcDecl = decl.services[s];
          if (!svcDecl) {
            return false;
          }
          return svcDecl.ports.some((p) => p.container === port);
        },
        portOf: (s: string, port: number) => {
          const pm = portMaps.get(s);
          if (!pm) {
            throw new UnknownServiceError({ service: s });
          }
          const mapped = pm.get(port);
          if (mapped === undefined) {
            throw new UnknownPortError(s, port);
          }
          return mapped;
        },
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
          if (!container || host === undefined) {
            throw new Error(
              `Service "${service}" failed to initialize completely`,
            );
          }
          return [
            service,
            {
              container,
              host,
              hostPorts: portMaps.get(service) ?? new Map(),
            },
          ];
        }),
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

  async function down(): Promise<void> {
    if (!upFlag) {
      return;
    }
    try {
      const containers = [...live.values()].map((svc) => svc.container);
      live = new Map();
      await stopAll(containers);
    } finally {
      restoreEnv(preUpEnv);
      preUpEnv = {};
      upFlag = false;
    }
  }

  function hostPort(service: string, containerPort: number): number {
    if (!upFlag) {
      throw new StackNotUpError();
    }
    const svc = live.get(service);
    if (svc === undefined) {
      throw new UnknownServiceError({ service });
    }
    const port = svc.hostPorts.get(containerPort);
    if (port === undefined) {
      throw new UnknownPortError(service, containerPort);
    }
    return port;
  }

  function mappings(): ServiceMapping[] {
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
          host,
        })),
      };
    });
  }

  return {
    up,
    down,
    get env(): Record<string, string> | undefined {
      return storedEnv === undefined ? undefined : { ...storedEnv };
    },
    hostPort,
    mappings,
  };
}
