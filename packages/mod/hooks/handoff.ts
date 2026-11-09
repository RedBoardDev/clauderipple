// The band's Handoff (2026-10-24): one press has the session's own model write a resume note in a
// fork, and a new session in the same folder opens with it in its prompt box. App changes do not
// reach a chat already open (a /clear keeps it), so moving on to a new session is the only way to
// take them up; the button folds "write a handoff, wait, open a session, paste" into one press and
// one Enter. No advice judge, no choice panel, no settings: those were removed with 8480bae and
// stay removed.

export const QUICK_PROMPT = `Prepare a concise resume note for a fresh coding chat, in the user's language, about forty lines of bullets. Use only this conversation; do not run tools. Record project, folder and branch if known, the goal, verified completed work, unfinished work and blockers, git state as last checked, decisions and failed approaches, permissions or resume details, and the highest-priority runnable next action. Mark actions requiring the user. Keep only current relevant state and point to files or specs instead of copying them. Exclude secrets, environment values and raw logs. Output only the note, without an introduction or farewell.`

/** The note as the new session's first prompt: the context, then go on with the next action. */
export function wrapForNewChat(text: string): string {
  return `Resume context from the previous chat:\n\n${text.trim()}\n\nContinue with the justified next action. If it needs my permission or input, explain what is needed and wait.`
}
