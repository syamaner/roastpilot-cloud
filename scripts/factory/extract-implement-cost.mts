/** Extract bounded implement-run cost metadata without blocking publish. */

import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import {
  parseImplementCost,
  UNAVAILABLE_IMPLEMENT_COST,
  type ImplementCost,
} from "./implement-cost-logic.mts";

function summaryLine(cost: ImplementCost): string {
  return cost.costUsd === "" || cost.numTurns === ""
    ? "Implement run cost: unavailable\n"
    : `Implement run cost: $${cost.costUsd} USD across ${cost.numTurns} turns\n`;
}

async function readCost(executionFile: string | undefined): Promise<ImplementCost> {
  if (!executionFile) {
    return UNAVAILABLE_IMPLEMENT_COST;
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(executionFile, "utf8"));
    return parseImplementCost(parsed);
  } catch {
    return UNAVAILABLE_IMPLEMENT_COST;
  }
}

/**
 * Best-effort entrypoint. Every input and filesystem defect degrades to
 * unavailable and is swallowed so cost observability can never block publish.
 */
export async function main(): Promise<void> {
  try {
    const cost = await readCost(process.env.INPUT_EXECUTION_FILE);
    const output = `cost_usd=${cost.costUsd}\nnum_turns=${cost.numTurns}\n`;
    const artifact =
      cost.costUsd === "" || cost.numTurns === ""
        ? '{"cost_usd":null,"num_turns":null}'
        : `{"cost_usd":${cost.costUsd},"num_turns":${cost.numTurns}}`;

    // The workspace was agent-writable before this trusted step. Remove any
    // pre-existing file, directory, or symlink so upload-artifact can only see
    // the bounded regular file this extractor creates.
    await rm("cost.json", { recursive: true, force: true });
    await writeFile("cost.json", `${artifact}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await Promise.all([
      process.env.GITHUB_OUTPUT
        ? appendFile(process.env.GITHUB_OUTPUT, output, "utf8")
        : Promise.resolve(),
      process.env.GITHUB_STEP_SUMMARY
        ? appendFile(process.env.GITHUB_STEP_SUMMARY, summaryLine(cost), "utf8")
        : Promise.resolve(),
    ]);
  } catch {
    // Exit 0 deliberately: even an output/summary/artifact write failure is
    // observability-only and must not block the publish job.
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
