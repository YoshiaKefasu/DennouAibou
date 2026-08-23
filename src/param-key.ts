export function toSnakeCaseKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export function readSnakeCaseParamRaw(params: unknown, key: string): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  if (Object.hasOwn(record, key)) {
    return record[key];
  }
  const snakeKey = toSnakeCaseKey(key);
  if (snakeKey !== key && Object.hasOwn(record, snakeKey)) {
    return record[snakeKey];
  }
  return undefined;
}
