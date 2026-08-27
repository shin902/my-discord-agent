import path from "node:path";
import { fileURLToPath } from "node:url";
import { NonRetryableError } from "../utils/error.js";
import type { MountConfig } from "./groups.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const RESERVED_CONTAINER_PATHS = ["/workspace", "/sessions"];

/** Build validated Docker volume arguments for one effective mount set. */
export function buildExtraMountArgs(mounts: MountConfig[]): string[] {
  const args: string[] = [];
  for (const mount of mounts) {
    if (
      RESERVED_CONTAINER_PATHS.some(
        (reserved) =>
          mount.container === reserved ||
          mount.container.startsWith(`${reserved}/`),
      )
    ) {
      throw new NonRetryableError(
        `mounts.container は予約済みパス (${RESERVED_CONTAINER_PATHS.join(", ")}) と重複できません: ${mount.container}`,
      );
    }
    const hostPath = path.isAbsolute(mount.host)
      ? mount.host
      : path.join(ROOT, mount.host);
    if (!path.isAbsolute(mount.host)) {
      const rel = path.relative(ROOT, hostPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new NonRetryableError(
          `mounts.host はリポジトリルート外を指しています: ${mount.host}`,
        );
      }
    }
    const suffix = mount.readOnly ? ":ro" : "";
    args.push("-v", `${hostPath}:${mount.container}${suffix}`);
  }
  return args;
}
