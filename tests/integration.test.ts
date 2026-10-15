import { type ChildProcess, spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { afterAll, assert, describe, expect, it } from "vitest";
import {
  AmbiguousPlaceholderError,
  defineStack,
  MissingPortRangeError,
  NoFreePortInRangeError,
  StackAlreadyUpError,
  type StackHandle,
} from "@/index.ts";

const INTEGRATION = process.env.MICROCOMPOSE_INTEGRATION === "1";

const tracked: StackHandle[] = [];
afterAll(async () => {
  for (const stack of tracked.splice(0)) {
    await stack.down();
  }
});

function track(stack: StackHandle): StackHandle {
  tracked.push(stack);
  return stack;
}

function tcpConnects(port: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const socket = connect(port, "127.0.0.1");
  socket.once("connect", () => {
    socket.end();
    resolve();
  });
  socket.once("error", (err) => reject(err));
  return promise;
}

function firstStdoutLine(proc: ChildProcess): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const { stdout } = proc;
  if (!stdout) {
    reject(new Error("proc.stdout is not readable"));
    return promise;
  }
  let buf = "";
  stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    const nl = buf.indexOf("\n");
    if (nl !== -1) {
      resolve(buf.slice(0, nl));
    }
  });
  proc.on("error", reject);
  proc.on("exit", () => reject(new Error("subprocess exited before printing")));
  return promise;
}

async function run(cmd: string, args: string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (!proc.stdout || !proc.stderr) {
    reject(new Error("subprocess stdio is not readable"));
    return promise;
  }
  const { stdout, stderr } = proc;
  let out = "";
  let err = "";
  stdout.on("data", (c: Buffer) => {
    out += c.toString();
  });
  stderr.on("data", (c: Buffer) => {
    err += c.toString();
  });
  proc.on("close", (code) => {
    if (code === 0) {
      resolve(out);
    } else {
      reject(new Error(`${cmd} exited ${code}: ${err}`));
    }
  });
  return promise;
}

async function microcomposeLeaks(): Promise<string[]> {
  const ps = await run("docker", ["ps", "--format", "{{.Names}} {{.Labels}}"]);
  return ps
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("org.testcontainers.sessionId"));
}

async function waitExit(proc: ChildProcess): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let done = false;
  const finish = (): void => {
    if (!done) {
      done = true;
      resolve();
    }
  };
  proc.on("exit", finish);
  proc.on("close", finish);
  proc.on("error", finish);
  await promise;
}

