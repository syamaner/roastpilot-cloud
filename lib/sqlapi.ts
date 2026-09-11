/**
 * Snowflake SQL API access for the anonymous public-web boundary.
 *
 * The security-sensitive deployment context is fixed on every request: the
 * role is pinned in code, credentials come only from the `SNOWFLAKE_WEB_*`
 * environment contract, and each request gets a short-lived RS256 JWT minted
 * with Node's built-in crypto implementation. Returned cells stay as their
 * original strings so this transport layer cannot silently change precision,
 * timestamps, JSON, or units.
 *
 * Operators must provision `SNOWFLAKE_WEB_USER` with
 * `DEFAULT_SECONDARY_ROLES = ()` and audit that setting exactly as they do for
 * the CI role. Pinning the primary role here cannot prevent secondary-role
 * inheritance from broadening the session's privileges.
 *
 * Unit tests assert this parser against Snowflake SQL API v2's documented
 * `resultSetMetaData.rowType`, `resultSetMetaData.partitionInfo`, and `data`
 * envelope. Verification against a real response is deferred to the
 * operator-gated first live call and is not a merge gate.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";

const ROLE = "PUBLIC_WEB";
const DEFAULT_DATABASE = "ROASTPILOT_DEV";
const DEFAULT_SCHEMA = "APP";
const JWT_LIFETIME_SECONDS = 3_540;
const REQUEST_TIMEOUT_MS = 30_000;

const AUTH_ERROR_MESSAGE = "Snowflake SQL API authentication failed.";
const CONFIG_ERROR_MESSAGE = "Snowflake key-pair configuration is invalid.";
const NOT_FOUND_ERROR_MESSAGE = "Snowflake SQL API resource was not found.";
const TRANSPORT_ERROR_MESSAGE = "Snowflake SQL API request failed.";
const RESPONSE_ERROR_MESSAGE = "Snowflake SQL API response was invalid.";
const PARTITION_ERROR_MESSAGE =
  "Snowflake SQL API response has unresolved partitions.";
const MALFORMED_ACCOUNT_ERROR_MESSAGE = "Malformed SNOWFLAKE_WEB_ACCOUNT.";
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type SqlApiErrorKind = "not_found" | "transport" | "auth" | "config";
type JsonObject = Record<string, unknown>;

interface SqlApiConfig {
  account: string;
  user: string;
  privateKey: string;
  privateKeyPassphrase?: string;
  warehouse: string;
  database: string;
  schema: string;
}

/** A column descriptor returned by Snowflake alongside raw row values. */
export interface SqlApiColumn {
  name: string;
  type: string;
}

/** A fully-read, single-partition Snowflake SQL API result. */
export interface SqlApiResult {
  columns: SqlApiColumn[];
  rows: ReadonlyArray<ReadonlyArray<string | null>>;
  rowCount: number;
}

/**
 * An operator-safe SQL API failure whose message never contains remote or
 * credential material.
 */
export class SqlApiError extends Error {
  readonly kind: "not_found" | "transport" | "auth" | "config";
  readonly status?: number;

  constructor(kind: SqlApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "SqlApiError";
    this.kind = kind;
    this.status = status;
  }
}

/** Returns true only for the client's bounded not-found failure. */
export function isNotFound(error: unknown): error is SqlApiError {
  return error instanceof SqlApiError && error.kind === "not_found";
}

function requiredEnvironmentVariable(
  name:
    | "SNOWFLAKE_WEB_ACCOUNT"
    | "SNOWFLAKE_WEB_USER"
    | "SNOWFLAKE_WEB_PRIVATE_KEY"
    | "SNOWFLAKE_WEB_WAREHOUSE",
): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new SqlApiError(
      "config",
      `Missing required environment variable ${name}.`,
    );
  }
  return value;
}

