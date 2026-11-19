export const ref = (number: number) => number.toString(16).padStart(64, "0");

export const binding = { cloud: "a".repeat(40), plan: "b".repeat(40), scope: ref(1), fleet: ref(2) };
const start = ref(3);
const end = ref(4);

export const ids = {
  currentAlias: ref(11),
  currentUrl: ref(12),
  legacyAlias: ref(13),
  legacyUrl: ref(14),
  secondLegacyUrl: ref(15),
  legacyProducer: ref(16),
  excluded: ref(17),
  rollback: ref(18),
  recovery: ref(19),
};

// An operator mapping can associate both legacy URL subjects with one deployment.
export const sameLegacyDeployment = [ids.legacyUrl, ids.secondLegacyUrl];

export type Subject = {
  id: string;
  kind: "alias" | "url" | "producer" | "target";
  classification: "current_uncached" | "legacy" | "out_of_scope" | "recovery" | "unknown";
  release: string | null;
};

const observationsBySubject = {
  inventory_authority: [binding.scope],
  inventory_start: [binding.scope],
  inventory_end: [binding.scope],
  inventory_completeness: [binding.scope],
  rollback_policy: [binding.scope],
  page_nonservable: [ids.legacyAlias, ...sameLegacyDeployment],
  preview_nonservable: [ids.legacyAlias, ...sameLegacyDeployment],
  page_uncached: [ids.currentAlias, ids.currentUrl, ids.rollback, ids.recovery],
  preview_uncached: [ids.currentAlias, ids.currentUrl, ids.rollback, ids.recovery],
  producer_drained: [ids.legacyProducer],
  scope_exclusion: [ids.excluded],
  recovery_procedure: [ids.recovery],
  recovery_demonstrated: [ids.recovery],
};

export type ObservationKind = keyof typeof observationsBySubject;
type Outcome = "verified" | "unknown" | "unsupported" | "failed" | "changed";
export type Observation = {
  id: string;
  kind: ObservationKind;
  subject: string;
  scope: string;
  fleet: string;
  start: string;
  end: string;
  source: string;
  outcome: Outcome;
  members: string[];
};

export function fixture() {
  const subjects: Subject[] = [
    { id: ids.currentAlias, kind: "alias", classification: "current_uncached", release: binding.cloud },
    { id: ids.currentUrl, kind: "url", classification: "current_uncached", release: binding.cloud },
    { id: ids.legacyAlias, kind: "alias", classification: "legacy", release: null },
    { id: ids.legacyUrl, kind: "url", classification: "legacy", release: null },
    { id: ids.secondLegacyUrl, kind: "url", classification: "legacy", release: null },
    { id: ids.legacyProducer, kind: "producer", classification: "legacy", release: null },
    { id: ids.excluded, kind: "target", classification: "out_of_scope", release: null },
    { id: ids.rollback, kind: "target", classification: "current_uncached", release: "c".repeat(40) },
    { id: ids.recovery, kind: "target", classification: "recovery", release: binding.cloud },
  ];
  const inventory = subjects.map(({ id }) => id);
  const memberships = new Map<ObservationKind, readonly string[]>([
    ["inventory_start", inventory],
    ["inventory_end", inventory],
    ["inventory_completeness", inventory],
    ["rollback_policy", [ids.rollback]],
  ]);
  const observations: Observation[] = [];
  for (const kind of Object.keys(observationsBySubject) as ObservationKind[]) {
    for (const subject of observationsBySubject[kind]) {
      const serial = observations.length;
      observations.push({
        id: ref(100 + serial), kind, subject, scope: binding.scope, fleet: binding.fleet, start, end,
        source: ref(200 + serial), outcome: "verified", members: [...(memberships.get(kind) ?? [])],
      });
    }
  }
  return {
    evidence: "roastpilot/c9-c4/transition",
    version: 1,
    cloud_commit: binding.cloud,
    plan_commit: binding.plan,
    scope: binding.scope,
    fleet: binding.fleet,
    start,
    end,
    subjects,
    observations,
  };
}

export type Fixture = ReturnType<typeof fixture>;

export const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");

export function canonicalFixture(input: Fixture): Uint8Array {
  const compare = (left: string, right: string) => left < right ? -1 : Number(left !== right);
  return encode({
    ...input,
    subjects: [...input.subjects].sort((left, right) => compare(left.id, right.id)),
    observations: input.observations.map((item) => ({ ...item, members: [...item.members].sort() }))
      .sort((left, right) => compare(left.id, right.id)),
  });
}

export function record(input: Fixture, kind: ObservationKind, subject = input.scope): Observation {
  const match = input.observations.find((item) => item.kind === kind && item.subject === subject);
  if (!match) throw new Error("Missing synthetic observation");
  return match;
}

export function inventoryMemberships(input: Fixture): Observation[] {
  return [record(input, "inventory_start"), record(input, "inventory_end"), record(input, "inventory_completeness")];
}

export function addSubject(input: Fixture, subject: Subject): void {
  input.subjects.push(subject);
  for (const item of inventoryMemberships(input)) item.members.push(subject.id);
}

export function removeSubject(input: Fixture, id: string): void {
  input.subjects = input.subjects.filter((subject) => subject.id !== id);
  input.observations = input.observations.filter((item) => item.subject !== id);
  for (const item of inventoryMemberships(input)) item.members = item.members.filter((member) => member !== id);
}