describe.skipIf(!INTEGRATION)("microcompose integration", () => {
  it("A6 missing range throws before containers start", async () => {
    const stack = track(
      defineStack({
        services: { a: { image: "redis:7", ports: [{ container: 6379 }] } },
      }),
    );
    await expect(stack.up()).rejects.toThrow(MissingPortRangeError);
  });

  it("A4/A7 single redis lifecycle", async () => {
    const KEY = "MICROCOMPOSE_TEST_URL";
    const ABSENT = "MICROCOMPOSE_TEST_ABSENT";
    delete process.env[ABSENT];
    process.env[KEY] = "before";
    const stack = track(
      defineStack({
        defaultRange: [43100, 43199],
        services: { redis: { image: "redis:7", ports: [{ container: 6379 }] } },
        env: {
          [KEY]: "redis://{{host:redis}}:{{port:redis:6379}}",
          [ABSENT]: "v:\x24{HOME}:$FOO",
        },
      }),
    );
    const resolved = await stack.up();
    try {
      expect(process.env[ABSENT]).toBe("v:\x24{HOME}:$FOO");
      expect(resolved[ABSENT]).toBe("v:\x24{HOME}:$FOO");
      const port = stack.hostPort("redis", 6379);
      expect(port >= 43100 && port <= 43199).toBe(true);
      const firstMapping = stack.mappings()[0];
      if (!firstMapping) {
        throw new Error("Missing service mapping");
      }
      expect(resolved[KEY]).toBe(`redis://${firstMapping.host}:${port}`);
      await tcpConnects(port);
      await expect(stack.up()).rejects.toThrow(StackAlreadyUpError);
    } finally {
      await stack.down();
    }
    expect(process.env[KEY]).toBe("before");
    expect(ABSENT in process.env).toBe(false);
  });

  it("A5 ambiguity, qualified resolves", async () => {
    const stack = track(
      defineStack({
        defaultRange: [43200, 43299],
        services: {
          a: { image: "redis:7", ports: [{ container: 6379 }] },
          b: { image: "redis:7", ports: [{ container: 6379 }] },
        },
        env: { X: "{{port:6379}}" },
      }),
    );
    await expect(stack.up()).rejects.toThrow(AmbiguousPlaceholderError);
    await stack.down();
  });

  it("A3 size-1 exhaustion leaks nothing", { timeout: 120_000 }, async () => {
    const holder = track(
      defineStack({
        defaultRange: [43300, 43300],
        services: { redis: { image: "redis:7", ports: [{ container: 6379 }] } },
      }),
    );
    await holder.up();
    const before = { ...process.env };
    const contender = track(
      defineStack({
        defaultRange: [43300, 43300],
        services: { redis: { image: "redis:7", ports: [{ container: 6379 }] } },
      }),
    );
    try {
      await contender.up();
      assert.fail("expected NoFreePortInRangeError");
    } catch (err) {
      expect(err).toBeInstanceOf(NoFreePortInRangeError);
      const noPort = err as NoFreePortInRangeError;
      expect(noPort.service).toBe("redis");
      expect(noPort.containerPort).toBe(6379);
      expect(noPort.range).toEqual([43300, 43300]);
    }
    expect({ ...process.env }).toEqual(before);
    await holder.down();
    const retry = await contender.up();
    expect(Object.keys(retry)).toEqual([]);
    await contender.down();
    expect(await microcomposeLeaks()).toEqual([]);
  });

  it("A2 no reuse while live, distinct within stack", {
    timeout: 180_000,
  }, async () => {
    const decl = {
      defaultRange: [43400, 43499] as const,
      services: {
        pg: {
          image: "postgres:16",
          ports: [{ container: 5432 }],
          env: { POSTGRES_PASSWORD: "pw" },
        },
        redis: { image: "redis:7", ports: [{ container: 6379 }] },
      },
      env: {
        DATABASE_URL: "postgresql://u:pw@{{host:pg}}:{{port:pg:5432}}/db",
      },
    };
    const first = track(defineStack(decl));
    const second = track(defineStack(decl));
    const r1 = await first.up();
    const r2 = await second.up();
    try {
      expect(r1.DATABASE_URL).not.toBe(r2.DATABASE_URL);
      const ports = [
        first.hostPort("pg", 5432),
        first.hostPort("redis", 6379),
        second.hostPort("pg", 5432),
        second.hostPort("redis", 6379),
      ];
      expect(new Set(ports).size).toBe(4);
      await tcpConnects(first.hostPort("redis", 6379));
      await tcpConnects(second.hostPort("redis", 6379));
    } finally {
      await first.down();
      await second.down();
    }
  });

  it("A1 two processes side-by-side", {
    timeout: 180_000,
  }, async () => {
    const helperSrc = `
      import { defineStack } from "../dist/index.js";
      const stack = defineStack({
        defaultRange: [43500, 43599],
        services: { redis: { image: "redis:7", ports: [{ container: 6379 }] } },
        env: { REDIS_URL: "redis://{{host:redis}}:{{port:redis:6379}}" },
      });
      const resolved = await stack.up();
      console.log(JSON.stringify({ url: resolved.REDIS_URL, port: stack.hostPort("redis", 6379) }));
      process.on("SIGTERM", () => {
        void stack.down().then(() => process.exit(0));
      });
      setInterval(() => {}, 1000);
    `;
    await writeFile("tests/__side1.mjs", helperSrc);
    await writeFile("tests/__side2.mjs", helperSrc);
    try {
      const p1 = spawn(process.execPath, ["tests/__side1.mjs"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const p2 = spawn(process.execPath, ["tests/__side2.mjs"], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const [l1, l2] = await Promise.all([
        firstStdoutLine(p1),
        firstStdoutLine(p2),
      ]);
      const r1 = JSON.parse(l1) as { url: string; port: number };
      const r2 = JSON.parse(l2) as { url: string; port: number };
      expect(r1.port).not.toBe(r2.port);
      expect(r1.url).not.toBe(r2.url);
      await tcpConnects(r1.port);
      await tcpConnects(r2.port);
      p1.kill("SIGTERM");
      p2.kill("SIGTERM");
      await Promise.all([waitExit(p1), waitExit(p2)]);
      expect(await microcomposeLeaks()).toEqual([]);
    } finally {
      await rm("tests/__side1.mjs", { force: true });
      await rm("tests/__side2.mjs", { force: true });
    }
  });

  it("A8 runManual stdout/stderr contract and SIGINT exit", {
    timeout: 180_000,
  }, async () => {
    const script = `
      import { defineStack, runManual } from "../dist/index.js";
      const stack = defineStack({
        defaultRange: [43600, 43699],
        services: { redis: { image: "redis:7", ports: [{ container: 6379 }] } },
        env: { REDIS_URL: "redis://{{host:redis}}:{{port:redis:6379}}" },
      });
      await runManual(stack);
    `;
    await writeFile("tests/__manual.mjs", script);
    let proc: ChildProcess | undefined;
    try {
      proc = spawn(process.execPath, ["tests/__manual.mjs"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!proc.stderr || !proc.stdout) {
        throw new Error("Missing stdio streams on spawned process");
      }
      const stderr = proc.stderr;
      const stdout = proc.stdout;
      let stderrBuf = "";
      stderr.on("data", (c: Buffer) => {
        stderrBuf += c.toString();
      });
      let stdoutRest = "";
      stdout.on("data", (c: Buffer) => {
        stdoutRest += c.toString();
      });
      const firstLine = await firstStdoutLine(proc);
      expect(firstLine.startsWith("export REDIS_URL='redis://")).toBe(true);
      proc.kill("SIGINT");
      const { promise, resolve } = Promise.withResolvers<number | null>();
      const child: ChildProcess = proc;
      child.on("close", resolve);
      const code: number | null = await promise;
      expect(code).toBe(0);
      expect(stderrBuf.includes("Stack up. Press Ctrl-C to stop.")).toBe(true);
      expect(stderrBuf).toMatch(/redis: 6379 → \d+/);
      for (const line of `${firstLine}\n${stdoutRest}`
        .split("\n")
        .filter(Boolean)) {
        expect(
          line.startsWith("export "),
          `stdout carries only export lines, got: ${line}`,
        ).toBe(true);
      }
    } finally {
      proc?.kill("SIGKILL");
      await rm("tests/__manual.mjs", { force: true });
    }
  });
});
