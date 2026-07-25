import { describe, expect, it } from "vitest";

import {
  MAX_BOUNDARY_ARTIFACT_BYTES,
  analyzeExecutionPolicy,
  type BoundedDataContractEvidence,
  type ExecutionPolicyEvidence,
  type ExecutionPolicyStep,
  type ExecutionSourceEvidence,
} from "../../scripts/factory/execution-policy-logic.mts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

type ProtectedGlueEvidence = Extract<
  ExecutionSourceEvidence,
  { readonly kind: "protected-glue" }
>;
type SnowflakeEvidence = Extract<
  ExecutionSourceEvidence,
  { readonly kind: "trusted-main-snowflake" }
>;

function protectedGlue(
  overrides: Partial<ProtectedGlueEvidence> = {},
): ProtectedGlueEvidence {
  return {
    kind: "protected-glue",
    path: "scripts/factory/publish.mts",
    pathProtected: true,
    revisionOrigin: "event-base-sha",
    expectedSha: SHA_A,
    observedSha: SHA_A,
    restoredObservedShas: [],
    bytesMatchRevisionAtExecution: true,
    ...overrides,
  };
}

function snowflakeSource(
  overrides: Partial<SnowflakeEvidence> = {},
): SnowflakeEvidence {
  return {
    kind: "trusted-main-snowflake",
    path: "snowflake/migrations/V1__bootstrap.sql",
    revisionOrigin: "main-github-sha",
    expectedSha: SHA_A,
    observedSha: SHA_A,
    restoredObservedShas: [],
    bytesMatchRevisionAtExecution: true,
    eventRef: "refs/heads/main",
    environmentApproved: true,
    ...overrides,
  };
}

function boundedContract(
  overrides: Partial<BoundedDataContractEvidence> = {},
): BoundedDataContractEvidence {
  return {
    kind: "bounded",
    format: "json",
    allowedNames: ["artifacts/verdict.json"],
    maxBytes: 64_000,
    rejectUnexpectedNames: true,
    rejectUnexpectedTypes: true,
    rejectSymlinks: true,
    rejectConfiguration: true,
    rejectPlugins: true,
    rejectHooks: true,
    rejectModules: true,
    rejectExecutables: true,
    rejectSensitiveData: true,
    ...overrides,
  };
}

function step(
  id: string,
  runnerId: string,
  credentialReachable: boolean,
  source: ExecutionSourceEvidence,
  runnerTrust: ExecutionPolicyStep["runnerTrust"] = "fresh-github-hosted",
): ExecutionPolicyStep {
  return { id, runnerId, runnerTrust, credentialReachable, source };
}

function analyze(
  steps: readonly ExecutionPolicyStep[],
  crossings: ExecutionPolicyEvidence["crossings"] = [],
) {
  return analyzeExecutionPolicy({
    graphComplete: true,
    steps,
    crossings,
  });
}

