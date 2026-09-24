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
    const quoted = inspect(key);
    const escaped = quoted.slice(1, -1);
    // Surrounding quotes can make inspect use single quotes and escape apostrophes.
    const singleQuoted =
      quoted[0] === "'" ? escaped : escaped.replaceAll("'", "\\'");
    details = details
      .replaceAll(singleQuoted, "[REDACTED]")
      .replaceAll(escaped, "[REDACTED]")
      .replaceAll(key, "[REDACTED]");
  }
  return details;
}
