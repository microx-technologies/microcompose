import { describe, expect, test } from "bun:test";
import {
  AmbiguousPlaceholderError,
  DuplicatePortError,
  defineStack,
  escapeShellSingle,
  InvalidRangeError,
  InvalidServiceDeclError,
  MalformedTemplateError,
  MissingPortRangeError,
  NoFreePortInRangeError,
  resolveTemplates,
  StackAlreadyUpError,
  StackNotUpError,
  UnknownPortError,
  UnknownServiceError,
} from "@/index.ts";

function ctx(
  services: Record<string, { host: string; ports: Record<number, number> }>,
) {
  return {
    serviceNames: Object.keys(services),
    hostOf: (s: string) => {
      const svc = services[s];
      if (!svc) {
        throw new Error(`Unknown service: ${s}`);
      }
      return svc.host;
    },
    exposes: (s: string, port: number) => {
      const svc = services[s];
      if (!svc) {
        return false;
      }
      return port in svc.ports;
    },
    portOf: (s: string, port: number) => {
      const svc = services[s];
      if (!svc) {
        throw new Error(`Unknown service: ${s}`);
      }
      const p = svc.ports[port];
      if (p === undefined) {
        throw new Error(`Unknown port ${port} for service ${s}`);
      }
      return p;
    },
  };
}

describe("declaration validation", () => {
  test("duplicate container ports throw DuplicatePortError", () => {
    try {
      defineStack({
        services: {
          pg: {
            image: "postgres:16",
            ports: [{ container: 5432 }, { container: 5432 }],
          },
        },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicatePortError);
      expect((err as DuplicatePortError).service).toBe("pg");
      expect((err as DuplicatePortError).containerPort).toBe(5432);
    }
  });

  test("bad ranges throw InvalidRangeError", () => {
    for (const range of [
      [0, 10],
      [10, 5],
      [1, 65536],
      [1.5, 10],
      [10],
      [1, 2, 3],
    ] as unknown[]) {
      try {
        defineStack({
          services: { a: { image: "x" } },
          defaultRange: range as [number, number],
        });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidRangeError);
        expect((err as InvalidRangeError).range).toEqual(range);
      }
    }
  });

  test("empty name/image and bad container port throw InvalidServiceDeclError", () => {
    try {
      defineStack({ services: { "": { image: "x" } } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidServiceDeclError);
    }
    try {
      defineStack({ services: { a: { image: "" } } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidServiceDeclError);
      expect((err as InvalidServiceDeclError).reason).toBe(
        'service "a" image must be a non-empty string',
      );
    }
    try {
      defineStack({
        services: { a: { image: "x", ports: [{ container: 0 }] } },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidServiceDeclError);
      expect((err as InvalidServiceDeclError).service).toBe("a");
    }
  });

  test("defineStack is pure: no env mutation, no containers", () => {
    const before = { ...process.env };
    const stack = defineStack({
      services: { pg: { image: "postgres:16", ports: [{ container: 5432 }] } },
      env: { DATABASE_URL: "x" },
    });
    expect(stack.env).toBeUndefined();
    expect(process.env).toEqual(before);
  });

  test("builder reserved methods throw, allowed methods chain", () => {
    const builder = defineStack()
      .service("redis", { image: "redis:7", ports: [{ container: 6379 }] })
      .withCommand(["redis-server"])
      .withStartupTimeout(5_000);
    expect(() =>
      (builder as never as { withName: (n: string) => void }).withName("x"),
    ).toThrow(InvalidServiceDeclError);
    expect(() =>
      (builder as never as { withReuse: () => void }).withReuse(),
    ).toThrow(InvalidServiceDeclError);
    const stack = builder.build();
    expect(stack.env).toBeUndefined();
  });

  test("builder duplicate service and withX-before-service throw", () => {
    const builder = defineStack().service("a", { image: "x" });
    expect(() => builder.service("a", { image: "y" })).toThrow(
      InvalidServiceDeclError,
    );
    expect(() => defineStack().withCommand(["x"])).toThrow(
      InvalidServiceDeclError,
    );
  });
});

describe("template resolver", () => {
  const two = ctx({
    pg: { host: "h1", ports: { 5432: 44001 } },
    redis: { host: "h2", ports: { 6379: 44002 } },
  });
  const one = ctx({ only: { host: "solo", ports: { 5432: 45001 } } });

  test("qualified placeholders resolve", () => {
    expect(
      resolveTemplates(
        {
          DATABASE_URL: "postgresql://u:pw@{{host:pg}}:{{port:pg:5432}}/db",
          REDIS_URL: "redis://{{host:redis}}:{{port:redis:6379}}",
        },
        two,
      ),
    ).toEqual({
      DATABASE_URL: "postgresql://u:pw@h1:44001/db",
      REDIS_URL: "redis://h2:44002",
    });
  });

  test("shorthands resolve when unambiguous", () => {
    expect(resolveTemplates({ A: "{{host}}:{{port:5432}}" }, one)).toEqual({
      A: "solo:45001",
    });
  });

  test("ambiguous shorthands throw with candidates", () => {
    try {
      resolveTemplates({ A: "{{host}}" }, two);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousPlaceholderError);
      expect((err as AmbiguousPlaceholderError).candidates).toEqual([
        "pg",
        "redis",
      ]);
    }
    const both5432 = ctx({
      a: { host: "h1", ports: { 5432: 1 } },
      b: { host: "h2", ports: { 5432: 2 } },
    });
    try {
      resolveTemplates({ A: "{{port:5432}}" }, both5432);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousPlaceholderError);
      expect((err as AmbiguousPlaceholderError).placeholder).toBe(
        "{{port:5432}}",
      );
      expect((err as AmbiguousPlaceholderError).candidates).toEqual(["a", "b"]);
    }
  });

  test("shorthand zero-match is ambiguous with empty candidates", () => {
    try {
      resolveTemplates({ A: "{{port:9999}}" }, two);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousPlaceholderError);
      expect((err as AmbiguousPlaceholderError).candidates).toEqual([]);
    }
  });

  test("unknown service and port errors carry fields", () => {
    try {
      resolveTemplates({ A: "{{host:nope}}" }, two);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownServiceError);
      expect((err as UnknownServiceError).placeholder).toBe("{{host:nope}}");
      expect((err as UnknownServiceError).knownServices).toEqual([
        "pg",
        "redis",
      ]);
    }
    try {
      resolveTemplates({ A: "{{port:pg:9999}}" }, two);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownPortError);
      expect((err as UnknownPortError).service).toBe("pg");
      expect((err as UnknownPortError).containerPort).toBe(9999);
    }
  });

  test("strict malformed set", () => {
    for (const tpl of [
      "{{port:pg}}",
      "{{port:pg:abc}}",
      "{{foo:bar}}",
      "{{}}",
      "{{host:}}",
      "{{port:}}",
      "{{port:pg:}}",
      "{{host:pg}} trailing {{",
      "{{{host}}}",
      "{{port: pg:5432}}",
      "unclosed {{host:pg}} {{oops",
    ]) {
      try {
        resolveTemplates({ K: tpl }, two);
        expect.unreachable(`expected malformed: ${tpl}`);
      } catch (err) {
        expect(err).toBeInstanceOf(MalformedTemplateError);
        expect((err as MalformedTemplateError).key).toBe("K");
        expect((err as MalformedTemplateError).template).toBe(tpl);
      }
    }
  });

  test("escape and dollar passthrough", () => {
    expect(resolveTemplates({ A: "\\{{port:pg:5432}}" }, two)).toEqual({
      A: "{{port:pg:5432}}",
    });
    expect(resolveTemplates({ A: "\\\\{{port:pg:5432}}" }, two)).toEqual({
      A: "\\44001",
    });
    expect(
      resolveTemplates({ A: "\x24{HOME}/$FOO:{{port:pg:5432}}" }, two),
    ).toEqual({
      A: "\x24{HOME}/$FOO:44001",
    });
    expect(resolveTemplates({ A: "back\\slash" }, two)).toEqual({
      A: "back\\slash",
    });
  });
});

