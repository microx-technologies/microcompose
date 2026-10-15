export class InvalidRangeError extends Error {
  readonly range: unknown;

  constructor(range: unknown) {
    super(
      `Invalid port range: ${JSON.stringify(range)} (expected [min, max] integers with 1 <= min <= max <= 65535)`,
    );
    this.name = "InvalidRangeError";
    this.range = range;
  }
}

export class DuplicatePortError extends Error {
  readonly service: string;
  readonly containerPort: number;

  constructor(service: string, containerPort: number) {
    super(`Duplicate container port ${containerPort} in service "${service}"`);
    this.name = "DuplicatePortError";
    this.service = service;
    this.containerPort = containerPort;
  }
}

export class MissingPortRangeError extends Error {
  readonly service: string;
  readonly containerPort: number;

  constructor(service: string, containerPort: number) {
    super(
      `No port range for ${service}:${containerPort} (provide a per-port range, an up() defaultRange, or a declaration defaultRange)`,
    );
    this.name = "MissingPortRangeError";
    this.service = service;
    this.containerPort = containerPort;
  }
}

export class NoFreePortInRangeError extends Error {
  readonly service: string;
  readonly containerPort: number;
  readonly range: readonly [number, number];

  constructor(
    service: string,
    containerPort: number,
    range: readonly [number, number],
  ) {
    super(
      `No free port in range [${range[0]}, ${range[1]}] for ${service}:${containerPort}`,
    );
    this.name = "NoFreePortInRangeError";
    this.service = service;
    this.containerPort = containerPort;
    this.range = range;
  }
}

export interface UnknownServiceErrorFields {
  placeholder?: string;
  knownServices?: string[];
  service?: string;
}

export class UnknownServiceError extends Error {
  readonly placeholder?: string;
  readonly knownServices?: string[];
  readonly service?: string;

  constructor(fields: UnknownServiceErrorFields) {
    super(
      fields.placeholder !== undefined
        ? `Unknown service in placeholder ${fields.placeholder} (known: ${(fields.knownServices ?? []).join(", ")})`
        : `Unknown service "${fields.service}"`,
    );
    this.name = "UnknownServiceError";
    this.placeholder = fields.placeholder;
    this.knownServices = fields.knownServices;
    this.service = fields.service;
  }
}

export class UnknownPortError extends Error {
  readonly service: string;
  readonly containerPort: number;

  constructor(service: string, containerPort: number) {
    super(
      `Service "${service}" does not expose container port ${containerPort}`,
    );
    this.name = "UnknownPortError";
    this.service = service;
    this.containerPort = containerPort;
  }
}

export class AmbiguousPlaceholderError extends Error {
  readonly placeholder: string;
  readonly candidates: string[];

  constructor(placeholder: string, candidates: string[]) {
    super(
      `Ambiguous placeholder ${placeholder} (matches: ${candidates.join(", ")})`,
    );
    this.name = "AmbiguousPlaceholderError";
    this.placeholder = placeholder;
    this.candidates = candidates;
  }
}

export class MalformedTemplateError extends Error {
  readonly key: string;
  readonly template: string;

  constructor(key: string, template: string) {
    super(`Malformed template in env key "${key}": ${template}`);
    this.name = "MalformedTemplateError";
    this.key = key;
    this.template = template;
  }
}

export class StackAlreadyUpError extends Error {
  constructor() {
    super("Stack is already up (one handle owns one stack; call down() first)");
    this.name = "StackAlreadyUpError";
  }
}

export class StackNotUpError extends Error {
  constructor() {
    super("Stack is not up");
    this.name = "StackNotUpError";
  }
}

export class InvalidServiceDeclError extends Error {
  readonly service: string;
  readonly reason: string;

  constructor(service: string, reason: string) {
    super(`Invalid service declaration "${service}": ${reason}`);
    this.name = "InvalidServiceDeclError";
    this.service = service;
    this.reason = reason;
  }
}
