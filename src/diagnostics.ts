import { inspect } from "node:util";

export function formatError(
  error: unknown,
  ...keys: (string | undefined)[]
): string {
  let details = inspect(error, {
    depth: null,
    colors: false,
    customInspect: false,
  });
  for (const key of keys
    .filter((key): key is string => !!key)
    .sort((a, b) => b.length - a.length)) {
    details = details
      .replaceAll(inspect(key).slice(1, -1), "[REDACTED]")
      .replaceAll(key, "[REDACTED]");
  }
  return details;
}
