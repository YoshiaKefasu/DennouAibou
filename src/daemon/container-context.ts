export function resolveDaemonContainerContext(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.DENNOU_CONTAINER_HINT?.trim() || env.DENNOU_CONTAINER?.trim() || null;
}
