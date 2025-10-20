import { NextResponse } from "next/server";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-chat-v3.1:free";

const MODEL_FALLBACKS =
  process.env.OPENROUTER_MODELS ??
  `${OPENROUTER_MODEL},openrouter/auto`;

type Payload = {
  opponentLine?: unknown;
  intensity?: unknown;
};

export async function POST(request: Request) {
  try {
    const { opponentLine, intensity }: Payload = await request.json();

    if (typeof opponentLine !== "string") {
      return NextResponse.json(
        { error: "请提供对方的话（字符串）。" },
        { status: 400 }
      );
    }

    const trimmedOpponentLine = opponentLine.trim();
    if (!trimmedOpponentLine) {
      return NextResponse.json(
        { error: "请先输入对方说了什么。" },
        { status: 400 }
      );
    }

    const parsedIntensity =
      typeof intensity === "number"
        ? clampIntensity(intensity)
        : typeof intensity === "string"
          ? clampIntensity(Number.parseInt(intensity, 10))
          : DEFAULT_INTENSITY;

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY missing");
      return NextResponse.json(
        { error: "服务器未正确配置 OpenRouter API Key。" },
        { status: 500 }
      );
    }

    const referer =
      request.headers.get("origin") ?? "https://localhost-placeholder";
    const models = parseModelList(MODEL_FALLBACKS);

    const stream = new ReadableStream({
      start: async (controller) => {
        const encoder = new TextEncoder();
        const send = (chunk: unknown) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        };

        const errors: Array<{ model: string; status: number; message: string }> = [];

        const closeWithError = (error: string, status = 500) => {
          send({ type: "error", error, status });
          controller.close();
        };

        try {
          for (const model of models) {
            send({ type: "model", model });

            const completionResponse = await fetch(OPENROUTER_URL, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": referer,
                // HTTP headers must stay within the Latin-1 charset; use ASCII-only title.
                "X-Title": "Chaojia"
              },
              body: JSON.stringify({
                model,
                stream: true,
                messages: buildMessages(trimmedOpponentLine, parsedIntensity),
                temperature: mapIntensityToTemperature(parsedIntensity),
                top_p: 0.9,
                max_tokens: 512,
                presence_penalty: mapIntensityToPresencePenalty(parsedIntensity)
              })
            });

            if (!completionResponse.ok) {
              const errorPayload = await safeRead(completionResponse);
              const errorMessage = extractErrorMessage(errorPayload);
              console.error("OpenRouter error", { model, error: errorPayload });
              errors.push({
                model,
                status: completionResponse.status,
                message: errorMessage
              });

              if (!shouldRetry(completionResponse.status, errorMessage)) {
                closeWithError(errorMessage, completionResponse.status);
                return;
              }
              // try next model
              continue;
            }

            const body = completionResponse.body;
            if (!body) {
              errors.push({
                model,
                status: 502,
                message: "模型返回空响应，请稍后再试。"
              });
              continue;
            }

            const reader = body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            let aggregated = "";
            let lastSent: string[] = [];

            const flushPartial = () => {
              const replies = collectReplies(aggregated);
              if (replies.length === 0) {
                return;
              }
              if (arraysEqual(replies, lastSent)) {
                return;
              }
              lastSent = replies;
              send({ type: "partial", replies });
            };

            let streamFailed = false;

            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                break;
              }
              buffer += decoder.decode(value, { stream: true });

              const events = buffer.split("\n\n");
              buffer = events.pop() ?? "";

              for (const event of events) {
                const lines = event.split("\n");
                for (const rawLine of lines) {
                  const line = rawLine.trim();
                  if (!line.startsWith("data:")) {
                    continue;
                  }
                  const data = line.slice(5).trim();
                  if (!data || data === "[DONE]") {
                    continue;
                  }
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(data);
                  } catch (parseError) {
                    console.warn("Failed to parse streaming chunk", parseError, data);
                    continue;
                  }
                  const deltaText = extractDeltaText(parsed);
                  if (!deltaText) {
                    continue;
                  }
                  aggregated += deltaText;
                  flushPartial();
                }
              }
            }

            aggregated = aggregated.trim();
            const replies = collectReplies(aggregated);

            if (replies.length === 0) {
              const message = "模型暂时给不出答案，请换个描述再试试。";
              errors.push({ model, status: 502, message });
              streamFailed = true;
            } else {
              send({ type: "complete", replies });
              controller.close();
              return;
            }

            if (streamFailed) {
              // try next model
              continue;
            }
          }

          if (errors.length > 0) {
            const [firstError] = errors;
            const combined = [
              firstError.message,
              ...errors.slice(1).map((error) => `${error.model}: ${error.message}`)
            ]
              .filter(Boolean)
              .join(" ｜ ");
            closeWithError(combined || "模型接口请求失败，请稍后再试。", firstError.status);
          } else {
            closeWithError("模型接口请求失败，请稍后再试。", 502);
          }
        } catch (error) {
          console.error("Streaming pipeline failed", error);
          closeWithError("服务暂时不可用，请稍后重试。", 500);
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Transfer-Encoding": "chunked"
      }
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      {
        error: "服务暂时不可用，请稍后重试。"
      },
      { status: 500 }
    );
  }
}

