/**
 * An optional check on the student's question before anything is generated.
 *
 * Off by default. Three cheaper controls already cover the pilot: the score
 * floor drops unrelated questions before the model is called, the system prompt
 * confines the model to the course sources, and an answer goes only to the
 * person who asked, so a jailbreak has no audience. A Bedrock Guardrail adds a
 * policy check on top (roughly 200-400 ms and a per-request charge), which is
 * worth switching on once an institution asks for one.
 *
 * To enable: create a guardrail in Bedrock, then deploy with
 * `--context assistantGuardrailId=<id> --context assistantGuardrailVersion=<n>`.
 *
 * Fails closed: if the check itself errors, the ask ends with an error reply
 * rather than proceeding unchecked.
 */
import {
  BedrockRuntimeClient,
  ApplyGuardrailCommand,
} from "@aws-sdk/client-bedrock-runtime";

export type GuardrailVerdict = "allow" | "block";

export interface Guardrail {
  check(question: string): Promise<GuardrailVerdict>;
}

/** The default: every question is allowed through to retrieval. */
export const noGuardrail: Guardrail = {
  check: async () => "allow",
};

export class BedrockGuardrail implements Guardrail {
  constructor(
    private readonly guardrailId: string,
    private readonly guardrailVersion: string,
    private readonly client = new BedrockRuntimeClient({ maxAttempts: 2 })
  ) {}

  async check(question: string): Promise<GuardrailVerdict> {
    const res = await this.client.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: this.guardrailId,
        guardrailVersion: this.guardrailVersion,
        source: "INPUT",
        content: [{ text: { text: question } }],
      })
    );
    return res.action === "GUARDRAIL_INTERVENED" ? "block" : "allow";
  }
}

/** Build the guardrail from environment variables; unset means none. */
export function guardrailFromEnv(env: NodeJS.ProcessEnv = process.env): Guardrail {
  const id = env.ASSISTANT_GUARDRAIL_ID;
  if (!id) return noGuardrail;
  return new BedrockGuardrail(id, env.ASSISTANT_GUARDRAIL_VERSION || "DRAFT");
}
