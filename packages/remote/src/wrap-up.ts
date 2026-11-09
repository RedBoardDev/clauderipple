// The Claude app's Code tab closes a turn with its own tools, and the mark they leave in the
// transcript is read by both ends: the host from a tail window (a sidebar line, a push), the phone
// from the tool rows it already has. Pure string handling only, so the host and the browser share
// exactly one set of limits.

/** The Code tab's turn-closing tool: a recap, one question the person answers, optional reply buttons. */
export const WRAP_TOOL = "mcp__ccd_turn__wrap_up";
/** The app's own limits: the recap, the question, a button's label and the message it sends. */
export const WRAP_LIMITS = { recap: 300, ask: 100, label: 24, message: 300 } as const;
/** The Claude app puts the recap's first sentence in its sidebar; it is at most this long. */
export const STATUS_CAP = 200;

/** One line of text the way the app writes it: whitespace collapsed, at most `max` characters. */
export function wrapText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** The first sentence of `text`, its terminator kept; at most `max` characters. */
export function firstSentence(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = /[.!?…。？！](?=\s|$)/.exec(flat);
  return (end ? flat.slice(0, end.index + end[0].length) : flat).slice(0, max);
}

/** A reply button in the closing box: `label` on the button, `message` what a tap sends. */
export interface WrapUpReply { label: string; message: string }

/** A wrap_up call's fields, as the closing box and the pushes both read them. */
export interface WrapUpFields { recap: string; ask: string; blocked: boolean; replies: WrapUpReply[] }

/** A wrap_up call's fields from its input. App buttons such as commit or create PR run inside the
 * Mac app, so only reply buttons carry a label and come over. */
export function wrapUpFields(input: Record<string, unknown>): WrapUpFields {
  const replies = (Array.isArray(input.actions) ? input.actions : []).flatMap((value): WrapUpReply[] => {
    const action = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    const label = wrapText(action.label, WRAP_LIMITS.label);
    return action.action === undefined && label ? [{ label, message: wrapText(action.message, WRAP_LIMITS.message) || label }] : [];
  }).slice(0, 2);
  return {
    recap: wrapText(input.recap, WRAP_LIMITS.recap),
    ask: wrapText(input.ask, WRAP_LIMITS.ask),
    blocked: input.blocked === true || input.blocked === "true",
    replies,
  };
}
