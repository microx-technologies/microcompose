import type { PortRange, StackHandle } from "@/src/types.ts";

export interface RunManualOptions {
  defaultRange?: PortRange;
}

export function escapeShellSingle(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runManual(
  stack: StackHandle,
  opts?: RunManualOptions,
): Promise<void> {
  let resolved: Record<string, string>;
  try {
    resolved =
      opts?.defaultRange !== undefined
        ? await stack.up({ defaultRange: opts.defaultRange })
        : await stack.up();
  } catch (err) {
    process.stderr.write(`${String(err)}\n`);
    try {
      await stack.down();
    } catch {
    }
    process.exitCode = 1;
    return;
  }

  for (const [key, value] of Object.entries(resolved)) {
    process.stdout.write(`export ${key}=${escapeShellSingle(value)}\n`);
  }
  process.stderr.write("Stack up. Press Ctrl-C to stop.\n");
  for (const mapping of stack.mappings()) {
    const ports = [...mapping.ports].sort((a, b) => a.container - b.container);
    for (const { container, host } of ports) {
      process.stderr.write(`${mapping.service}: ${container} → ${host}\n`);
    }
  }

  const keepAlive = setInterval(() => {}, 1_000_000);
  const { promise, resolve } = Promise.withResolvers<void>();
  const release = (): void => {
    clearInterval(keepAlive);
    resolve();
  };
  process.once("SIGINT", release);
  process.once("SIGTERM", release);
  await promise;

  try {
    await stack.down();
  } catch (err) {
    process.stderr.write(`${String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}
