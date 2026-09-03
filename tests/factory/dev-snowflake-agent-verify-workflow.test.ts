import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const WORKFLOW_PATH = fileURLToPath(
  new URL(
    "../../.github/workflows/dev-snowflake-agent-verify.yml",
    import.meta.url,
  ),
);
const source = readFileSync(WORKFLOW_PATH, "utf8");
const document = parseDocument(source);

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected mapping");
  }
  return value as Mapping;
}

expect(document.errors).toEqual([]);
const workflow = mapping(document.toJS());
const jobs = mapping(workflow.jobs);
const agentVerify = mapping(jobs["agent-verify"]);
const rawSteps = agentVerify.steps;
if (!Array.isArray(rawSteps)) throw new Error("agent-verify has no steps");
const steps = rawSteps.map(mapping);

function stepById(id: string): Mapping {
  const step = steps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`missing step ${id}`);
  return step;
}

function stepByName(name: string): Mapping {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`missing step ${name}`);
  return step;
}

function runBody(step: Mapping): string {
  if (typeof step.run !== "string") throw new Error("step has no run body");
  return step.run;
}

const principalEnv = {
  SNOWFLAKE_ACCOUNT: "${{ vars.SNOWFLAKE_ACCOUNT }}",
  SNOWFLAKE_USER: "ROASTPILOT_AGENT_CI",
  SNOWFLAKE_ROLE: "ROASTPILOT_AGENT",
  SNOWFLAKE_WAREHOUSE: "ROASTPILOT_WH",
  SNOWFLAKE_DATABASE: "ROASTPILOT_DEV",
  SNOWFLAKE_AGENT_PRIVATE_KEY: "${{ secrets.SNOWFLAKE_AGENT_PRIVATE_KEY }}",
  SNOWFLAKE_AGENT_PRIVATE_KEY_PASSPHRASE:
    "${{ secrets.SNOWFLAKE_AGENT_PRIVATE_KEY_PASSPHRASE }}",
};

const verifierScript = `set -euo pipefail
umask 077
KEY_FILE="$(mktemp)"
trap 'rm -f "$KEY_FILE"' EXIT
printf '%s' "$SNOWFLAKE_AGENT_PRIVATE_KEY" > "$KEY_FILE"
export SNOWFLAKE_PRIVATE_KEY_FILE="$KEY_FILE"
export SNOWFLAKE_PRIVATE_KEY_PASSPHRASE="$SNOWFLAKE_AGENT_PRIVATE_KEY_PASSPHRASE"
# The verifier reads the key file; keep the raw PEM out of the tee'd
# process environment whose output becomes the uploaded artifact.
unset SNOWFLAKE_AGENT_PRIVATE_KEY
python3 upsert_roast_verify_live.py   --target ROASTPILOT_DEV 2>&1 | tee -a "$EVIDENCE"
`;

