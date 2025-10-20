"use client";

import { CSSProperties, FormEvent, useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";

const MIN_INTENSITY = 1;
const MAX_INTENSITY = 10;
const DEFAULT_INTENSITY = 6;
const STORAGE_KEY = "chaojia_settings_v1";

type Reply = {
  id: number;
  text: string;
};

type StoredSettings = {
  opponentLine: string;
  intensity: number;
};

const DEFAULT_SETTINGS: StoredSettings = {
  opponentLine: "",
  intensity: DEFAULT_INTENSITY
};

export default function HomePage() {
  const [opponentLine, setOpponentLine] = useState(DEFAULT_SETTINGS.opponentLine);
  const [intensity, setIntensity] = useState(DEFAULT_SETTINGS.intensity);
  const [hydrated, setHydrated] = useState(false);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastGeneratedAt, setLastGeneratedAt] = useState<Date | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Partial<StoredSettings>;
      setOpponentLine(parsed.opponentLine ?? DEFAULT_SETTINGS.opponentLine);
      setIntensity(
        typeof parsed.intensity === "number"
          ? clampIntensity(parsed.intensity)
          : DEFAULT_SETTINGS.intensity
      );
    } catch (loadError) {
      console.warn("Failed to load local storage settings", loadError);
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || typeof window === "undefined") {
      return;
    }
    const payload: StoredSettings = {
      opponentLine,
      intensity
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (storageError) {
      console.warn("Failed to persist settings", storageError);
    }
  }, [hydrated, opponentLine, intensity]);

  useEffect(() => {
    if (copiedId === null) {
      return;
    }
    const timer = window.setTimeout(() => setCopiedId(null), 2200);
    return () => window.clearTimeout(timer);
  }, [copiedId]);

  const sliderProgress = useMemo(() => {
    return ((intensity - MIN_INTENSITY) / (MAX_INTENSITY - MIN_INTENSITY)) * 100;
  }, [intensity]);

  const sliderStyle = useMemo(
    () =>
      ({
        "--progress": `${sliderProgress}%`
      }) as CSSProperties,
    [sliderProgress]
  );

  const consumeStream = async (response: Response) => {
    const body = response.body;
    if (!body) {
      throw new Error("生成失败，请稍后再试。");
    }

    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let finalReplies: Reply[] | null = null;

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(trimmed);
      } catch (error) {
        console.warn("忽略无法解析的流数据", error, trimmed);
        return;
      }
      if (!payload || typeof payload !== "object") {
        return;
      }
      const type = (payload as { type?: string }).type;
      if (type === "partial" && Array.isArray((payload as { replies?: unknown }).replies)) {
        const partial = normalizeReplyPayload((payload as { replies: unknown[] }).replies);
        if (partial.length > 0) {
          setReplies(partial);
        }
        return;
      }
      if (type === "complete" && Array.isArray((payload as { replies?: unknown }).replies)) {
        const final = normalizeReplyPayload((payload as { replies: unknown[] }).replies);
        if (final.length > 0) {
          finalReplies = final;
          setReplies(final);
          setLastGeneratedAt(new Date());
        }
        return;
      }
      if (type === "error") {
        const rawError = (payload as { error?: unknown }).error;
        throw new Error(
          typeof rawError === "string" && rawError.trim()
            ? rawError.trim()
            : "生成失败，请稍后再试。"
        );
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          processLine(line);
        }
      }
      if (buffer.trim().length > 0) {
        processLine(buffer);
      }
      if (!Array.isArray(finalReplies)) {
        throw new Error("生成失败，请稍后再试。");
      }
      if (finalReplies.length === 0) {
        throw new Error("生成失败，请稍后再试。");
      }
    } catch (streamError) {
      await reader.cancel(streamError instanceof Error ? streamError.message : undefined);
      throw streamError;
    } finally {
      reader.releaseLock();
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!opponentLine.trim()) {
      setError("先告诉我对方说了什么，才能帮你回击。");
      return;
    }
    setLoading(true);
    setError(null);
    setCopiedId(null);
    setReplies([]);
    setLastGeneratedAt(null);

    try {
      const response = await fetch("/api/argue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          opponentLine: opponentLine.trim(),
          intensity
        })
      });

      if (!response.ok) {
        const problem = await safeJson(response);
        throw new Error(normalizeErrorMessage(problem));
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/x-ndjson") && response.body) {
        await consumeStream(response);
      } else {
        const payload = (await response.json()) as { replies?: string[] };
        const nextReplies = normalizeReplyPayload(payload.replies ?? []);
        if (nextReplies.length === 0) {
          throw new Error("模型没有返回内容，请再试一次。");
        }
        setReplies(nextReplies);
        setLastGeneratedAt(new Date());
      }
    } catch (requestError) {
      console.error(requestError);
      setError(
        requestError instanceof Error
          ? requestError.message
          : "生成失败，请稍后再试。"
      );
      setReplies([]);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (reply: Reply) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setError("当前浏览器不支持复制，请手动复制。");
      return;
    }
    try {
      await navigator.clipboard.writeText(reply.text);
      setCopiedId(reply.id);
    } catch (copyError) {
      console.error(copyError);
      setError("复制失败，请手动试试看。");
    }
  };

  return (
    <main className={styles.page}>
      <div className={styles.content}>
        <section className={styles.card}>
          <div className={styles.headingSection}>
            <h1 className={styles.heading}>吵架包赢</h1>
            <p className={styles.subheading}>
              输入对方的话，调好语气强度，一键生成三条高能反击。
            </p>
          </div>

          <form className={styles.form} onSubmit={handleSubmit}>
            <div className={styles.fieldGroup}>
              <div className={styles.labelRow}>
                <label className={styles.label} htmlFor="opponentLine">
                  对方的话
                </label>
                <span className={styles.helper}>支持粘贴多段内容</span>
              </div>
              <textarea
                id="opponentLine"
                name="opponentLine"
                value={opponentLine}
                onChange={(event) => setOpponentLine(event.target.value)}
                placeholder="比如：你这么笨，少说两句吧。"
                className={styles.textarea}
                maxLength={800}
                autoFocus
              />
            </div>

            <div className={styles.fieldGroup}>
              <div className={styles.labelRow}>
                <span className={styles.label}>语气强烈程度</span>
                <span className={styles.helper}>
                  {MIN_INTENSITY} 温和 - {MAX_INTENSITY} 硬刚
                </span>
              </div>

              <div className={styles.sliderRow}>
                <input
                  type="range"
                  min={MIN_INTENSITY}
                  max={MAX_INTENSITY}
                  value={intensity}
                  onChange={(event) =>
                    setIntensity(
                      clampIntensity(Number.parseInt(event.target.value, 10))
                    )
                  }
                  className={styles.slider}
                  style={sliderStyle}
                  aria-label="语气强烈程度"
                />
                <div className={styles.intensityRow}>
                  <span className={styles.helper}>
                    {intensity <= 3
                      ? "礼貌但不失锋芒"
                      : intensity <= 7
                        ? "直接又有分寸"
                        : "该出手时就出手"}
                  </span>
                  <span className={styles.intensityBadge}>
                    {intensity}/10
                  </span>
                </div>
              </div>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <button
              type="submit"
              className={styles.submitButton}
              disabled={loading || !opponentLine.trim()}
            >
              {loading ? "模型准备中..." : "开始吵架"}
            </button>

            {loading && (
              <div className={styles.loadingBar}>
                <span />
              </div>
            )}
          </form>

          <hr className={styles.divider} />

          <div className={styles.resultsWrapper}>
            <h2 className={styles.resultsHeading}>候选反击</h2>
            {replies.length === 0 && !loading ? (
              <div className={styles.emptyState}>
                生成结果会出现在这里。试着输入最刺痛你的一句，看看模型怎么回。
              </div>
            ) : (
              <div className={styles.resultsList}>
                {replies.map((reply) => (
                  <article key={reply.id} className={styles.bubble}>
                    <p>{reply.text}</p>
                    <footer className={styles.bubbleFooter}>
                      <span>
                        强度 {intensity}/10
                        {lastGeneratedAt
                          ? ` · ${formatTime(lastGeneratedAt)}`
                          : null}
                      </span>
                      <button
                        type="button"
                        className={styles.copyButton}
                        onClick={() => handleCopy(reply)}
                      >
                        {copiedId === reply.id ? "已复制" : "复制"}
                      </button>
                    </footer>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function clampIntensity(raw: number) {
  if (Number.isNaN(raw)) return DEFAULT_INTENSITY;
  return Math.min(Math.max(raw, MIN_INTENSITY), MAX_INTENSITY);
}

async function safeJson(response: Response) {
  try {
    return (await response.json()) as { error?: unknown };
  } catch (error) {
    console.warn("Failed to parse error payload", error);
    return null;
  }
}

function normalizeErrorMessage(problem: { error?: unknown } | null | undefined) {
  if (!problem || typeof problem.error === "undefined" || problem.error === null) {
    return "生成失败，请稍后再试。";
  }
  if (typeof problem.error === "string") {
    return transformServerMessage(problem.error);
  }
  if (
    typeof problem.error === "object" &&
    "message" in problem.error &&
    typeof (problem.error as { message?: unknown }).message === "string"
  ) {
    const message = (problem.error as { message: string }).message;
    return transformServerMessage(message);
  }
  return "生成失败，请稍后再试。";
}

function normalizeReplyPayload(candidate: unknown[]) {
  return candidate
    .filter((reply) => typeof reply === "string" && reply.trim().length > 0)
    .slice(0, 3)
    .map((reply, idx) => ({
      id: idx + 1,
      text: reply.trim()
    }));
}

function transformServerMessage(raw: string) {
  const message = raw.trim();
  if (!message) {
    return "生成失败，请稍后再试。";
  }
  if (message.includes("No endpoints found matching your data policy")) {
    return "当前密钥未允许使用免费模型（需要开启数据分享）。请前往 OpenRouter 设置：https://openrouter.ai/settings/privacy 启用数据发布或更换其他模型。";
  }
  if (message.toLowerCase().includes("provider returned error")) {
    return "模型提供方暂时异常，已尝试自动切换。如仍失败，请稍后再试或在 .env.local 中设置 OPENROUTER_MODEL/OPENROUTER_MODELS 更换模型。";
  }
  return message;
}

function formatTime(date: Date) {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes <= 1) {
    return "刚刚";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }
  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
