import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLATFORM_PACKAGE = `@mnemon-dev/mnemon-${process.platform}-${process.arch}`;

/**
 * The mnemon binary under test: `MNEMON_TEST_BIN` when set (run the suite once per
 * binary to cover forks and older releases), otherwise the stock native binary that
 * the `@mnemon-dev/mnemon` devDependency installs for this platform.
 */
export function testBinary(): string {
  const fromEnv = process.env["MNEMON_TEST_BIN"];
  if (fromEnv) return fromEnv;
  const bundled = join(import.meta.dir, "..", "node_modules", PLATFORM_PACKAGE, "bin", "mnemon");
  if (existsSync(bundled)) return bundled;
  throw new Error(`No mnemon test binary: set MNEMON_TEST_BIN or run bun install (${PLATFORM_PACKAGE})`);
}

export type TempStore = {
  readonly root: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cleanup: () => void;
};

export function tempStore(): TempStore {
  const root = mkdtempSync(join(tmpdir(), "omo-mnemon-test-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env = { HOME: home, PATH: "/usr/bin:/bin", MNEMON_DATA_DIR: join(root, "data") };
  return { root, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
