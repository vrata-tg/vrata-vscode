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
    const singleQuoted =
      quoted[0] === "'" ? escaped : escaped.replaceAll("'", "\\'");
    details = details
      .replaceAll(singleQuoted, "[REDACTED]")
      .replaceAll(escaped, "[REDACTED]")
      .replaceAll(key, "[REDACTED]");
  }
  return details;
}

export function diagnosticReport(values: {
  editorVersion: string;
  extensionVersion: string;
  modelId?: string;
  code?: string;
  requestId?: string;
}): string {
  const version = (value: string) =>
    /^[a-zA-Z0-9.+-]{1,40}$/.test(value) ? value : "недоступно";
  const lines = [
    `VS Code: ${version(values.editorVersion)}`,
    `Врата AI: ${version(values.extensionVersion)}`,
  ];
  if (values.modelId && /^[a-zA-Z0-9._:-]{1,300}$/.test(values.modelId))
    lines.push(`Модель: ${values.modelId}`);
  if (values.code && /^[a-z_]{1,40}$/.test(values.code))
    lines.push(`Код: ${values.code}`);
  if (values.requestId && /^[0-9a-f-]{36}$/i.test(values.requestId))
    lines.push(`Request ID: ${values.requestId}`);
  return lines.join("\n");
}