function optionalEnvironmentVariable(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function readConfig(): SqlApiConfig {
  const account = requiredEnvironmentVariable("SNOWFLAKE_WEB_ACCOUNT").trim();
  const user = requiredEnvironmentVariable("SNOWFLAKE_WEB_USER");
  const privateKey = requiredEnvironmentVariable(
    "SNOWFLAKE_WEB_PRIVATE_KEY",
  );
  const warehouse = requiredEnvironmentVariable("SNOWFLAKE_WEB_WAREHOUSE");

  if (!ACCOUNT_PATTERN.test(account)) {
    throw new SqlApiError("config", MALFORMED_ACCOUNT_ERROR_MESSAGE);
  }

  return {
    account,
    user: user.trim(),
    privateKey,
    privateKeyPassphrase: optionalEnvironmentVariable(
      "SNOWFLAKE_WEB_PRIVATE_KEY_PASSPHRASE",
    ),
    warehouse: warehouse.trim(),
    database:
      optionalEnvironmentVariable("SNOWFLAKE_WEB_DATABASE")?.trim() ??
      DEFAULT_DATABASE,
    schema:
      optionalEnvironmentVariable("SNOWFLAKE_WEB_SCHEMA")?.trim() ??
      DEFAULT_SCHEMA,
  };
}

function base64Url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("=", "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
}

function jwtAccount(account: string): string {
  const uppercaseAccount = account.toUpperCase();
  const separator = uppercaseAccount.includes(".GLOBAL") ? "-" : ".";
  return uppercaseAccount.split(separator, 1)[0];
}

function mintJwt(config: SqlApiConfig): string {
  try {
    const privateKey = createPrivateKey({
      key: config.privateKey,
      format: "pem",
      passphrase: config.privateKeyPassphrase,
    });
    const publicKeyDer = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    const fingerprint = createHash("sha256")
      .update(publicKeyDer)
      .digest("base64");
    const principal = `${jwtAccount(config.account)}.${config.user.toUpperCase()}`;
    const issuedAt = Math.floor(Date.now() / 1_000);
    const expiresAt = issuedAt + JWT_LIFETIME_SECONDS;
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(
      JSON.stringify({
        iss: `${principal}.SHA256:${fingerprint}`,
        sub: principal,
        iat: issuedAt,
        exp: expiresAt,
      }),
    );
    const signingInput = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey);

    return `${signingInput}.${base64Url(signature)}`;
  } catch {
    throw new SqlApiError("config", CONFIG_ERROR_MESSAGE);
  }
}

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

function classifySuccessErrorEnvelope(
  envelope: JsonObject,
  status: number,
): SqlApiError {
  const message =
    typeof envelope.message === "string" ? envelope.message.toLowerCase() : "";

  if (
    message.includes("access denied") ||
    message.includes("not authorized") ||
    message.includes("insufficient privilege") ||
    message.includes("authentication") ||
    message.includes("jwt")
  ) {
    return new SqlApiError("auth", AUTH_ERROR_MESSAGE, status);
  }
  if (message.includes("not found") || message.includes("does not exist")) {
    return new SqlApiError("not_found", NOT_FOUND_ERROR_MESSAGE, status);
  }
  return new SqlApiError("transport", RESPONSE_ERROR_MESSAGE, status);
}

