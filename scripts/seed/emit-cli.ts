import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { emitSeedJson } from "./emit-json.ts";

interface CliOptions {
  target: string;
  out: string;
}

type ParseResult =
  | { ok: true; options: CliOptions }
  | { ok: false; message: string };

function parseArgv(argv: string[]): ParseResult {
  let target: string | undefined;
  let out: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let flag: "--target" | "--out";
    let value: string | undefined;

    if (argument === "--target" || argument === "--out") {
      flag = argument;
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: `missing value for ${flag}` };
      }
      index += 1;
    } else if (argument.startsWith("--target=")) {
      flag = "--target";
      value = argument.slice("--target=".length);
    } else if (argument.startsWith("--out=")) {
      flag = "--out";
      value = argument.slice("--out=".length);
    } else {
      return { ok: false, message: `unknown argument: ${argument}` };
    }

    if (value.length === 0) {
      return { ok: false, message: `missing value for ${flag}` };
    }
    if (flag === "--target") {
      target = value;
    } else {
      out = value;
    }
  }

  if (target === undefined) {
    return { ok: false, message: "missing required flag: --target" };
  }
  if (out === undefined) {
    return { ok: false, message: "missing required flag: --out" };
  }
  return { ok: true, options: { target, out } };
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  if (!parsed.ok) {
    console.error(parsed.message);
    return 1;
  }

  const { target, out } = parsed.options;
  try {
    const artifact = await emitSeedJson({
      database: target,
      now: new Date(),
      outputPath: out,
    });
    const rows = artifact.tables.reduce(
      (total, table) => total + table.rows.length,
      0,
    );
    console.log(JSON.stringify({
      target: artifact.target,
      out,
      tables: artifact.tables.length,
      rows,
    }));
    return 0;
  } catch (error) {
    let message: string;
    if (error instanceof Error) {
      message = error.message;
    }
    /* v8 ignore start -- all errors thrown by the seed closure are Error instances; this non-Error branch is defensive. */
    else {
      message = String(error);
    }
    /* v8 ignore stop */
    console.error(`emit failed: ${message}`);
    return 1;
  }
}

/* v8 ignore start -- exercised by direct operator invocation, not import-based tests. */
if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
/* v8 ignore stop */
