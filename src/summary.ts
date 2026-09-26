export function validateSummary(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > 3 ||
    !parsed.every(
      (item) =>
        typeof item === "string" &&
        item.trim() &&
        /\p{Script=Han}/u.test(item) &&
        !/[。！？!?].+/.test(item.trim()) &&
        !/[\r\n]/.test(item),
    )
  )
    return undefined;
  const result = parsed
    .map((item: string) => item.trim().replace(/[。！？!?]$/, "") + "。")
    .join("");
  return result.length <= 150 ? result : undefined;
}

export function fallback(
  outcome: "completed" | "aborted" | "error" | "unknown",
): string {
  switch (outcome) {
    case "error":
      return "本轮运行出错，请查看终端结果。";
    case "aborted":
      return "本轮运行已取消，请查看终端结果。";
    default:
      return "本轮运行已结束，请查看终端结果。";
  }
}
