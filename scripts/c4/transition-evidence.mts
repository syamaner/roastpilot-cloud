import { z } from "zod";

const evidence = "roastpilot/c9-c4/transition";
const hex = /^[0-9a-f]+$/;
export const isCommit = (value: string) => value.length === 40 && hex.test(value);
export const isRef = (value: string) => value.length === 64 && hex.test(value);

const commit = z.string().refine(isCommit);
const ref = z.string().refine(isRef);
const subject = z.strictObject({
  id: ref,
  kind: z.enum(["alias", "url", "producer", "target"]),
  classification: z.enum(["current_uncached", "legacy", "out_of_scope", "recovery", "unknown"]),
  release: commit.nullable(),
});
const observationKind = z.enum([
  "inventory_authority", "inventory_start", "inventory_end", "inventory_completeness", "rollback_policy",
  "page_nonservable", "preview_nonservable", "page_uncached", "preview_uncached", "producer_drained",
  "scope_exclusion", "recovery_procedure", "recovery_demonstrated",
]);
const observation = z.strictObject({
  id: ref,
  kind: observationKind,
  subject: ref,
  scope: ref,
  fleet: ref,
  start: ref,
  end: ref,
  source: ref,
  outcome: z.enum(["verified", "unknown", "unsupported", "failed", "changed"]),
  members: z.array(ref),
});
const suite = z.strictObject({
  evidence: z.literal(evidence),
  version: z.literal(1),
  cloud_commit: commit,
  plan_commit: commit,
  scope: ref,
  fleet: ref,
  start: ref,
  end: ref,
  subjects: z.array(subject),
  observations: z.array(observation),
});

type Suite = z.infer<typeof suite>;
type Subject = z.infer<typeof subject>;
type Observation = z.infer<typeof observation>;
type ObservationKind = z.infer<typeof observationKind>;

export type TransitionBinding = { cloud: string; plan: string; scope: string; fleet: string };
type Rejection =
  | "schema" | "not_canonical" | "binding_mismatch" | "identity"
  | "observation_binding" | "subject_form" | "coverage_mismatch" | "evidence_reuse";
type Incomplete = "missing_evidence" | "unverified_evidence" | "missing_current_fleet" | "recovery_unqualified";
export type TransitionVerdict =
  | { verdict: "evidence_structurally_complete" }
  | { verdict: "evidence_rejected"; reason: Rejection }
  | { verdict: "evidence_incomplete"; reason: Incomplete };

function byId(a: { id: string }, b: { id: string }): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function canonical(input: Suite): string {
  return JSON.stringify({
    evidence: input.evidence,
    version: input.version,
    cloud_commit: input.cloud_commit,
    plan_commit: input.plan_commit,
    scope: input.scope,
    fleet: input.fleet,
    start: input.start,
    end: input.end,
    subjects: [...input.subjects].sort(byId).map(({ id, kind, classification, release }) => ({
      id, kind, classification, release,
    })),
    observations: [...input.observations].sort(byId).map((item) => ({
      id: item.id,
      kind: item.kind,
      subject: item.subject,
      scope: item.scope,
      fleet: item.fleet,
      start: item.start,
      end: item.end,
      source: item.source,
      outcome: item.outcome,
      members: [...item.members].sort(),
    })),
  }) + "\n";
}

const logicalKey = (kind: ObservationKind, subjectId: string) => kind + ":" + subjectId;

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function invalidIdentity(input: Suite): boolean {
  return input.start === input.end
    || duplicate(input.subjects.map((item) => item.id))
    || duplicate(input.observations.map((item) => item.id))
    || duplicate(input.observations.map((item) => logicalKey(item.kind, item.subject)))
    || input.observations.some((item) => duplicate(item.members))
    || input.subjects.some((item) => item.id === input.scope);
}

function invalidObservationBinding(input: Suite): boolean {
  return input.observations.some((item) =>
    item.scope !== input.scope || item.fleet !== input.fleet
    || item.start !== input.start || item.end !== input.end
    || item.source === item.id);
}

function incorrectSubjectForm(item: Subject, cloud: string): boolean {
  const { classification, kind, release } = item;
  if (classification === "recovery" && kind !== "target") return true;
  if (kind === "producer" && classification !== "unknown"
    && classification !== "legacy" && classification !== "out_of_scope") return true;
  if (classification === "current_uncached" || classification === "recovery") {
    if (release === null) return true;
    if (classification === "current_uncached" && (kind === "alias" || kind === "url") && release !== cloud) return true;
    return false;
  }
  return release !== null;
}

