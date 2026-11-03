import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  CREATOR_KEY_CACHE_MS,
  CreatorKeyNotConfigured,
  CreatorKeySource,
  generateCourseToken,
  sha256Hex,
  verifySecret,
} from "./secrets";

const ssmMock = mockClient(SSMClient);
const KEY_A = "a".repeat(40);
const KEY_B = "b".repeat(40);

beforeEach(() => ssmMock.reset());

describe("verifySecret", () => {
  test("accepts the secret whose hash is stored", () => {
    const token = generateCourseToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySecret(token, sha256Hex(token))).toBe(true);
  });

  test("rejects wrong, missing and empty secrets", () => {
    const stored = sha256Hex("right");
    expect(verifySecret("wrong", stored)).toBe(false);
    expect(verifySecret(undefined, stored)).toBe(false);
    expect(verifySecret("", sha256Hex(""))).toBe(false);
  });

  test("presenting the stored hash itself does not authenticate", () => {
    const stored = sha256Hex("right");
    expect(verifySecret(stored, stored)).toBe(false);
  });
});

describe("CreatorKeySource", () => {
  test("verifies against the SSM value and caches it", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: KEY_A } });
    const source = new CreatorKeySource("/p", new SSMClient({}));
    expect(await source.verify(KEY_A)).toBe(true);
    expect(await source.verify(KEY_B)).toBe(false);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect(ssmMock.commandCalls(GetParameterCommand)[0].args[0].input).toMatchObject({
      WithDecryption: true,
    });
  });

  test("a rotated key takes effect once the cache window passes", async () => {
    let now = 1_000_000;
    ssmMock.on(GetParameterCommand).resolvesOnce({ Parameter: { Value: KEY_A } })
      .resolves({ Parameter: { Value: KEY_B } });
    const source = new CreatorKeySource("/p", new SSMClient({}), () => now);

    expect(await source.verify(KEY_A)).toBe(true);
    now += CREATOR_KEY_CACHE_MS - 1;
    expect(await source.verify(KEY_A)).toBe(true); // still cached
    now += 2;
    expect(await source.verify(KEY_A)).toBe(false);
    expect(await source.verify(KEY_B)).toBe(true);
  });

  test("a missing parameter means not configured", async () => {
    ssmMock.on(GetParameterCommand).rejects(
      Object.assign(new Error("nope"), { name: "ParameterNotFound" })
    );
    await expect(new CreatorKeySource("/p", new SSMClient({})).currentHash()).rejects.toBeInstanceOf(
      CreatorKeyNotConfigured
    );
  });

  test("a short key is refused rather than trusted", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: "short" } });
    await expect(new CreatorKeySource("/p", new SSMClient({})).currentHash()).rejects.toBeInstanceOf(
      CreatorKeyNotConfigured
    );
  });

  test("no parameter name means not configured, without calling SSM", async () => {
    await expect(new CreatorKeySource(undefined, new SSMClient({})).currentHash()).rejects.toBeInstanceOf(
      CreatorKeyNotConfigured
    );
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
  });
});