describe("DEV Snowflake agent verification workflow", () => {
  it("AW-1 is manual-only and delegates the main boundary to the Environment", () => {
    expect(mapping(workflow.on)).toEqual({ workflow_dispatch: {} });
    expect(source).not.toContain("github.ref");
    expect(agentVerify.environment).toBe("dev-snowflake-agent");
    expect(source).toContain("required reviewer approves the");
    expect(source).toContain("Environment-scoped secrets there");
    expect(source).toContain("base-controlled deployment-branch policy permits main only");
  });

  it("AW-2 defaults permissions closed and grants only job-level contents read", () => {
    expect(mapping(workflow.permissions)).toEqual({});
    expect(mapping(agentVerify.permissions)).toEqual({ contents: "read" });
  });

  it("AW-3 serializes non-cancelling dispatches and bounds credential lifetime", () => {
    expect(mapping(workflow.concurrency)).toEqual({
      group: "dev-snowflake-agent",
      "cancel-in-progress": false,
    });
    expect(agentVerify["timeout-minutes"]).toBe(15);
  });

  it("AW-4 preserves the hardened, pinned setup envelope and step order", () => {
    expect(steps.map((step) => step.name)).toEqual([
      "Harden the runner (block all egress except what this job needs)",
      "Checkout roastpilot-cloud",
      "Set up Python",
      "Install schemachange + Snowflake connector dependencies",
      "Assert the live verifier is the fixed agent CI principal",
      "Run the agent-role live verifiers",
      "Upload agent verification evidence",
      "Write summary",
    ]);

    const harden = steps[0];
    expect(harden.uses).toBe(
      "step-security/harden-runner@bf7454d06d71f1098171f2acdf0cd4708d7b5920",
    );
    expect(mapping(harden.with)["egress-policy"]).toBe("block");
    expect(String(mapping(harden.with)["allowed-endpoints"]).trim().split(/\s+/)).toEqual([
      "github.com:443",
      "api.github.com:443",
      "codeload.github.com:443",
      "objects.githubusercontent.com:443",
      "*.actions.githubusercontent.com:443",
      "pypi.org:443",
      "files.pythonhosted.org:443",
      "*.snowflakecomputing.com:443",
      "ocsp.snowflakecomputing.com:80",
    ]);
    expect(steps[1].uses).toBe(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
    );
    expect(mapping(steps[1].with)["persist-credentials"]).toBe(false);
    expect(steps[2].uses).toBe(
      "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1",
    );
    expect(mapping(steps[2].with)["python-version"]).toBe("3.11");
    expect(steps[3].run).toBe("pip install -r snowflake/requirements.txt");
  });

  it("AW-5 runs the in-memory principal guard with the fixed identity", () => {
    const guard = stepById("principal-guard");
    expect(guard["working-directory"]).toBe("snowflake");
    expect(mapping(guard.env)).toEqual(principalEnv);
    expect(guard.run).toBe(
      "python3 -P assert_agent_ci_principal.py --target ROASTPILOT_DEV",
    );
    expect(guard.run).toContain("python3 -P");
    expect(guard.if).toBeUndefined();
    expect(guard["continue-on-error"]).toBeUndefined();
  });

  it("AW-6 runs only the upsert verifier with the same principal and secure key file", () => {
    const verifiers = stepById("run-verifiers");
    expect(verifiers["working-directory"]).toBe("snowflake");
    expect(mapping(verifiers.env)).toEqual({
      ...principalEnv,
      EVIDENCE: "${{ github.workspace }}/agent-verify-evidence.log",
    });
    expect(runBody(verifiers)).toBe(verifierScript);
    expect(runBody(verifiers)).not.toContain("python3 -P");
    expect(runBody(verifiers)).toContain("python3 upsert_roast_verify_live.py");
    expect(runBody(verifiers)).not.toContain("load_telemetry_verify_live.py");
    expect(verifiers["timeout-minutes"]).toBe(10);
    expect(runBody(verifiers)).toContain("set -euo pipefail");
    expect(runBody(verifiers).indexOf("umask 077")).toBeLessThan(
      runBody(verifiers).indexOf('KEY_FILE="$(mktemp)"'),
    );
    expect(runBody(verifiers)).toContain("trap 'rm -f \"$KEY_FILE\"' EXIT");
    expect(runBody(verifiers).indexOf("unset SNOWFLAKE_AGENT_PRIVATE_KEY")).toBeLessThan(
      runBody(verifiers).indexOf("python3 upsert_roast_verify_live.py"),
    );
    expect(source.match(/`-P` is intentionally omitted/g)).toHaveLength(1);
  });

  it("AW-7 makes guard failure skip the verifier step through default propagation", () => {
    const guardIndex = steps.indexOf(stepById("principal-guard"));
    const verifierIndex = steps.indexOf(stepById("run-verifiers"));
    expect(guardIndex).toBeLessThan(verifierIndex);
    expect(stepById("run-verifiers").if).toBeUndefined();
    expect(stepById("run-verifiers")["continue-on-error"]).toBeUndefined();
    expect(agentVerify["continue-on-error"]).toBeUndefined();
  });

  it("AW-8 always retains the verifier evidence for fourteen days", () => {
    const upload = stepByName("Upload agent verification evidence");
    expect(upload.if).toBe("always()");
    expect(upload.uses).toBe(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(mapping(upload.with)).toEqual({
      name: "agent-verify-evidence",
      path: "agent-verify-evidence.log",
      "retention-days": 14,
    });
  });

  it("AW-9 always writes an injection-safe summary of both outcomes", () => {
    const summary = stepByName("Write summary");
    const run = runBody(summary);
    expect(summary.if).toBe("always()");
    expect(mapping(summary.env)).toEqual({
      SUMMARY_DATABASE: "ROASTPILOT_DEV",
      SUMMARY_ROLE: "ROASTPILOT_AGENT",
      SUMMARY_USER: "ROASTPILOT_AGENT_CI",
      SUMMARY_WAREHOUSE: "ROASTPILOT_WH",
    });
    expect(run).toContain("${{ steps.principal-guard.outcome }}");
    expect(run).toContain("${{ steps.run-verifiers.outcome }}");
    expect(run).not.toContain("${{ vars.");
    expect(run).not.toContain("${{ secrets.");
    expect(run).toContain('${SUMMARY_DATABASE}');
    expect(run).toContain('${SUMMARY_ROLE}');
    expect(run).toContain('${SUMMARY_USER}');
    expect(run).toContain('${SUMMARY_WAREHOUSE}');
  });

  it("AW-10 keeps the composed verifier run block valid Bash", () => {
    const syntaxCheck = spawnSync("bash", ["-n"], {
      input: runBody(stepById("run-verifiers")),
      encoding: "utf8",
    });
    expect(syntaxCheck.status, syntaxCheck.stderr).toBe(0);
  });
});