describe("analyzeExecutionPolicy source provenance (issue #120 slice 120b)", () => {
  it("accepts exact protected glue selected from trusted context", () => {
    expect(
      analyze([
        step("publish", "runner-publish", true, protectedGlue()),
      ]),
    ).toEqual([]);
  });

  it.each([
    [
      "unsafe repository path",
      protectedGlue({ path: "../scripts/factory/publish.mts" }),
    ],
    [
      "empty repository path",
      protectedGlue({ path: "" }),
    ],
    [
      "absolute repository path",
      protectedGlue({ path: "/scripts/factory/publish.mts" }),
    ],
    [
      "backslash repository path",
      protectedGlue({ path: "scripts\\factory\\publish.mts" }),
    ],
    [
      "NUL repository path",
      protectedGlue({ path: "scripts/factory/\0publish.mts" }),
    ],
    [
      "unprotected glue",
      protectedGlue({ pathProtected: false }),
    ],
    [
      "PR-head revision origin",
      protectedGlue({
        revisionOrigin:
          "pull-request-head-sha" as ProtectedGlueEvidence["revisionOrigin"],
      }),
    ],
    [
      "mismatched checkout SHA",
      protectedGlue({ observedSha: SHA_B }),
    ],
    [
      "non-SHA expected revision",
      protectedGlue({ expectedSha: "main", observedSha: "main" }),
    ],
    [
      "mismatched restored SHA",
      protectedGlue({ restoredObservedShas: [SHA_A, SHA_B] }),
    ],
    [
      "source bytes not verified immediately before execution",
      protectedGlue({ bytesMatchRevisionAtExecution: false }),
    ],
    [
      "non-boolean protected-path evidence",
      protectedGlue({
        pathProtected: "false" as unknown as boolean,
      }),
    ],
    [
      "non-boolean byte-match evidence",
      protectedGlue({
        bytesMatchRevisionAtExecution: "true" as unknown as boolean,
      }),
    ],
  ])("rejects protected glue with %s", (_name, source) => {
    expect(
      analyze([step("publish", "runner-publish", true, source)]),
    ).toEqual([
      expect.objectContaining({
        kind: "invalid-source-provenance",
        subject: "publish",
      }),
    ]);
  });

  it("compares exact revisions case-insensitively", () => {
    expect(
      analyze([
        step(
          "publish",
          "runner-publish",
          true,
          protectedGlue({
            observedSha: SHA_A.toUpperCase(),
            restoredObservedShas: [SHA_A.toUpperCase()],
          }),
        ),
      ]),
    ).toEqual([]);
  });

  it("accepts only the reviewed main Snowflake source class", () => {
    expect(
      analyze([
        step(
          "contract",
          "runner-snowflake",
          true,
          snowflakeSource(),
        ),
      ]),
    ).toEqual([]);
  });

  it.each([
    [
      "source outside snowflake",
      snowflakeSource({ path: "scripts/run-migrations.sh" }),
    ],
    [
      "non-main event",
      snowflakeSource({ eventRef: "refs/pull/12/merge" }),
    ],
    [
      "unapproved environment",
      snowflakeSource({ environmentApproved: false }),
    ],
    [
      "event-base revision origin",
      snowflakeSource({
        revisionOrigin:
          "event-base-sha" as SnowflakeEvidence["revisionOrigin"],
      }),
    ],
    [
      "restored source mismatch",
      snowflakeSource({ restoredObservedShas: [SHA_B] }),
    ],
    [
      "source bytes not verified immediately before execution",
      snowflakeSource({ bytesMatchRevisionAtExecution: false }),
    ],
    [
      "non-boolean environment approval",
      snowflakeSource({
        environmentApproved: "false" as unknown as boolean,
      }),
    ],
  ])("rejects Snowflake trust with %s", (_name, source) => {
    expect(
      analyze([
        step("contract", "runner-snowflake", true, source),
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: "invalid-source-provenance",
        subject: "contract",
      }),
    ]);
  });

  it.each([
    `actions/checkout@${SHA_A}`,
    `github/codeql-action/analyze@${SHA_A}`,
  ])("accepts exact-SHA remote delegation %s", (reference) => {
    expect(
      analyze([
        step("remote", "runner-remote", true, {
          kind: "remote-action",
          reference,
        }),
      ]),
    ).toEqual([]);
  });

  it.each([
    "actions/checkout@v4",
    "actions/checkout@main",
    "actions/checkout@abc123",
    `docker://example/image@sha256:${"a".repeat(64)}`,
    `./.github/actions/local@${SHA_A}`,
    `../shared/action@${SHA_A}`,
    `owner/../action@${SHA_A}`,
  ])("rejects non-exact remote delegation %s", (reference) => {
    expect(
      analyze([
        step("remote", "runner-remote", true, {
          kind: "remote-action",
          reference,
        }),
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: "invalid-source-provenance",
        subject: "remote",
      }),
    ]);
  });
});

