import { WaitStrategy, Labels, HealthCheck, ImagePullPolicy, FileToCopy, ContentToCopy, CopyToContainerOptions, Environment } from 'testcontainers';
import { Readable } from 'node:stream';
import { TmpFs, Ulimits, ExtraHost, BindMount, ResourcesQuota, DirectoryToCopy } from 'testcontainers/build/types.js';

declare class InvalidRangeError extends Error {
    readonly range: unknown;
    constructor(range: unknown);
}
declare class DuplicatePortError extends Error {
    readonly service: string;
    readonly containerPort: number;
    constructor(service: string, containerPort: number);
}
declare class MissingPortRangeError extends Error {
    readonly service: string;
    readonly containerPort: number;
    constructor(service: string, containerPort: number);
}
declare class NoFreePortInRangeError extends Error {
    readonly service: string;
    readonly containerPort: number;
    readonly range: readonly [number, number];
    constructor(service: string, containerPort: number, range: readonly [number, number]);
}
interface UnknownServiceErrorFields {
    placeholder?: string;
    knownServices?: string[];
    service?: string;
}
declare class UnknownServiceError extends Error {
    readonly placeholder?: string;
    readonly knownServices?: string[];
    readonly service?: string;
    constructor(fields: UnknownServiceErrorFields);
}
declare class UnknownPortError extends Error {
    readonly service: string;
    readonly containerPort: number;
    constructor(service: string, containerPort: number);
}
declare class AmbiguousPlaceholderError extends Error {
    readonly placeholder: string;
    readonly candidates: string[];
    constructor(placeholder: string, candidates: string[]);
}
declare class MalformedTemplateError extends Error {
    readonly key: string;
    readonly template: string;
    constructor(key: string, template: string);
}
declare class StackAlreadyUpError extends Error {
    constructor();
}
declare class StackNotUpError extends Error {
    constructor();
}
declare class InvalidServiceDeclError extends Error {
    readonly service: string;
    readonly reason: string;
    constructor(service: string, reason: string);
}

type PortRange = readonly [min: number, max: number];
interface PortDecl {
    container: number;
    range?: PortRange;
}
interface ServiceDecl {
    image: string;
    ports?: PortDecl[];
    env?: Record<string, string>;
    waitFor?: WaitStrategy;
}
type ServiceOptions = ServiceDecl;
interface StackDecl {
    services: Record<string, ServiceDecl>;
    defaultRange?: PortRange;
    env?: Record<string, string>;
}
interface ServicePortMapping {
    container: number;
    host: number;
}
interface ServiceMapping {
    service: string;
    host: string;
    ports: ServicePortMapping[];
}
interface UpOptions {
    defaultRange?: PortRange;
}
interface StackHandle {
    up(opts?: UpOptions): Promise<Record<string, string>>;
    down(): Promise<void>;
    readonly env: Record<string, string> | undefined;
    hostPort(service: string, containerPort: number): number;
    mappings(): ServiceMapping[];
}

interface RunManualOptions {
    defaultRange?: PortRange;
}
declare function escapeShellSingle(value: string): string;
declare function runManual(stack: StackHandle, opts?: RunManualOptions): Promise<void>;

interface NormalizedPortDecl {
    container: number;
    range?: PortRange;
}
interface NormalizedServiceDecl {
    image: string;
    ports: NormalizedPortDecl[];
    env: Record<string, string>;
    waitFor?: WaitStrategy;
}

declare class StackBuilder {
    private readonly services;
    private readonly order;
    private current;
    private defaultRangeValue?;
    private envValue;
    service(name: string, opts: {
        image: string;
        ports?: {
            container: number;
            range?: PortRange;
        }[];
        env?: Record<string, string>;
        waitFor?: NormalizedServiceDecl["waitFor"];
    }): this;
    env(vars: Record<string, string>): this;
    defaultRange(range: PortRange): this;
    withCommand(command: string[]): this;
    withEntrypoint(entrypoint: string[]): this;
    withLabels(labels: Labels): this;
    withPlatform(platform: string): this;
    withTmpFs(tmpFs: TmpFs): this;
    withUlimits(ulimits: Ulimits): this;
    withSecurityOpt(...securityOptions: string[]): this;
    withAddedCapabilities(...capabilities: string[]): this;
    withDroppedCapabilities(...capabilities: string[]): this;
    withExtraHosts(extraHosts: ExtraHost[]): this;
    withBindMounts(bindMounts: BindMount[]): this;
    withHealthCheck(healthCheck: HealthCheck): this;
    withStartupTimeout(startupTimeoutMs: number): this;
    withDefaultLogDriver(): this;
    withPrivilegedMode(): this;
    withUser(user: string): this;
    withPullPolicy(pullPolicy: ImagePullPolicy): this;
    withIpcMode(ipcMode: string): this;
    withWorkingDir(workingDir: string): this;
    withResourcesQuota(resourcesQuota: ResourcesQuota): this;
    withSharedMemorySize(bytes: number): this;
    withLogConsumer(logConsumer: (stream: Readable) => unknown): this;
    withHostname(hostname: string): this;
    withCopyFilesToContainer(_files: FileToCopy[]): this;
    withCopyDirectoriesToContainer(_dirs: DirectoryToCopy[]): this;
    withCopyContentToContainer(_contents: ContentToCopy[]): this;
    withCopyArchivesToContainer(_archives: never[]): this;
    withCopyToContainerOptions(_opts: CopyToContainerOptions): this;
    withName(_name: string): this;
    withNetwork(_network: never): this;
    withNetworkMode(_mode: string): this;
    withNetworkAliases(..._aliases: string[]): this;
    withExposedPorts(..._ports: never[]): this;
    withEnvironment(_env: Environment): this;
    withWaitStrategy(_strategy: never): this;
    withReuse(): this;
    withAutoRemove(_autoRemove: boolean): this;
    withAutoCleanup(_autoCleanup: boolean): this;
    private pushApplier;
    build(): StackHandle;
}
declare function defineStack(decl: StackDecl): StackHandle;
declare function defineStack(): StackBuilder;
declare function isProbeFree(port: number): Promise<boolean>;

interface TemplateContext {
    serviceNames: string[];
    hostOf(service: string): string;
    exposes(service: string, containerPort: number): boolean;
    portOf(service: string, containerPort: number): number;
}
declare function resolveTemplates(templates: Record<string, string>, ctx: TemplateContext): Record<string, string>;

export { AmbiguousPlaceholderError, DuplicatePortError, InvalidRangeError, InvalidServiceDeclError, MalformedTemplateError, MissingPortRangeError, NoFreePortInRangeError, StackAlreadyUpError, StackBuilder, StackNotUpError, UnknownPortError, UnknownServiceError, defineStack, escapeShellSingle, isProbeFree, resolveTemplates, runManual };
export type { PortDecl, PortRange, RunManualOptions, ServiceDecl, ServiceMapping, ServiceOptions, ServicePortMapping, StackDecl, StackHandle, TemplateContext, UnknownServiceErrorFields, UpOptions };
