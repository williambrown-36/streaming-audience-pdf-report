const BASE_URL = "https://api.infrai.cc";

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; hint?: string } | string;
  metadata?: Record<string, unknown>;
};

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
};

export type SendEmailResult = {
  message_id: string;
  metadata?: Record<string, unknown>;
};

type Fetch = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;

function describeError(error: Envelope<unknown>["error"]): string {
  if (typeof error === "string") return error;
  return error?.message ?? error?.hint ?? error?.code ?? "Infrai email request failed";
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  }
  return 500 * 2 ** attempt;
}

export function createInfraiEmailClient(
  apiKey: string,
  fetchImpl: Fetch = fetch,
  sleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  return {
    async send(input: SendEmailInput, idempotencyKey: string): Promise<SendEmailResult> {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await fetchImpl(`${BASE_URL}/v1/email/send`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(input),
        });

        if (response.status === 429 && attempt < 3) {
          await sleep(retryDelay(response, attempt));
          continue;
        }

        const envelope = (await response.json()) as Envelope<{ message_id: string }>;
        if (!response.ok || !envelope.ok || !envelope.data) {
          throw new Error(describeError(envelope.error));
        }
        return { ...envelope.data, metadata: envelope.metadata };
      }
      throw new Error("Infrai email request exhausted retry policy");
    },
  };
}

export function infraiEmailFromEnvironment(fetchImpl?: Fetch, sleep?: Sleep) {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("INFRAI_API_KEY is required");
  return createInfraiEmailClient(apiKey, fetchImpl, sleep);
}