describe("analyzeExecutionPolicy runner reachability (issue #120 slice 120b)", () => {
  const mutable = (path = "src/untrusted.mts") =>
    ({
      kind: "mutable-repository",
      path,
    }) satisfies ExecutionSourceEvidence;

  it.each([
    [
      "mutable execution before credentials",
      [
        step("mutable", "shared", false, mutable()),
        step("publish", "shared", true, protectedGlue()),
      ],
    ],
    [
      "mutable execution after credentials",
      [
        step("publish", "shared", true, protectedGlue()),
        step("mutable", "shared", false, mutable()),
      ],
    ],
    [
      "mutable execution directly receives credentials",
      [step("mutable", "shared", true, mutable())],
    ],
  ])("rejects %s on shared runner state", (_name, steps) => {
    expect(analyze(steps)).toEqual([
      {
        kind: "mutable-execution-reaches-credentials",
        subject: "mutable",
        detail:
          'mutable execution shares runner "shared" with reachable credentials',
      },
    ]);
  });

  it("accepts a fresh runner cut without a data crossing", () => {
    expect(
      analyze([
        step("mutable", "runner-untrusted", false, mutable()),
        step(
          "publish",
          "runner-credential",
          true,
          protectedGlue(),
        ),
      ]),
    ).toEqual([]);
  });

  it.each(["persistent-or-unknown"] as const)(
    "rejects a credential runner with %s isolation",
    (runnerTrust) => {
      expect(
        analyze([
          step(
            "publish",
            "runner-credential",
            true,
            protectedGlue(),
            runnerTrust,
          ),
        ]),
      ).toEqual([
        {
          kind: "invalid-evidence",
          subject: "publish",
          detail:
            "credential runner is not proven fresh and GitHub-hosted",
        },
      ]);
    },
  );

  it("does not infer freshness from distinct runner IDs", () => {
    expect(
      analyze([
        step(
          "mutable",
          "self-hosted-job-1",
          false,
          {
            kind: "mutable-repository",
            path: "src/untrusted.mts",
          },
          "persistent-or-unknown",
        ),
        step(
          "publish",
          "self-hosted-job-2",
          true,
          protectedGlue(),
          "persistent-or-unknown",
        ),
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: "invalid-evidence",
        subject: "publish",
      }),
    ]);
  });

  it("rejects contradictory trust within one credential runner", () => {
    expect(
      analyze([
        step(
          "setup",
          "shared",
          false,
          protectedGlue(),
          "persistent-or-unknown",
        ),
        step("publish", "shared", true, protectedGlue()),
      ]),
    ).toEqual([
      {
        kind: "invalid-evidence",
        subject: "setup",
        detail:
          "credential runner is not proven fresh and GitHub-hosted",
      },
    ]);
  });

  it("does not apply the credential policy to an entirely unprivileged runner", () => {
    expect(
      analyze([
        step("first", "runner-untrusted", false, mutable("src/a.mts")),
        step("second", "runner-untrusted", false, mutable("src/b.mts")),
      ]),
    ).toEqual([]);
  });

  it("rejects an invalid mutable repository path before reachability analysis", () => {
    expect(
      analyze([
        step("mutable", "shared", false, mutable("../escape.mts")),
        step("publish", "shared", true, protectedGlue()),
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: "invalid-source-provenance",
        subject: "mutable",
      }),
    ]);
  });
});

