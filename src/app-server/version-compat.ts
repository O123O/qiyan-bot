import { AppError } from "../core/errors.ts";

type NumericVersion = readonly [number, number, number];

export function requireMinimumCodexVersion(userAgent: string | undefined, minimum: string): string {
  const required = parseExact(minimum);
  if (!required) throw new TypeError("invalid minimum Codex version");
  const match = /\/(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?=$|[-+\s(])/u.exec(userAgent ?? "");
  if (!match) throw new AppError("UNSUPPORTED_CAPABILITY", `could not determine Codex app-server version; requires ${minimum} or newer`);
  const actual = tuple(match[1]!, match[2]!, match[3]!);
  const rendered = actual.join(".");
  if (compare(actual, required) < 0) {
    throw new AppError("UNSUPPORTED_CAPABILITY", `requires Codex app-server ${minimum} or newer; received ${rendered}`);
  }
  return rendered;
}

function parseExact(value: string): NumericVersion | undefined {
  const match = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/u.exec(value);
  return match ? tuple(match[1]!, match[2]!, match[3]!) : undefined;
}

function tuple(major: string, minor: string, patch: string): NumericVersion {
  return [Number(major), Number(minor), Number(patch)];
}

function compare(left: NumericVersion, right: NumericVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]! ? -1 : 1;
  }
  return 0;
}
