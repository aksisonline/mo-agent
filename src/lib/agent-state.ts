import type { AgentState } from "../schemas/conversation";
import type { ScopeAnswer } from "../schemas/decision";

// Cosmetic, untrusted client state only. Never use this for permissions or security.
// One point cools every five minutes, so even maximum irritation expires in 15 minutes.
export const FRUSTRATION_COOLDOWN_MS = 5 * 60 * 1000;
// Upper half of level 3: a millisecond of decay must not immediately bypass the boundary.
export const FRUSTRATION_BOUNDARY_THRESHOLD = 2.5;
export function cooledAgentState(state?: AgentState, now = Date.now()): AgentState {
  const elapsed = Math.max(0, now - Math.min(state?.updatedAt ?? now, now));
  return {
    frustration: Math.max(
      0,
      Math.min(3, state?.frustration ?? 0) - elapsed / FRUSTRATION_COOLDOWN_MS,
    ),
    updatedAt: now,
  };
}
export type IrritationSignals = {
  hopping: number;
  abuse: number;
  calming: number;
  focused: number;
};
export function nextAgentState(
  state: AgentState | undefined,
  scope: ScopeAnswer["choice"],
  signals: IrritationSignals,
  latest: string,
  now = Date.now(),
): AgentState {
  const cooled = cooledAgentState(state, now);
  // Recovery remains available even if JEV fails. No apology or emotional performance required.
  const acknowledgment =
    /^(?:ok(?:ay)?|thanks?(?: you)?|understood|got it|fair enough|sorry|let's focus|calm down)[.!\s]*$/i.test(
      latest.trim(),
    );
  const focused = /\b(?:mo|owner|portfolio|project|experience|skills)\b/i.test(latest);
  const abusive = scope === "abuse" || signals.abuse >= 0.7;
  const calm =
    !abusive &&
    (acknowledgment ||
      signals.calming >= 0.7 ||
      (scope === "on_topic" && (focused || signals.focused >= 0.7)));
  const change = abusive
    ? 1
    : calm
      ? -1
      : scope === "off_topic" || signals.hopping >= 0.7
        ? 0.5
        : 0;
  return { frustration: Math.max(0, Math.min(3, cooled.frustration + change)), updatedAt: now };
}