describe("analyzeExecutionPolicy data crossings (issue #120 slice 120b)", () => {
  const producer = step("producer", "runner-data", false, {
    kind: "mutable-repository",
    path: "src/generate-verdict.mts",
  });
  const consumer = step(
    "consumer",
    "runner-credential",
    true,
    protectedGlue(),
  );
  const crossing = (
    contract?: BoundedDataContractEvidence,
  ): ExecutionPolicyEvidence["crossings"][number] => ({
    id: "verdict",
    producer: { kind: "step", stepId: "producer" },
    consumerStepId: "consumer",
    contract,
  });

  it("accepts a typed bounded artifact across a fresh runner cut", () => {
    expect(
      analyze([producer, consumer], [
        crossing(boundedContract()),
      ]),
    ).toEqual([]);
  });

  it("requires a bounded contract for PR data consumed by a credentialed remote action", () => {
    const remoteConsumer = step(
      "remote",
      "runner-credential",
      true,
      {
        kind: "remote-action",
        reference: `vendor/action@${SHA_A}`,
      },
    );
    expect(
      analyze([remoteConsumer], [
        {
          id: "workspace",
          producer: {
            kind: "untrusted-data",
            source: "pull-request workspace",
          },
          consumerStepId: "remote",
        },
      ]),
    ).toEqual([
      {
        kind: "unbounded-data-crossing",
        subject: "workspace",
        detail: "crossing has no bounded data contract",
      },
    ]);
  });

  it("accepts bounded PR data consumed by protected credentialed glue", () => {
    expect(
      analyze([consumer], [
        {
          id: "pull-request-diff",
          producer: {
            kind: "untrusted-data",
            source: "pull-request diff",
          },
          consumerStepId: "consumer",
          contract: boundedContract({
            format: "diff",
            allowedNames: ["artifacts/change.diff"],
          }),
        },
      ]),
    ).toEqual([]);
  });

  it("requires the same contract when credentials precede mutable execution", () => {
    expect(
      analyze(
        [
          step(
            "producer",
            "runner-credential",
            true,
            protectedGlue(),
          ),
          step("consumer", "runner-data", false, {
            kind: "mutable-repository",
            path: "src/render-result.mts",
          }),
        ],
        [crossing()],
      ),
    ).toEqual([
      {
        kind: "unbounded-data-crossing",
        subject: "verdict",
        detail: "crossing has no bounded data contract",
      },
    ]);
  });

  it("requires sensitive-data exclusion when credentials precede mutable execution", () => {
    const steps = [
      step(
        "producer",
        "runner-credential",
        true,
        protectedGlue(),
      ),
      step("consumer", "runner-data", false, {
        kind: "mutable-repository",
        path: "src/render-result.mts",
      }),
    ];
    expect(
      analyze(steps, [
        crossing(boundedContract({ rejectSensitiveData: false })),
      ]),
    ).toEqual([
      {
        kind: "unbounded-data-crossing",
        subject: "verdict",
        detail:
          "crossing contract accepts an executable or unbounded data channel",
      },
    ]);
    expect(analyze(steps, [crossing(boundedContract())])).toEqual([]);
  });

  it("allows unbounded data between runners when neither can reach credentials", () => {
    expect(
      analyze(
        [
          producer,
          step("consumer", "runner-other", false, {
            kind: "mutable-repository",
            path: "src/consume-verdict.mts",
          }),
        ],
        [crossing()],
      ),
    ).toEqual([]);
  });

  it("does not treat a declaration within one runner as a fresh-runner crossing", () => {
    expect(
      analyze(
        [
          step("producer", "shared", true, protectedGlue()),
          step("consumer", "shared", false, protectedGlue()),
        ],
        [crossing()],
      ),
    ).toEqual([]);
  });

  it.each([
    ["missing contract", undefined],
    [
      "empty name set",
      boundedContract({ allowedNames: [] }),
    ],
    [
      "duplicate exact names",
      boundedContract({
        allowedNames: [
          "artifacts/verdict.json",
          "artifacts/verdict.json",
        ],
      }),
    ],
    [
      "unsafe artifact name",
      boundedContract({ allowedNames: ["../verdict.json"] }),
    ],
    [
      "zero byte bound",
      boundedContract({ maxBytes: 0 }),
    ],
    [
      "fractional byte bound",
      boundedContract({ maxBytes: 1.5 }),
    ],
    [
      "byte bound above the global ceiling",
      boundedContract({
        maxBytes: MAX_BOUNDARY_ARTIFACT_BYTES + 1,
      }),
    ],
  ])("rejects a crossing with %s", (_name, contract) => {
    expect(analyze([producer, consumer], [crossing(contract)])).toEqual([
      expect.objectContaining({
        kind: "unbounded-data-crossing",
        subject: "verdict",
      }),
    ]);
  });

  it("accepts the exact global byte ceiling", () => {
    expect(
      analyze(
        [producer, consumer],
        [
          crossing(
            boundedContract({
              maxBytes: MAX_BOUNDARY_ARTIFACT_BYTES,
            }),
          ),
        ],
      ),
    ).toEqual([]);
  });

  it.each([
    "rejectUnexpectedNames",
    "rejectUnexpectedTypes",
    "rejectSymlinks",
    "rejectConfiguration",
    "rejectPlugins",
    "rejectHooks",
    "rejectModules",
    "rejectExecutables",
    "rejectSensitiveData",
  ] as const)("requires contract control %s", (control) => {
    expect(
      analyze(
        [producer, consumer],
        [crossing(boundedContract({ [control]: false }))],
      ),
    ).toEqual([
      {
        kind: "unbounded-data-crossing",
        subject: "verdict",
        detail:
          "crossing contract accepts an executable or unbounded data channel",
      },
    ]);
  });

  it("fails closed on a runtime-unsupported data format", () => {
    const unsupported = {
      ...boundedContract(),
      format: "archive",
    } as unknown as BoundedDataContractEvidence;
    expect(
      analyze([producer, consumer], [crossing(unsupported)]),
    ).toEqual([
      {
        kind: "unbounded-data-crossing",
        subject: "verdict",
        detail: "crossing declares an unsupported data format",
      },
    ]);
  });
});

