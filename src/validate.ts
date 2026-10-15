import type { WaitStrategy } from "testcontainers";
import { z } from "zod";
import {
  DuplicatePortError,
  InvalidRangeError,
  InvalidServiceDeclError,
} from "@/src/errors.ts";

export { InvalidServiceDeclError };

import type { PortRange, StackDecl } from "@/src/types.ts";

export const MIN_PORT = 1;
export const MAX_PORT = 65535;

export function isValidRange(range: unknown): range is PortRange {
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
  return (
    min >= MIN_PORT &&
    max >= MIN_PORT &&
    min <= MAX_PORT &&
    max <= MAX_PORT &&
    min <= max
  );
}

export function assertValidRange(range: unknown): asserts range is PortRange {
  if (!isValidRange(range)) {
    throw new InvalidRangeError(range);
  }
}

const PortRangeSchema = z.custom<PortRange>(
  (v): v is PortRange => isValidRange(v),
  "PortRange must be [min, max] integers with 1 <= min <= max <= 65535",
);

const PortDeclSchema = z.object({
  container: z.unknown(),
  range: PortRangeSchema.optional(),
});

const ServiceDeclSchema = z.object({
  image: z.unknown(),
  ports: z.array(PortDeclSchema).optional(),
  env: z.record(z.string(), z.string()).optional(),
  waitFor: z
    .custom<WaitStrategy>(
      (v): v is WaitStrategy => typeof v === "object" && v !== null,
      "waitFor must be a Testcontainers wait strategy object",
    )
    .optional(),
});

const StackDeclSchema = z.object({
  services: z.record(z.string(), ServiceDeclSchema),
  defaultRange: PortRangeSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
});

function nonEmptyServiceName(raw: string): string {
  if (raw === "") {
    throw new InvalidServiceDeclError(
      raw,
      "service name must be a non-empty string",
    );
  }
  return raw;
}

function checkedImage(service: string, image: unknown): string {
  if (typeof image !== "string" || image === "") {
    throw new InvalidServiceDeclError(
      service,
      `service "${service}" image must be a non-empty string`,
    );
  }
  return image;
}

function checkedContainerPort(service: string, value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_PORT ||
    value > MAX_PORT
  ) {
    throw new InvalidServiceDeclError(
      service,
      `service "${service}" has invalid container port ${String(value)}: must be integer 1-65535`,
    );
  }
  return value;
}

export interface NormalizedPortDecl {
  container: number;
  range?: PortRange;
}

export interface NormalizedServiceDecl {
  image: string;
  ports: NormalizedPortDecl[];
  env: Record<string, string>;
  waitFor?: WaitStrategy;
}

export interface NormalizedStackDecl {
  services: Record<string, NormalizedServiceDecl>;
  serviceOrder: string[];
  defaultRange?: PortRange;
  env: Record<string, string>;
}

export function normalizeStackDecl(input: unknown): NormalizedStackDecl {
  const parsed = StackDeclSchema.safeParse(input);
  if (!parsed.success) {
    throw firstDeclError(input, parsed.error);
  }
  const raw = parsed.data;

  const services: Record<string, NormalizedServiceDecl> = {};
  const serviceOrder: string[] = [];
  for (const [rawName, svc] of Object.entries(raw.services)) {
    const service = nonEmptyServiceName(rawName);
    const image = checkedImage(service, svc.image);
    const seen = new Set<number>();
    const ports: NormalizedPortDecl[] = (svc.ports ?? []).map((p) => {
      const container = checkedContainerPort(service, p.container);
      if (seen.has(container)) {
        throw new DuplicatePortError(service, container);
      }
      seen.add(container);
      const out: NormalizedPortDecl = { container };
      if (p.range !== undefined) {
        out.range = p.range;
      }
      return out;
    });
    const entry: NormalizedServiceDecl = { image, ports, env: svc.env ?? {} };
    if (svc.waitFor !== undefined) {
      entry.waitFor = svc.waitFor;
    }
    services[service] = entry;
    serviceOrder.push(service);
  }

  const out: NormalizedStackDecl = {
    services,
    serviceOrder,
    env: raw.env ?? {},
  };
  if (raw.defaultRange !== undefined) {
    out.defaultRange = raw.defaultRange;
  }
  return out;
}

function firstDeclError(input: unknown, error: z.ZodError): Error {
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
      throw new InvalidRangeError(undefined);
    }
    const envKey =
      typeof path[1] === "string" ? path[1] : String(path[1] ?? "");
    throw new InvalidServiceDeclError(
      envKey,
      `stack env "${envKey}" must map to a string`,
    );
  }

  if (
    path[0] === "services" &&
    typeof path[1] === "string" &&
    "services" in input
  ) {
    const name = path[1];
    const service = name === "" ? "" : name;
    let svc: unknown;
    if (typeof name === "string" || typeof name === "number") {
      const servicesField: unknown = input.services;
      if (
        typeof servicesField === "object" &&
        servicesField !== null &&
        !Array.isArray(servicesField) &&
        name in servicesField
      ) {
        svc = (servicesField as Record<string | number, unknown>)[name];
      }
    }
    const rest = path.slice(2);

    if (rest.length === 0) {
      if (service === "") {
        throw new InvalidServiceDeclError(
          "",
          "service name must be a non-empty string",
        );
      }
      throw new InvalidServiceDeclError(
        service,
        `service "${service}" declaration is invalid`,
      );
    }
    if (rest[0] === "image") {
      throw new InvalidServiceDeclError(
        service,
        `service "${service}" image must be a non-empty string`,
      );
    }
    if (rest[0] === "ports" && typeof rest[1] === "number") {
      let entry: unknown;
      if (
        typeof svc === "object" &&
        svc !== null &&
        "ports" in svc &&
        Array.isArray(svc.ports)
      ) {
        const candidate = svc.ports[rest[1]];
        if (typeof candidate === "object" && candidate !== null) {
          entry = candidate;
        }
      }
      if (rest[2] === "range") {
        const range =
          typeof entry === "object" && entry !== null && "range" in entry
            ? entry.range
            : undefined;
        throw new InvalidRangeError(range);
      }
      const container =
        typeof entry === "object" && entry !== null && "container" in entry
          ? entry.container
          : undefined;
      throw new InvalidServiceDeclError(
        service,
        `service "${service}" has invalid container port ${String(container)}: must be integer 1-65535`,
      );
    }
    if (rest[0] === "ports") {
      throw new InvalidServiceDeclError(
        service,
        `service "${service}" ports must be an array`,
      );
    }
    if (rest[0] === "env") {
      throw new InvalidServiceDeclError(
        service,
        `service "${service}" env values must be strings`,
      );
    }
    if (rest[0] === "waitFor") {
      throw new InvalidServiceDeclError(
        service,
        `service "${service}" waitFor must be a Testcontainers wait strategy object`,
      );
    }
  }

  if (path[0] === "services") {
    throw new InvalidServiceDeclError(
      "",
      "stack services must be a record of service declarations",
    );
  }
  throw new InvalidServiceDeclError("", "stack declaration is invalid");
}

export type { StackDecl };