function parseResult(
  envelopeValue: unknown,
  status: number,
): SqlApiResult {
  const envelope = asObject(envelopeValue);
  if (envelope === undefined) {
    throw new SqlApiError("transport", RESPONSE_ERROR_MESSAGE, status);
  }

  const metadata = asObject(envelope.resultSetMetaData);
  if (metadata === undefined || !Array.isArray(envelope.data)) {
    throw classifySuccessErrorEnvelope(envelope, status);
  }

  const partitionInfo = metadata.partitionInfo;
  if (partitionInfo !== undefined && !Array.isArray(partitionInfo)) {
    throw new SqlApiError("transport", RESPONSE_ERROR_MESSAGE, status);
  }
  if (Array.isArray(partitionInfo) && partitionInfo.length > 1) {
    throw new SqlApiError("transport", PARTITION_ERROR_MESSAGE, status);
  }
  if (!Array.isArray(metadata.rowType)) {
    throw new SqlApiError("transport", RESPONSE_ERROR_MESSAGE, status);
  }

  const columns = metadata.rowType.map((columnValue) => {
    const column = asObject(columnValue);
    if (
      column === undefined ||
      typeof column.name !== "string" ||
      typeof column.type !== "string"
    ) {
      throw new SqlApiError("transport", RESPONSE_ERROR_MESSAGE, status);
    }
    return { name: column.name, type: column.type };
  });

  const rows = envelope.data.map((rowValue) => {
    if (
      !Array.isArray(rowValue) ||
      rowValue.length !== columns.length ||
      rowValue.some((cell) => cell !== null && typeof cell !== "string")
    ) {
      throw new SqlApiError("transport", RESPONSE_ERROR_MESSAGE, status);
    }
    return rowValue as ReadonlyArray<string | null>;
  });

  return { columns, rows, rowCount: rows.length };
}

/**
 * Executes one statement through Snowflake's SQL API with a freshly minted
 * key-pair JWT.
 *
 * Bindings use Snowflake's native positional-binding object shape (for
 * example, `{ "1": { type: "TEXT", value: "value" } }`). Caller values
 * belong in bindings; this function sends `statement` byte-for-byte and never
 * interpolates them.
 * Every successful empty result is returned with `rowCount: 0`; only explicit
 * Snowflake errors, never result cardinality, determine not-found semantics.
 *
 * @param statement - Literal SQL text containing any binding placeholders.
 * @param bindings - Typed SQL API values, never SQL fragments.
 * @returns Raw string-or-null rows with Snowflake's column metadata.
 * @throws {SqlApiError} A bounded config, auth, not-found, or transport error.
 */
export async function executeStatement(
  statement: string,
  bindings?: Record<string, { type: string; value: string | null }>,
): Promise<SqlApiResult> {
  const config = readConfig();
  const jwt = mintJwt(config);
  const requestBody: JsonObject = {
    statement,
    role: ROLE,
    warehouse: config.warehouse,
    database: config.database,
    schema: config.schema,
  };
  if (bindings !== undefined) {
    requestBody.bindings = bindings;
  }

  let body: string;
  try {
    body = JSON.stringify(requestBody);
  } catch {
    throw new SqlApiError("transport", TRANSPORT_ERROR_MESSAGE);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(
        `https://${config.account}.snowflakecomputing.com/api/v2/statements`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body,
          signal: controller.signal,
        },
      );
    } catch {
      throw new SqlApiError("transport", TRANSPORT_ERROR_MESSAGE);
    }

    if (response.status === 202) {
      throw new SqlApiError(
        "transport",
        TRANSPORT_ERROR_MESSAGE,
        response.status,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new SqlApiError("auth", AUTH_ERROR_MESSAGE, response.status);
    }
    if (response.status === 404) {
      throw new SqlApiError(
        "not_found",
        NOT_FOUND_ERROR_MESSAGE,
        response.status,
      );
    }
    if (response.status === 422) {
      let errorEnvelope: unknown;
      try {
        errorEnvelope = await response.json();
      } catch {
        throw new SqlApiError(
          "transport",
          RESPONSE_ERROR_MESSAGE,
          response.status,
        );
      }
      const errorObject = asObject(errorEnvelope);
      if (errorObject === undefined) {
        throw new SqlApiError(
          "transport",
          RESPONSE_ERROR_MESSAGE,
          response.status,
        );
      }
      throw classifySuccessErrorEnvelope(errorObject, response.status);
    }
    if (!response.ok) {
      throw new SqlApiError(
        "transport",
        TRANSPORT_ERROR_MESSAGE,
        response.status,
      );
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      throw new SqlApiError(
        "transport",
        RESPONSE_ERROR_MESSAGE,
        response.status,
      );
    }

    return parseResult(envelope, response.status);
  } finally {
    clearTimeout(timeout);
  }
}
