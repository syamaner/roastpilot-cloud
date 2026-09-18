import { checkBotId } from "botid/server";

export type BotDecision =
  | { allowed: true }
  | { allowed: false; reason: "bot" | "fail_closed" };

export async function verifyWriteRequest(): Promise<BotDecision> {
  try {
    const verdict = await checkBotId();
    if (verdict.isBot === false && verdict.isVerifiedBot === false) {
      return { allowed: true };
    }
    if (verdict.isBot === true || verdict.isVerifiedBot === true) {
      return { allowed: false, reason: "bot" };
    }
  } catch {
    // Detector failures must never admit a write to the warehouse.
  }

  console.error(JSON.stringify({ event: "botid_fail_closed", reason: "fail_closed" }));
  return { allowed: false, reason: "fail_closed" };
}
