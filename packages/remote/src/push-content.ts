import path from "node:path";
import type { PushEvent } from "./protocol.ts";

/** Private context, resolved locally only for devices with a push key. Never sent in clear. */
export interface PushContext { title?: string; cwd?: string; text?: string; tool?: string; summary?: string; error?: string }
export interface PushContent { v: 1; title: string; body: string }

/** Plain notification copy: preserve link labels and code text, not Markdown layout. */
export function pushLine(text: string, max: number): string {
  const plain = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[^\n]*\n/g, " ").replace(/```/g, " ")
    .replace(/<[^>]*>/g, " ").replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/[*_`~]/g, "").replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  const chars = Array.from(plain);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : plain;
}

export function pushContent(event: PushEvent, lang: "ko" | "en", context: PushContext, fallback: string): PushContent {
  const title = pushLine(context.title?.trim() || path.basename(context.cwd ?? "") || "Ripple Remote", 60);
  let body = fallback;
  if (event.kind === "permission") {
    const tool = "tool" in event ? event.tool : context.tool;
    const summary = "summary" in event ? event.summary : context.summary;
    if (tool === "AskUserQuestion" || tool === "ExitPlanMode" || tool === "EnterPlanMode") {
      const label = tool === "AskUserQuestion" ? (lang === "ko" ? "답변이 필요합니다" : "Answer needed")
        : tool === "ExitPlanMode" ? (lang === "ko" ? "계획 검토가 필요합니다" : "Plan review needed")
        : (lang === "ko" ? "계획 모드 전환이 필요합니다" : "Plan mode requested");
      body = [label, summary].filter(Boolean).join(" · ");
    } else {
      const detail = [tool, summary].filter(Boolean).join(": ");
      if (detail) body = `${lang === "ko" ? "승인 필요" : "Needs approval"} · ${detail}`;
    }
  } else if (event.kind === "question") {
    // The closing box's own question is what the person answers; the fixed line says what it is.
    body = `${lang === "ko" ? "답변이 필요합니다" : "Answer needed"} · ${pushLine(event.ask, 140)}`;
  } else if (event.kind === "result") {
    if (event.ok) body = pushLine(context.text ?? "", 180) || fallback;
    else {
      const reason = "error" in event ? event.error : context.error;
      if (reason) body = `${lang === "ko" ? "실패" : "Failed"} · ${reason}`;
    }
  }
  return { v: 1, title, body: pushLine(body, 180) };
}
