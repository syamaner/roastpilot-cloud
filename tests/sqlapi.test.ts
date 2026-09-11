import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeStatement,
  isNotFound,
  SqlApiError,
} from "../lib/sqlapi";

const ACCOUNT = "xy12345.eu-west-1";
const USER = "web_user";
const WAREHOUSE = "PUBLIC_WEB_WH";
const KEY_SENTINEL = "ZZZSENTINELZZZ";
const PASSPHRASE_SENTINEL = "PASSPHRASE_SENTINEL_499";

const { privateKey: testPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
});
const PRIVATE_KEY_PEM = testPrivateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const ENCRYPTED_PRIVATE_KEY_PEM = testPrivateKey
  .export({
    format: "pem",
    type: "pkcs8",
    cipher: "aes-256-cbc",
    passphrase: PASSPHRASE_SENTINEL,
  })
  .toString();

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

interface JwtPayload {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function resultEnvelope(
  data: unknown[],
  rowType: unknown[] = [],
  partitionInfo: unknown = [{ rowCount: data.length }],
): Record<string, unknown> {
  return {
    resultSetMetaData: { rowType, partitionInfo },
    data,
  };
}

function successfulFetch(
  envelope: unknown = resultEnvelope([]),
): ReturnType<typeof vi.fn> {
  return vi.fn(async () => jsonResponse(envelope));
}

function captureRequest(fetchMock: ReturnType<typeof vi.fn>): CapturedRequest {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return {
    url: input,
    init,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  };
}

function decodeJwtPart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

async function sqlApiError(promise: Promise<unknown>): Promise<SqlApiError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SqlApiError);
  return caught as SqlApiError;
}

function installFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function consoleSpies() {
  return [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "info").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(console, "debug").mockImplementation(() => undefined),
  ];
}

function serialisedConsoleCalls(
  spies: ReturnType<typeof consoleSpies>,
): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}

