/** Fixed Runner network bootstrap; ports come only from host-owned services. */
export function sandboxNetworkArgs(ports: number[]): string[] {
  if (
    ports.length === 0 ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw new Error("Sandbox requires valid proxy ports");
  }
  return [
    "--user",
    "0:0",
    "--cap-drop=ALL",
    "--cap-add=NET_ADMIN",
    "--cap-add=SETUID",
    "--cap-add=SETGID",
    "--cap-add=SETPCAP",
    "--security-opt=no-new-privileges",
    "--network=bridge",
    "--dns=127.0.0.1",
    "--entrypoint=/bin/sh",
    "--add-host=host.docker.internal:host-gateway",
    "-e",
    `SANDBOX_UID=${process.getuid?.()}`,
    "-e",
    `SANDBOX_GID=${process.getgid?.()}`,
    "-e",
    `SANDBOX_PROXY_PORTS=${[...new Set(ports)].join(" ")}`,
  ];
}
