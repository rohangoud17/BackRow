/**
 * The generator, behind an interface so the model is a config change and tests
 * never call Bedrock.
 *
 * Claude Haiku 4.5 is invocable only through an inference profile. The `us.`
 * profile may serve a request from us-east-1, us-east-2 or us-west-2: data stays
 * in the US but is not pinned to one region (ADR 0002). Never the `global.` one.
 */
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

export const DEFAULT_ANSWER_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}

export type LlmEvent =
  | { type: "text"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export interface LlmProvider {
  /**
   * Stream the reply. Breaking out of the loop early must stop generation, so
   * an abandoned answer stops costing tokens.
   */
  stream(req: LlmRequest): AsyncIterable<LlmEvent>;
}

export class BedrockConverseLlm implements LlmProvider {
  constructor(
    private readonly modelId = DEFAULT_ANSWER_MODEL_ID,
    // A few retries for throttling before the first byte. Nothing is retried
    // mid-stream: text already sent can't be unsent.
    private readonly client = new BedrockRuntimeClient({ maxAttempts: 3 })
  ) {}

  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    const abort = new AbortController();
    try {
      const res = await this.client.send(
        new ConverseStreamCommand({
          modelId: this.modelId,
          system: [{ text: req.system }],
          messages: [{ role: "user", content: [{ text: req.user }] }],
          inferenceConfig: { maxTokens: req.maxTokens, temperature: req.temperature },
        }),
        { abortSignal: abort.signal }
      );
      for await (const event of res.stream ?? []) {
        const text = event.contentBlockDelta?.delta?.text;
        if (text) yield { type: "text", text };
        const usage = event.metadata?.usage;
        if (usage) {
          yield {
            type: "usage",
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          };
        }
      }
    } finally {
      // Runs when the consumer stops early too: closes the HTTP/2 stream so
      // Bedrock stops generating.
      abort.abort();
    }
  }
}