function expectedObservations(input: Suite, candidates: readonly Subject[]): Map<string, ReadonlySet<string>> {
  const expected = new Map<string, ReadonlySet<string>>();
  const add = (kind: ObservationKind, subjectId: string, members: ReadonlySet<string> = new Set()) => {
    expected.set(logicalKey(kind, subjectId), members);
  };
  const subjectIds = new Set(input.subjects.map((item) => item.id));
  add("inventory_authority", input.scope);
  add("inventory_start", input.scope, subjectIds);
  add("inventory_end", input.scope, subjectIds);
  add("inventory_completeness", input.scope, subjectIds);
  add("rollback_policy", input.scope, new Set(candidates.map((item) => item.id)));

  for (const { id, kind, classification } of input.subjects) {
    if (classification === "legacy" && (kind === "alias" || kind === "url")) {
      add("page_nonservable", id);
      add("preview_nonservable", id);
    } else if (classification === "legacy" && kind === "producer") {
      add("producer_drained", id);
    } else if (classification === "current_uncached" && kind !== "producer") {
      add("page_uncached", id);
      add("preview_uncached", id);
    } else if (classification === "out_of_scope") {
      add("scope_exclusion", id);
    } else if (classification === "recovery" && kind === "target") {
      add("page_uncached", id);
      add("preview_uncached", id);
      add("recovery_procedure", id);
      add("recovery_demonstrated", id);
    }
  }
  return expected;
}

function sameMembers(actualMembers: readonly string[], expected: ReadonlySet<string>): boolean {
  const actual = new Set(actualMembers);
  return actual.size === expected.size && [...actual].every((member) => expected.has(member));
}

function invalidCoverage(
  input: Suite, expected: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  return input.observations.some((item) => {
    const members = expected.get(logicalKey(item.kind, item.subject));
    if (members === undefined) return true;
    return !sameMembers(item.members, members);
  });
}

function sourcesFor(items: readonly Observation[], ...kinds: ObservationKind[]): Set<string> {
  return new Set(items.filter((item) => kinds.includes(item.kind)).map((item) => item.source));
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some((source) => right.has(source));
}

function reusesEvidence(input: Suite): boolean {
  const items = input.observations;
  const inventoryClaims = sourcesFor(items, "inventory_authority", "inventory_completeness");
  const lists = sourcesFor(items, "inventory_start", "inventory_end");
  const serving = sourcesFor(items, "page_nonservable", "preview_nonservable", "page_uncached", "preview_uncached");
  const drain = sourcesFor(items, "producer_drained");
  if (overlap(inventoryClaims, lists)) return true;
  if (overlap(serving, drain)) return true;

  const procedures = new Map(items.filter((item) => item.kind === "recovery_procedure")
    .map((item) => [item.subject, item.source]));
  return items.some((item) => item.kind === "recovery_demonstrated"
    && procedures.get(item.subject) === item.source);
}

const rejected = (reason: Rejection): TransitionVerdict => ({ verdict: "evidence_rejected", reason });
const incomplete = (reason: Incomplete): TransitionVerdict => ({ verdict: "evidence_incomplete", reason });

export function verifyTransitionEvidence(bytes: Uint8Array, expected: TransitionBinding): TransitionVerdict {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return rejected("schema");
  }

  const parsed = suite.safeParse(value);
  if (!parsed.success) return rejected("schema");
  const input = parsed.data;
  if (text !== canonical(input)) return rejected("not_canonical");
  if (input.cloud_commit !== expected.cloud
    || input.plan_commit !== expected.plan
    || input.scope !== expected.scope
    || input.fleet !== expected.fleet) return rejected("binding_mismatch");
  if (invalidIdentity(input)) return rejected("identity");
  if (invalidObservationBinding(input)) return rejected("observation_binding");
  if (input.subjects.some((item) => incorrectSubjectForm(item, input.cloud_commit))) return rejected("subject_form");

  const candidates = input.subjects.filter((item) => item.kind === "target" && item.classification === "current_uncached");
  const expectedRecords = expectedObservations(input, candidates);
  if (invalidCoverage(input, expectedRecords)) return rejected("coverage_mismatch");
  if (reusesEvidence(input)) return rejected("evidence_reuse");
  const observed = new Set(input.observations.map((item) => logicalKey(item.kind, item.subject)));
  if ([...expectedRecords.keys()].some((key) => !observed.has(key))
    || input.subjects.some((item) => item.classification === "unknown")) return incomplete("missing_evidence");
  if (input.observations.some((item) => item.outcome !== "verified")) return incomplete("unverified_evidence");
  if (!input.subjects.some((item) => item.kind === "alias" && item.classification === "current_uncached")
    || candidates.length === 0) return incomplete("missing_current_fleet");
  if (input.subjects.filter((item) => item.classification === "recovery").length !== 1) return incomplete("recovery_unqualified");
  return { verdict: "evidence_structurally_complete" };
}