const MIN_INTENSITY = 1;
const MAX_INTENSITY = 10;
const DEFAULT_INTENSITY = 6;

function buildMessages(opponentLine: string, intensity: number) {
  const toneGuide = describeTone(intensity);
  return [
    {
      role: "system",
      content:
        [
          "你是一名中文犀利斗嘴高手，擅长高情商反击。",
          "始终遵守：输出干净利落，不涉及人身攻击，不触碰法律或伦理底线，也不包含脏话。",
          "禁止输出 <think>、思考过程或任何除最终答案外的文本；不要使用 Markdown 代码块。",
          "所有回答必须严格以 JSON 数组返回，数组包含 3 个纯文本字符串。"
        ].join(" ")
    },
    {
      role: "user",
      content: [
        "场景：我在社交平台和人吵架，需要你给出 3 条不同的中文回击。",
        `对方的话：${opponentLine}`,
        `语气强度：${intensity}/10，描述：${toneGuide}`,
        "请输出一个 JSON 数组，数组包含 3 个字符串，每条字符串就是一条回击内容，不要包含任何额外文字。"
      ].join("\n")
    }
  ];
}

function describeTone(intensity: number) {
  if (intensity <= 3) {
    return "保持礼貌、机智、含蓄，但措辞要有感染力。";
  }
  if (intensity <= 7) {
    return "直接犀利、针锋相对，同时保持逻辑性和幽默感。";
  }
  return "言辞犀利、霸气、毫不退让，但仍然避免低俗或明显人身攻击。";
}

function mapIntensityToTemperature(intensity: number) {
  const normalized = (intensity - MIN_INTENSITY) / (MAX_INTENSITY - MIN_INTENSITY);
  return Number((0.35 + normalized * 0.65).toFixed(2));
}

function mapIntensityToPresencePenalty(intensity: number) {
  const normalized = (intensity - MIN_INTENSITY) / (MAX_INTENSITY - MIN_INTENSITY);
  return Number((0.1 + normalized * 0.8).toFixed(2));
}

function clampIntensity(value: number) {
  if (Number.isNaN(value)) {
    return DEFAULT_INTENSITY;
  }
  return Math.min(Math.max(value, MIN_INTENSITY), MAX_INTENSITY);
}

function normalizeReplies(payload: unknown): string[] {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "choices" in payload &&
    Array.isArray((payload as { choices: unknown }).choices)
  ) {
    const choice = (payload as { choices: Array<{ message?: { content?: unknown } }> }).choices[0];
    const content = extractMessageContent(choice?.message?.content);
    return collectReplies(content);
  }
  return [];
}

function tryParseJsonArray(raw: string | null | undefined) {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, 3);
    }
  } catch (error) {
    console.warn("Failed to parse JSON array", error, raw);
  }
  return [];
}