describe("up()/down() guards and accessors without Docker", () => {
  test("up with no range throws MissingPortRangeError and is retryable", async () => {
    const stack = defineStack({
      services: { a: { image: "redis:7", ports: [{ container: 6379 }] } },
    });
    const before = { ...process.env };
    try {
      await stack.up();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MissingPortRangeError);
    }
    expect(process.env).toEqual(before);
    expect(stack.env).toBeUndefined();
    await stack.down();
  });

  test("per-port range wins over up() and declaration ranges, then exhausts loudly", async () => {
    const stack = defineStack({
      services: {
        a: {
          image: "redis:7",
          ports: [{ container: 6379, range: [1, 1] as const }],
        },
      },
      defaultRange: [2, 2] as const,
    });
    try {
      await stack.up({ defaultRange: [3, 3] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(NoFreePortInRangeError);
      expect(
        (err as InstanceType<typeof NoFreePortInRangeError>).range,
      ).toEqual([1, 1]);
    }
  });
  test("already-up throws StackAlreadyUpError; not-up hostPort throws first", async () => {
    const stack = defineStack({ services: { ghost: { image: "x" } } });
    try {
      stack.hostPort("ghost", 1234);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StackNotUpError);
    }
    try {
      stack.hostPort("nope", 1);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StackNotUpError);
    }
    expect(stack.env).toBeUndefined();
    await stack.down();
    expect(stack.env).toBeUndefined();
  });

  test("returned env maps are copies and down() without up() is a no-op", async () => {
    const stack = defineStack({ services: { a: { image: "x" } } });
    await stack.down();
    expect(stack.env).toBeUndefined();
    expect(StackAlreadyUpError).toBeDefined();
  });
});

describe("manual helpers", () => {
  test("single-quote escaping matches export line format", () => {
    expect(`export K=${escapeShellSingle("a'b")}`).toBe(`export K='a'\\''b'`);
    expect(`export K=${escapeShellSingle("plain")}`).toBe(`export K='plain'`);
  });
});
