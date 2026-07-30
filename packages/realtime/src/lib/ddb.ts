/**
 * DynamoDB access for the realtime layer.
 *
 * All reads and writes go through here so the key design in @backrow/shared
 * stays the only place that knows about PK/SK shapes.
 *
 * Cold-start note: the client is constructed at module scope so it's reused
 * across invocations in a warm container. We deliberately do NOT read SSM on
 * this path — measured at ~2.5s on a cold start in Phase 0, which alone would
 * blow the sub-500ms latency budget. Config here comes from env vars only.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  sessionKey,
  connectionKey,
  membershipKey,
  membershipQueryPrefix,
  ttlFrom,
  CONNECTION_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  type SessionState,
  type Role,
} from "@backrow/shared";

const client = new DynamoDBClient({});
export const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const TABLE = () => {
  const t = process.env.TABLE_NAME;
  if (!t) throw new Error("TABLE_NAME env var is not set");
  return t;
};

export interface SessionRecord {
  entity: "session";
  sessionCode: string;
  presenterToken: string;
  state: SessionState;
  createdAt: number;
  ttl: number;
}

export interface ConnectionRecord {
  entity: "connection";
  connectionId: string;
  /** Undefined until the client sends a successful join. */
  sessionCode?: string;
  role?: Role;
  displayName?: string;
  connectedAt: number;
  ttl: number;
}

export interface MembershipRecord {
  entity: "membership";
  sessionCode: string;
  connectionId: string;
  role: Role;
  displayName?: string;
  joinedAt: number;
  ttl: number;
}

/** Thrown when a conditional write loses a race. */
export class ConditionFailed extends Error {}

function isConditionalCheckFailed(err: unknown): boolean {
  return (err as { name?: string })?.name === "ConditionalCheckFailedException";
}

/**
 * Create a session, failing if the code is already taken.
 *
 * The condition expression is what makes join-code collisions impossible
 * rather than merely unlikely — the caller retries with a fresh code.
 */
export async function createSession(params: {
  sessionCode: string;
  presenterToken: string;
  nowMs: number;
}): Promise<SessionRecord> {
  const { sessionCode, presenterToken, nowMs } = params;
  const record: SessionRecord = {
    entity: "session",
    sessionCode,
    presenterToken,
    state: "lobby",
    createdAt: nowMs,
    ttl: ttlFrom(nowMs, SESSION_TTL_SECONDS),
  };

  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE(),
        Item: { ...sessionKey(sessionCode), ...record },
        ConditionExpression: "attribute_not_exists(PK)",
      })
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new ConditionFailed(`session code ${sessionCode} already exists`);
    }
    throw err;
  }
  return record;
}

export async function getSession(
  sessionCode: string
): Promise<SessionRecord | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLE(), Key: sessionKey(sessionCode) })
  );
  return res.Item as SessionRecord | undefined;
}

/** Record a raw connection at $connect time, before any join. */
export async function putConnection(params: {
  connectionId: string;
  nowMs: number;
}): Promise<void> {
  const { connectionId, nowMs } = params;
  const record: ConnectionRecord = {
    entity: "connection",
    connectionId,
    connectedAt: nowMs,
    ttl: ttlFrom(nowMs, CONNECTION_TTL_SECONDS),
  };
  await doc.send(
    new PutCommand({
      TableName: TABLE(),
      Item: { ...connectionKey(connectionId), ...record },
    })
  );
}

export async function getConnection(
  connectionId: string
): Promise<ConnectionRecord | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLE(), Key: connectionKey(connectionId) })
  );
  return res.Item as ConnectionRecord | undefined;
}

/**
 * Attach a connection to a session.
 *
 * Two writes: the membership edge (so fan-out can find this connection) and an
 * update to the connection record (so $disconnect knows which edge to remove).
 * Not a transaction — if the second write failed we'd have an orphan edge, and
 * the 410-Gone prune on broadcast plus the TTL both clean that up. A
 * TransactWriteItems here would double the write cost to prevent something
 * that's already self-healing.
 */
export async function joinSession(params: {
  connectionId: string;
  sessionCode: string;
  role: Role;
  displayName?: string;
  nowMs: number;
}): Promise<void> {
  const { connectionId, sessionCode, role, displayName, nowMs } = params;
  const ttl = ttlFrom(nowMs, CONNECTION_TTL_SECONDS);

  const membership: MembershipRecord = {
    entity: "membership",
    sessionCode,
    connectionId,
    role,
    displayName,
    joinedAt: nowMs,
    ttl,
  };

  await doc.send(
    new PutCommand({
      TableName: TABLE(),
      Item: { ...membershipKey(sessionCode, connectionId), ...membership },
    })
  );

  // Build the update so an absent displayName is REMOVEd rather than stored as
  // null. Writing null would leak onto the wire as `"displayName": null`, which
  // contradicts the `displayName?: string` contract — a client typed
  // `string | undefined` would receive null.
  const names: Record<string, string> = { "#r": "role", "#t": "ttl" };
  const values: Record<string, unknown> = {
    ":c": sessionCode,
    ":r": role,
    ":t": ttl,
  };
  const sets = ["sessionCode = :c", "#r = :r", "#t = :t"];
  let updateExpression: string;

  if (displayName === undefined) {
    updateExpression = `SET ${sets.join(", ")} REMOVE displayName`;
  } else {
    sets.push("displayName = :d");
    values[":d"] = displayName;
    updateExpression = `SET ${sets.join(", ")}`;
  }

  await doc.send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: connectionKey(connectionId),
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

/** Every connection currently joined to a session — the fan-out list. */
export async function listSessionConnections(
  sessionCode: string
): Promise<MembershipRecord[]> {
  const { PK, skPrefix } = membershipQueryPrefix(sessionCode);
  const out: MembershipRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  // Paginate: a lecture-sized session can exceed DynamoDB's 1 MB page.
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": PK, ":sk": skPrefix },
        ExclusiveStartKey: lastKey,
      })
    );
    out.push(...((res.Items ?? []) as MembershipRecord[]));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return out;
}

export async function deleteMembership(
  sessionCode: string,
  connectionId: string
): Promise<void> {
  await doc.send(
    new DeleteCommand({
      TableName: TABLE(),
      Key: membershipKey(sessionCode, connectionId),
    })
  );
}

/**
 * Remove a connection and its membership edge.
 *
 * Called from $disconnect and from the 410-Gone path during broadcast. Safe to
 * call more than once — DeleteCommand on a missing key is a no-op.
 */
export async function removeConnection(connectionId: string): Promise<void> {
  const existing = await getConnection(connectionId);
  if (existing?.sessionCode) {
    await deleteMembership(existing.sessionCode, connectionId);
  }
  await doc.send(
    new DeleteCommand({
      TableName: TABLE(),
      Key: connectionKey(connectionId),
    })
  );
}

/**
 * Remove a membership edge without needing the connection record.
 *
 * Used by the broadcast prune path, where we already know the session and the
 * connection is provably gone.
 */
export async function pruneConnection(
  sessionCode: string,
  connectionId: string
): Promise<void> {
  await deleteMembership(sessionCode, connectionId);
  await doc.send(
    new DeleteCommand({
      TableName: TABLE(),
      Key: connectionKey(connectionId),
    })
  );
}
