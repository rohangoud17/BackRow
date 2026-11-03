/**
 * The two bearer secrets for course management, until Cognito (Phase 4):
 *
 *   creator key   lets its holder create courses. One per environment, in SSM.
 *   course token  lets its holder upload/list/delete documents and attach
 *                 sessions to one course. Returned once at course creation.
 *
 * Comparison is always hash-to-hash with `safeEqual`, the same constant-time
 * comparison `presenterJoin` uses. Hashing first also makes both sides the same
 * length, so not even the secret's length leaks through timing.
 *
 * Course tokens are stored only as an unsalted SHA-256. That is right for a
 * 256-bit random token — salting and slow KDFs defend low-entropy passwords
 * against guessing, and nobody can guess 2^256. It would be wrong for anything
 * a human chose.
 */
import { createHash, randomBytes } from "node:crypto";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { safeEqual } from "@backrow/shared";

export const sha256Hex = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

/** 32 random bytes as hex — same strength and shape as the presenter token. */
export const generateCourseToken = (): string => randomBytes(32).toString("hex");

/** Constant-time check of a presented secret against a stored SHA-256. */
export const verifySecret = (presented: string | undefined, storedHash: string): boolean =>
  presented !== undefined && presented.length > 0 && safeEqual(sha256Hex(presented), storedHash);

/**
 * How long a fetched creator key is trusted before SSM is asked again. Bounds
 * how long a rotated-out key keeps working: rotation takes effect within this
 * window with no redeploy. Only course creation reads it — never the realtime
 * path, where an SSM read on cold start measured ~2.5 s.
 */
export const CREATOR_KEY_CACHE_MS = 5 * 60 * 1000;

export class CreatorKeyNotConfigured extends Error {}

export class CreatorKeySource {
  private cached?: { hash: string; fetchedAt: number };

  constructor(
    private readonly paramName: string | undefined,
    private readonly ssm = new SSMClient({}),
    private readonly now = () => Date.now()
  ) {}

  /** SHA-256 of the current creator key. */
  async currentHash(): Promise<string> {
    if (this.cached && this.now() - this.cached.fetchedAt < CREATOR_KEY_CACHE_MS) {
      return this.cached.hash;
    }
    if (!this.paramName) throw new CreatorKeyNotConfigured("no parameter name");

    let value: string | undefined;
    try {
      const res = await this.ssm.send(
        new GetParameterCommand({ Name: this.paramName, WithDecryption: true })
      );
      value = res.Parameter?.Value;
    } catch (err) {
      if ((err as { name?: string })?.name === "ParameterNotFound") {
        throw new CreatorKeyNotConfigured(this.paramName);
      }
      throw err;
    }
    // A short key is a mistake worth refusing outright rather than trusting.
    if (!value || value.length < 32) throw new CreatorKeyNotConfigured(this.paramName);

    // Only the hash is kept in memory, never the key itself.
    this.cached = { hash: sha256Hex(value), fetchedAt: this.now() };
    return this.cached.hash;
  }

  async verify(presented: string | undefined): Promise<boolean> {
    return verifySecret(presented, await this.currentHash());
  }
}
