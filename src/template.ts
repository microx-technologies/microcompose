import {
  AmbiguousPlaceholderError,
  MalformedTemplateError,
  UnknownPortError,
  UnknownServiceError,
} from "@/src/errors.ts";

export interface TemplateContext {
  serviceNames: string[];
  hostOf(service: string): string;
  exposes(service: string, containerPort: number): boolean;
  portOf(service: string, containerPort: number): number;
}

const DIGITS = /^\d+$/;
const WHITESPACE = /\s/;

export function resolveTemplates(
  templates: Record<string, string>,
  ctx: TemplateContext,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, template] of Object.entries(templates)) {
    resolved[key] = resolveOne(key, template, ctx);
  }
  return resolved;
}

function resolveOne(
  key: string,
  template: string,
  ctx: TemplateContext,
): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c === "\\" && template[i + 1] === "\\") {
      out += "\\";
      i += 2;
    } else if (
      c === "\\" &&
      template[i + 1] === "{" &&
      template[i + 2] === "{"
    ) {
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

function resolvePlaceholder(
  key: string,
  template: string,
  inner: string,
  ctx: TemplateContext,
): string {
  if (
    inner === "" ||
    inner.includes("{") ||
    inner.includes("}") ||
    WHITESPACE.test(inner)
  ) {
    throw new MalformedTemplateError(key, template);
  }
  const placeholder = `{{${inner}}}`;
  const parts = inner.split(":");

  const [p0, p1, p2] = parts;

  if (parts.length === 1 && p0 === "host") {
    const firstService = ctx.serviceNames[0];
    if (ctx.serviceNames.length === 1 && firstService !== undefined) {
      return ctx.hostOf(firstService);
    }
    throw new AmbiguousPlaceholderError(placeholder, [...ctx.serviceNames]);
  }

  if (parts.length === 2 && p0 === "host" && p1 !== undefined && p1 !== "") {
    if (!ctx.serviceNames.includes(p1)) {
      throw new UnknownServiceError({
        placeholder,
        knownServices: [...ctx.serviceNames],
      });
    }
    return ctx.hostOf(p1);
  }

  if (
    parts.length === 2 &&
    p0 === "port" &&
    p1 !== undefined &&
    DIGITS.test(p1)
  ) {
    const containerPort = Number(p1);
    const matching = ctx.serviceNames.filter((s) =>
      ctx.exposes(s, containerPort),
    );
    const firstMatching = matching[0];
    if (matching.length === 1 && firstMatching !== undefined) {
      return String(ctx.portOf(firstMatching, containerPort));
    }
    throw new AmbiguousPlaceholderError(placeholder, matching);
  }

  if (
    parts.length === 3 &&
    p0 === "port" &&
    p1 !== undefined &&
    p1 !== "" &&
    p2 !== undefined &&
    DIGITS.test(p2)
  ) {
    const service = p1;
    const containerPort = Number(p2);
    if (!ctx.serviceNames.includes(service)) {
      throw new UnknownServiceError({
        placeholder,
        knownServices: [...ctx.serviceNames],
      });
    }
    if (!ctx.exposes(service, containerPort)) {
      throw new UnknownPortError(service, containerPort);
    }
    return String(ctx.portOf(service, containerPort));
  }

  throw new MalformedTemplateError(key, template);
}
