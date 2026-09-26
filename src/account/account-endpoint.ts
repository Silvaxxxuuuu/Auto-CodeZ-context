export function resolveAccountApiBaseUrl(
  runtimeOverride: string | undefined,
  buildDefault: string | undefined,
): string | undefined {
  const runtime = runtimeOverride?.trim();
  if (runtime) return runtime;

  const bundled = buildDefault?.trim();
  return bundled || undefined;
}