describe("analyzeExecutionPolicy graph integrity (issue #120 slice 120b)", () => {
  const trusted = (id: string, runnerId: string) =>
    step(id, runnerId, false, protectedGlue());

  it.each([
    [
      "duplicate step ID",
      [trusted("same", "runner-a"), trusted("same", "runner-b")],
    ],
    [
      "empty step ID",
      [trusted("", "runner-a")],
    ],
    [
      "whitespace-only step ID",
      [trusted(" ", "runner-a")],
    ],
    [
      "empty runner ID",
      [trusted("step", "")],
    ],
    [
      "whitespace-only runner ID",
      [trusted("step", " ")],
    ],
  ])("rejects a %s", (_name, steps) => {
    expect(analyze(steps)).toEqual([
      expect.objectContaining({ kind: "invalid-evidence" }),
    ]);
  });

  it("rejects padding that could forge a fresh runner cut", () => {
    expect(
      analyze([
        step("mutable", "shared", false, {
          kind: "mutable-repository",
          path: "src/untrusted.mts",
        }),
        step("credential", "shared ", true, protectedGlue()),
      ]),
    ).toEqual([
      expect.objectContaining({ kind: "invalid-evidence" }),
    ]);
  });

  it("rejects a crossing that references an unknown step", () => {
    expect(
      analyze([trusted("known", "runner-a")], [
        {
          id: "missing",
          producer: { kind: "step", stepId: "known" },
          consumerStepId: "unknown",
          contract: boundedContract(),
        },
      ]),
    ).toEqual([
      {
        kind: "invalid-evidence",
        subject: "missing",
        detail: "data crossing references an unknown execution step",
      },
    ]);
  });

  it.each(["", "same"])("rejects crossing ID %j", (id) => {
    const first = {
      id,
      producer: { kind: "step" as const, stepId: "producer" },
      consumerStepId: "consumer",
    };
    const crossings =
      id === ""
        ? [first]
        : [first, { ...first }];
    expect(
      analyze(
        [
          trusted("producer", "runner-a"),
          trusted("consumer", "runner-b"),
        ],
        crossings,
      ),
    ).toEqual([
      expect.objectContaining({ kind: "invalid-evidence" }),
    ]);
  });

  it.each([
    ["padded crossing ID", " crossing ", "pull-request diff"],
    ["blank untrusted-data label", "crossing", " "],
  ])("rejects %s", (_name, id, source) => {
    const consumer = trusted("consumer", "runner-b");
    expect(
      analyze([consumer], [
        {
          id,
          producer: { kind: "untrusted-data", source },
          consumerStepId: "consumer",
        },
      ]),
    ).toEqual([
      expect.objectContaining({ kind: "invalid-evidence" }),
    ]);
  });

  it("rejects evidence whose graph completeness is not proven", () => {
    expect(
      analyzeExecutionPolicy({
        graphComplete: false,
        steps: [],
        crossings: [],
      }),
    ).toEqual([
      {
        kind: "invalid-evidence",
        subject: "<execution-graph>",
        detail: "execution graph completeness has not been proven",
      },
    ]);
  });

  it("rejects runtime values that merely look like security booleans", () => {
    expect(
      analyzeExecutionPolicy({
        graphComplete: "false" as unknown as boolean,
        steps: [
          step(
            "credential",
            "runner",
            "false" as unknown as boolean,
            protectedGlue(),
          ),
        ],
        crossings: [],
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "invalid-evidence",
        subject: "<execution-graph>",
      }),
      expect.objectContaining({
        kind: "invalid-evidence",
        subject: "credential",
      }),
    ]);
  });
});