beforeEach(() => {
  vi.stubEnv("SNOWFLAKE_WEB_ACCOUNT", ACCOUNT);
  vi.stubEnv("SNOWFLAKE_WEB_USER", USER);
  vi.stubEnv("SNOWFLAKE_WEB_PRIVATE_KEY", PRIVATE_KEY_PEM);
  vi.stubEnv("SNOWFLAKE_WEB_PRIVATE_KEY_PASSPHRASE", "");
  vi.stubEnv("SNOWFLAKE_WEB_WAREHOUSE", WAREHOUSE);
  vi.stubEnv("SNOWFLAKE_WEB_DATABASE", "TEST_DATABASE");
  vi.stubEnv("SNOWFLAKE_WEB_SCHEMA", "TEST_SCHEMA");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("executeStatement", () => {
  it("1. POSTs to the statement endpoint with key-pair JWT headers", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await executeStatement("SELECT 1");

    const request = captureRequest(fetchMock);
    const headers = request.init.headers as Record<string, string>;
    expect(request.url).toMatch(/\/api\/v2\/statements$/);
    expect(request.init.method).toBe("POST");
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers["X-Snowflake-Authorization-Token-Type"]).toBe(
      "KEYPAIR_JWT",
    );
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json");
  });

  it("2. pins the role and sends warehouse, database, and schema every time", async () => {
    vi.stubEnv("SNOWFLAKE_WEB_ROLE", "ACCOUNTADMIN");
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await executeStatement("SELECT CURRENT_ROLE()");

    expect(captureRequest(fetchMock).body).toMatchObject({
      statement: "SELECT CURRENT_ROLE()",
      role: "PUBLIC_WEB",
      warehouse: WAREHOUSE,
      database: "TEST_DATABASE",
      schema: "TEST_SCHEMA",
    });
  });

  it("3. returns column metadata and NUMBER, TIMESTAMP_NTZ, and VARIANT cells without coercion", async () => {
    const row = [
      "9007199254740993.2500",
      "2026-09-11 13:14:15.123456789",
      '{"temperature_c":204.75}',
      null,
    ];
    const envelope = resultEnvelope(row.length === 0 ? [] : [row], [
      { name: "READING", type: "NUMBER" },
      { name: "RECORDED_AT", type: "TIMESTAMP_NTZ" },
      { name: "PAYLOAD", type: "VARIANT" },
      { name: "OPTIONAL", type: "TEXT" },
    ]);
    vi.stubGlobal("fetch", successfulFetch(envelope));

    const result = await executeStatement("SELECT readings");

    expect(result.columns).toEqual([
      { name: "READING", type: "NUMBER" },
      { name: "RECORDED_AT", type: "TIMESTAMP_NTZ" },
      { name: "PAYLOAD", type: "VARIANT" },
      { name: "OPTIONAL", type: "TEXT" },
    ]);
    expect(result.rows).toEqual([row]);
    expect(result.rows[0][0]).toBe("9007199254740993.2500");
    expect(result.rows[0][1]).toBe("2026-09-11 13:14:15.123456789");
    expect(result.rows[0][2]).toBe('{"temperature_c":204.75}');
    expect(result.rowCount).toBe(1);
  });

  it("4. returns an empty non-lookup result with rowCount zero", async () => {
    vi.stubGlobal(
      "fetch",
      successfulFetch({
        resultSetMetaData: { rowType: [] },
        data: [],
      }),
    );

    await expect(executeStatement("SHOW PARAMETERS")).resolves.toEqual({
      columns: [],
      rows: [],
      rowCount: 0,
    });
  });

  it("5. normalizes regional and global accounts for JWT claims but not the host", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await executeStatement("SELECT 1");

    const regionalRequest = captureRequest(fetchMock);
    const headers = regionalRequest.init.headers as Record<
      string,
      string
    >;
    const token = headers.Authorization.slice("Bearer ".length);
    const [encodedHeader, encodedPayload] = token.split(".");
    const header = decodeJwtPart<{ alg: string; typ: string }>(encodedHeader);
    const payload = decodeJwtPart<JwtPayload>(encodedPayload);
    const fingerprint = createHash("sha256")
      .update(
        createPublicKey(testPrivateKey).export({ format: "der", type: "spki" }),
      )
      .digest("base64");

    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.sub).toBe(`XY12345.${USER.toUpperCase()}`);
    expect(payload.iss).toBe(
      `XY12345.${USER.toUpperCase()}.SHA256:${fingerprint}`,
    );
    expect(regionalRequest.url).toBe(
      `https://${ACCOUNT}.snowflakecomputing.com/api/v2/statements`,
    );
    expect(token.split(".")).toHaveLength(3);

    fetchMock.mockClear();
    vi.stubEnv("SNOWFLAKE_WEB_ACCOUNT", "myorg-myacct.global");
    await executeStatement("SELECT 1");
    const globalHeaders = captureRequest(fetchMock).init.headers as Record<
      string,
      string
    >;
    const [, globalPayloadPart] = globalHeaders.Authorization.slice(
      "Bearer ".length,
    ).split(".");
    const globalPayload = decodeJwtPart<JwtPayload>(globalPayloadPart);
    expect(globalPayload.sub).toBe(`MYORG.${USER.toUpperCase()}`);
    expect(globalPayload.iss).toBe(
      `MYORG.${USER.toUpperCase()}.SHA256:${fingerprint}`,
    );
  });

  it("6. bounds the positive JWT lifetime to at most 3540 seconds", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await executeStatement("SELECT 1");

    const headers = captureRequest(fetchMock).init.headers as Record<
      string,
      string
    >;
    const [, encodedPayload] = headers.Authorization.slice(
      "Bearer ".length,
    ).split(".");
    const payload = decodeJwtPart<JwtPayload>(encodedPayload);
    expect(payload.exp - payload.iat).toBeGreaterThan(0);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(3_540);
  });

  it("7. defaults database and schema when their environment values are unset", async () => {
    delete process.env.SNOWFLAKE_WEB_DATABASE;
    delete process.env.SNOWFLAKE_WEB_SCHEMA;
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await executeStatement("SELECT 1");

    expect(captureRequest(fetchMock).body).toMatchObject({
      database: "ROASTPILOT_DEV",
      schema: "APP",
    });
  });

  it("8. sends bound caller values separately and leaves statement text literal", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const statement = "INSERT INTO reviews(name) SELECT :1";
    const maliciousValue = "Robert'); DROP TABLE reviews;--";

    await executeStatement(statement, {
      "1": { type: "TEXT", value: maliciousValue },
      "2": { type: "TEXT", value: null },
    });
    expect(captureRequest(fetchMock).body).toMatchObject({
      statement,
      bindings: {
        "1": { type: "TEXT", value: maliciousValue },
        "2": { type: "TEXT", value: null },
      },
    });
  });

  it("9. fails closed instead of returning partition zero from a multi-partition result", async () => {
    vi.stubGlobal(
      "fetch",
      successfulFetch(resultEnvelope([["first-only"]], [], [{}, {}])),
    );

    const error = await sqlApiError(executeStatement("SELECT large_result"));
    expect(error.kind).toBe("transport");
    expect(error.message).toBe(
      "Snowflake SQL API response has unresolved partitions.",
    );
  });

  it("10. rejects a missing account before fetching", async () => {
    delete process.env.SNOWFLAKE_WEB_ACCOUNT;
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    const error = await sqlApiError(executeStatement("SELECT 1"));
    expect(error.kind).toBe("config");
    expect(error.message).toContain("SNOWFLAKE_WEB_ACCOUNT");
    expect(error.message).not.toContain(ACCOUNT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("11. rejects a blank warehouse before any network call or JWT mint", async () => {
    vi.stubEnv("SNOWFLAKE_WEB_WAREHOUSE", "  ");
    vi.stubEnv(
      "SNOWFLAKE_WEB_PRIVATE_KEY",
      `-----BEGIN PRIVATE KEY-----${KEY_SENTINEL}`,
    );
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    const error = await sqlApiError(executeStatement("SELECT 1"));
    expect(error.kind).toBe("config");
    expect(error.message).toContain("SNOWFLAKE_WEB_WAREHOUSE");
    expect(error.message).not.toContain(KEY_SENTINEL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("20. rejects a missing user before fetching", async () => {
    delete process.env.SNOWFLAKE_WEB_USER;
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    const error = await sqlApiError(executeStatement("SELECT 1"));
    expect(error.kind).toBe("config");
    expect(error.message).toContain("SNOWFLAKE_WEB_USER");
    expect(error.message).not.toContain(USER);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("21. rejects a missing private key before fetching", async () => {
    delete process.env.SNOWFLAKE_WEB_PRIVATE_KEY;
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    const error = await sqlApiError(executeStatement("SELECT 1"));
    expect(error.kind).toBe("config");
    expect(error.message).toContain("SNOWFLAKE_WEB_PRIVATE_KEY");
    expect(error.message).not.toContain(KEY_SENTINEL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("23. rejects an account outside the safe host grammar before fetching", async () => {
    vi.stubEnv("SNOWFLAKE_WEB_ACCOUNT", "evil.example#");
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    const error = await sqlApiError(executeStatement("SELECT 1"));
    expect(error.kind).toBe("config");
    expect(error.message).toBe("Malformed SNOWFLAKE_WEB_ACCOUNT.");
    expect(error.message).not.toContain("evil.example#");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("12. classifies both 401 and 403 responses as authentication failures", async () => {
    for (const status of [401, 403]) {
      installFetch(jsonResponse({ message: "credential rejected" }, status));
      const error = await sqlApiError(executeStatement("SELECT 1"));
      expect(error.kind).toBe("auth");
      expect(error.status).toBe(status);
      expect(error.message).toBe("Snowflake SQL API authentication failed.");
    }
  });

  it("24. classifies a structured 422 insufficient-privileges failure as auth", async () => {
    const rawMessage =
      "SQL access control error: Insufficient privileges to operate on table SECRET";
    installFetch(jsonResponse({ message: rawMessage }, 422));

    const error = await sqlApiError(executeStatement("SELECT secret"));
    expect(error.kind).toBe("auth");
    expect(error.status).toBe(422);
    expect(error.message).toBe("Snowflake SQL API authentication failed.");
    expect(error.message).not.toContain(rawMessage);
  });

  it("25. classifies a structured 422 object-does-not-exist failure as not found", async () => {
    const rawMessage = "Object PRIVATE_TABLE does not exist";
    installFetch(jsonResponse({ message: rawMessage }, 422));

    const error = await sqlApiError(executeStatement("SELECT missing_object"));
    expect(error.kind).toBe("not_found");
    expect(error.status).toBe(422);
    expect(error.message).toBe("Snowflake SQL API resource was not found.");
    expect(error.message).not.toContain(rawMessage);
    expect(isNotFound(error)).toBe(true);
  });

  it("26. classifies unparseable or malformed 422 bodies as transport", async () => {
    installFetch(new Response(null, { status: 422 }));
    const unparseableError = await sqlApiError(
      executeStatement("SELECT invalid_statement"),
    );
    expect(unparseableError.kind).toBe("transport");
    expect(unparseableError.message).not.toContain("Unexpected end");

    installFetch(jsonResponse([], 422));
    const malformedError = await sqlApiError(
      executeStatement("SELECT invalid_statement"),
    );
    expect(malformedError.kind).toBe("transport");
    expect(malformedError.status).toBe(422);
  });

  it("29. classifies a parsed JSON null 422 body without an uncaught TypeError", async () => {
    installFetch(jsonResponse(null, 422));

    const error = await sqlApiError(
      executeStatement("SELECT invalid_statement"),
    );
    expect(error).toBeInstanceOf(SqlApiError);
    expect(error.kind).toBe("transport");
    expect(error.status).toBe(422);
    expect(error.message).toBe("Snowflake SQL API response was invalid.");
  });

  it("13. classifies HTTP 404 as not found while preserving an empty bound SELECT", async () => {
    installFetch(jsonResponse({ message: "missing" }, 404));
    const httpError = await sqlApiError(executeStatement("SELECT 1"));
    expect(httpError.kind).toBe("not_found");
    expect(isNotFound(httpError)).toBe(true);

    vi.stubGlobal("fetch", successfulFetch(resultEnvelope([], [])));
    await expect(
      executeStatement("  SELECT * FROM roast WHERE slug = :1", {
        "1": { type: "TEXT", value: "missing-slug" },
      }),
    ).resolves.toEqual({ columns: [], rows: [], rowCount: 0 });
    expect(isNotFound(new Error("not found"))).toBe(false);
    expect(isNotFound(new SqlApiError("transport", "safe"))).toBe(false);
  });

  it("14. classifies server, statement, request-build, and malformed-envelope failures as transport", async () => {
    installFetch(jsonResponse({ message: "server exploded" }, 500));
    expect((await sqlApiError(executeStatement("SELECT 1"))).kind).toBe(
      "transport",
    );

    const malformedEnvelopes: unknown[] = [
      [],
      { message: "generic statement error" },
      { resultSetMetaData: {}, data: [] },
      resultEnvelope([], [], "not-an-array"),
      resultEnvelope([], [{ name: 12, type: "TEXT" }]),
      resultEnvelope([], [{ name: "VALID", type: 12 }]),
      resultEnvelope(["not-a-row"], []),
      resultEnvelope([["extra-cell"]], []),
    ];
    for (const envelope of malformedEnvelopes) {
      vi.stubGlobal("fetch", successfulFetch(envelope));
      expect((await sqlApiError(executeStatement("SHOW THING"))).kind).toBe(
        "transport",
      );
    }

    installFetch(
      new Response("{not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect((await sqlApiError(executeStatement("SHOW THING"))).kind).toBe(
      "transport",
    );

    const throwingBindings = Object.defineProperty({}, "1", {
      enumerable: true,
      get() {
        throw new Error("raw request construction detail");
      },
    }) as Record<string, { type: string; value: string | null }>;
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const constructionError = await sqlApiError(
      executeStatement("SELECT :1", throwingBindings),
    );
    expect(constructionError.kind).toBe("transport");
    expect(constructionError.message).not.toContain("raw request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("22. rejects a non-string cell even when its row width matches", async () => {
    vi.stubGlobal(
      "fetch",
      successfulFetch(
        resultEnvelope([[123]], [{ name: "X", type: "NUMBER" }]),
      ),
    );

    const error = await sqlApiError(executeStatement("SELECT numeric_value"));
    expect(error.kind).toBe("transport");
  });

  it("15. rejects an unresolved 202 async response as transport", async () => {
    installFetch(jsonResponse({ statementHandle: "still-running" }, 202));

    const error = await sqlApiError(executeStatement("SELECT slow_query"));
    expect(error.kind).toBe("transport");
    expect(error.status).toBe(202);
  });

  it("16. never leaks a PEM sentinel from signing or transport failures or console output", async () => {
    const spies = consoleSpies();
    const signingFetchMock = successfulFetch();
    vi.stubGlobal("fetch", signingFetchMock);
    vi.stubEnv(
      "SNOWFLAKE_WEB_PRIVATE_KEY",
      `-----BEGIN PRIVATE KEY-----${KEY_SENTINEL}-----END PRIVATE KEY-----`,
    );
    const signingError = await sqlApiError(executeStatement("SELECT 1"));
    expect(signingError.kind).toBe("config");
    expect(signingError.message).not.toContain(KEY_SENTINEL);
    expect(signingFetchMock).not.toHaveBeenCalled();

    vi.stubEnv("SNOWFLAKE_WEB_PRIVATE_KEY", PRIVATE_KEY_PEM);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`TLS failed around ${KEY_SENTINEL}`);
      }),
    );
    const transportError = await sqlApiError(executeStatement("SELECT 1"));
    expect(transportError.kind).toBe("transport");
    expect(transportError.message).not.toContain(KEY_SENTINEL);
    expect(serialisedConsoleCalls(spies)).not.toContain(KEY_SENTINEL);
  });

  it("27. aborts a timed-out fetch as a sanitised transport failure", async () => {
    vi.useFakeTimers();
    const abortDetail = "private AbortError socket detail";
    const capturedSignal: { current?: AbortSignal } = {};
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedSignal.current = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException(abortDetail, "AbortError")),
            { once: true },
          );
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const errorPromise = sqlApiError(executeStatement("SELECT slow_query"));

    await vi.advanceTimersByTimeAsync(30_000);
    const error = await errorPromise;

    expect(error.kind).toBe("transport");
    expect(error.message).toBe("Snowflake SQL API request failed.");
    expect(error.message).not.toContain(abortDetail);
    expect(capturedSignal.current).toBeDefined();
    expect(capturedSignal.current?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("28. clears the request timer immediately after a fast success", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", successfulFetch(resultEnvelope([["ready"]], [
      { name: "STATUS", type: "TEXT" },
    ])));

    await expect(executeStatement("SELECT status")).resolves.toEqual({
      columns: [{ name: "STATUS", type: "TEXT" }],
      rows: [["ready"]],
      rowCount: 1,
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("17. never echoes the statement, host, or full Snowflake error body", async () => {
    const statement = "SELECT * FROM secret_table WHERE token = :1";
    const host = `${ACCOUNT}.snowflakecomputing.com`;
    installFetch(
      jsonResponse(
        {
          message: `Failure executing ${statement} at ${host}`,
          detail: "full response body detail",
        },
        500,
      ),
    );

    const error = await sqlApiError(
      executeStatement(statement, {
        "1": { type: "TEXT", value: "private-caller-value" },
      }),
    );
    expect(error.kind).toBe("transport");
    expect(error.message).not.toContain(statement);
    expect(error.message).not.toContain(host);
    expect(error.message).not.toContain("full response body detail");
    expect(error.message).not.toContain("private-caller-value");
  });

  it("18. never leaks a passphrase from config or transport failures or console output", async () => {
    const spies = consoleSpies();
    vi.stubEnv("SNOWFLAKE_WEB_PRIVATE_KEY", ENCRYPTED_PRIVATE_KEY_PEM);
    vi.stubEnv(
      "SNOWFLAKE_WEB_PRIVATE_KEY_PASSPHRASE",
      `${PASSPHRASE_SENTINEL}-wrong`,
    );
    const configError = await sqlApiError(executeStatement("SELECT 1"));
    expect(configError.kind).toBe("config");
    expect(configError.message).not.toContain(PASSPHRASE_SENTINEL);

    vi.stubEnv(
      "SNOWFLAKE_WEB_PRIVATE_KEY_PASSPHRASE",
      PASSPHRASE_SENTINEL,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`socket detail ${PASSPHRASE_SENTINEL}`);
      }),
    );
    const transportError = await sqlApiError(executeStatement("SELECT 1"));
    expect(transportError.kind).toBe("transport");
    expect(transportError.message).not.toContain(PASSPHRASE_SENTINEL);
    expect(serialisedConsoleCalls(spies)).not.toContain(PASSPHRASE_SENTINEL);
  });

  it("19. distinguishes success-envelope errors from a valid empty result", async () => {
    const cases: Array<{
      envelope: Record<string, unknown>;
      expected: "auth" | "transport" | "not_found";
    }> = [
      { envelope: { message: "Access denied to object" }, expected: "auth" },
      {
        envelope: { message: "Object does not exist or not authorized" },
        expected: "auth",
      },
      {
        envelope: { message: "Named resource was not found" },
        expected: "not_found",
      },
      {
        envelope: { message: "Remote statement compilation failed" },
        expected: "transport",
      },
      { envelope: {}, expected: "transport" },
    ];

    for (const { envelope, expected } of cases) {
      vi.stubGlobal("fetch", successfulFetch(envelope));
      expect((await sqlApiError(executeStatement("SHOW THING"))).kind).toBe(
        expected,
      );
    }

    vi.stubGlobal("fetch", successfulFetch(resultEnvelope([], [])));
    await expect(
      executeStatement("SELECT * FROM reviews WHERE roast_id = :1", {
        "1": { type: "TEXT", value: "roast-without-reviews" },
      }),
    ).resolves.toEqual({ columns: [], rows: [], rowCount: 0 });
  });
});