function fallbackSplit(raw: string | null | undefined) {
  if (!raw) {
    return [];
  }
  const forbiddenPatterns = [
    /^<think\b[^>]*>/i,
    /^<\/think>/i,
    /^场景[:：]/,
    /^我的角色[:：]/,
    /^请[^\n]*JSON/,
    /^用户[^\n]*要求/,
    /^思考[:：]/,
    /^角色设定[:：]/
  ];
  const forbiddenKeywords = [
    "场景：",
    "输出必须",
    "高情商反击",
    "关键点",
    "不要输出",
    "请确保",
    "JSON"
  ];
  return raw
    .split(/\n+/)
    .map((line) => line.replace(/^[\s\d\-•、.]+/, "").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !forbiddenPatterns.some((pattern) => pattern.test(line)))
    .filter((line) => !forbiddenKeywords.some((keyword) => line.includes(keyword)))
    .filter(isLikelyReply)
    .slice(0, 3);
}

async function safeRead(response: Response) {
  try {
    return await response.json();
  } catch {
    try {
      return { error: await response.text() };
    } catch {
      return null;
    }
  }
}

function extractErrorMessage(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload
  ) {
    const error = (payload as { error: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
    ) {
      const message = (error as { message: string }).message.trim();
      if (message) {
        return message;
      }
    }
  }
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof (payload as { message?: unknown }).message === "string"
  ) {
    const fallback = (payload as { message: string }).message.trim();
    if (fallback) {
      return fallback;
    }
  }
  return "模型接口请求失败，请稍后再试。";
}

function parseModelList(raw: string) {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function shouldRetry(status: number, message: string) {
  if (status >= 500) {
    return true;
  }
  const lowered = message.toLowerCase();
  return (
    lowered.includes("provider returned error") ||
    lowered.includes("no endpoints found") ||
    lowered.includes("upstream error") ||
    lowered.includes("temporarily unavailable")
  );
}

function sanitizeContent(raw: string) {
  if (!raw) {
    return "";
  }
  return raw.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trim();
}

function extractJsonArrayFromText(raw: string | null | undefined) {
  if (!raw) {
    return null;
  }
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
}

function extractMessageContent(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          typeof item === "object" &&
          item !== null &&
          "text" in item &&
          typeof (item as { text?: unknown }).text === "string"
        ) {
          return (item as { text: string }).text;
        }
        return "";
      })
      .join("\n");
  }
  if (
    typeof raw === "object" &&
    raw !== null &&
    "text" in raw &&
    typeof (raw as { text?: unknown }).text === "string"
  ) {
    return (raw as { text: string }).text;
  }
  return "";
}

function isLikelyReply(line: string) {
  if (line.length < 6) {
    return false;
  }
  const disallowedStarts = ["场景", "角色", "输出", "说明", "提示"];
  if (disallowedStarts.some((prefix) => line.startsWith(prefix))) {
    return false;
  }
  const hasSentencePunctuation = /[。？！?!…～~]/.test(line);
  if (hasSentencePunctuation) {
    return true;
  }
  // Allow short punchlines but require at least one Chinese character.
  return /[\u4e00-\u9fa5]/.test(line) && line.length >= 8;
}

function extractDeltaText(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "choices" in payload &&
    Array.isArray((payload as { choices: unknown }).choices)
  ) {
    const choice = (payload as { choices: Array<unknown> }).choices[0];
    if (
      typeof choice === "object" &&
      choice !== null &&
      "delta" in choice &&
      typeof (choice as { delta?: unknown }).delta === "object" &&
      (choice as { delta?: unknown }).delta !== null
    ) {
      const delta = (choice as { delta: unknown }).delta;
      if (
        typeof delta === "object" &&
        delta !== null &&
        "content" in delta
      ) {
        return extractMessageContent((delta as { content?: unknown }).content);
      }
    }
    if (
      typeof choice === "object" &&
      choice !== null &&
      "message" in choice &&
      typeof (choice as { message?: unknown }).message === "object"
    ) {
      return extractMessageContent((choice as { message?: unknown }).message);
    }
  }
  return "";
}

function arraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((item, index) => item === b[index]);
}

function collectReplies(rawContent: string) {
  const sanitized = sanitizeContent(rawContent);
  const parsed = tryParseJsonArray(sanitized);
  if (parsed.length > 0) {
    return parsed;
  }
  const extracted = extractJsonArrayFromText(sanitized);
  if (extracted) {
    const extractedParsed = tryParseJsonArray(extracted);
    if (extractedParsed.length > 0) {
      return extractedParsed;
    }
  }
  return fallbackSplit(sanitized);
}
