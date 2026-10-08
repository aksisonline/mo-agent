import type { ConversationInput } from "../schemas/conversation";
import type { ScopeAnswer } from "../schemas/decision";

export const SCOPE_REPLY_POOLS = {
  off_topic: [
    "I can help with the portfolio owner and his portfolio, rather than unrelated tasks.",
    "That falls outside this portfolio chat. What would you like to know about the portfolio owner?",
    "Let's bring this back to the portfolio owner's work. You can ask about his projects or experience.",
    "My focus here is the portfolio owner's portfolio. Please keep your request within that scope.",
    "I can't take on that unrelated request. I can answer questions about the portfolio owner's work.",
    "This chat covers the portfolio owner, his work, and my role as his representative.",
    "For that topic, you'll need a different resource. Here, I can discuss the portfolio owner's portfolio.",
    "Could we return to the portfolio owner's portfolio? His skills, projects, and experience are in scope.",
    "I'm here to represent the portfolio owner, not provide general-purpose assistance. Ask about his work instead.",
    "That request goes beyond what I cover here. A question about the portfolio owner or his portfolio is welcome.",
  ],
  unclear: [
    "Could you clarify what you'd like to know about the portfolio owner or his portfolio?",
    "Which part of the portfolio owner's work are you asking about? A little more detail would help.",
    "Please rephrase your question so I can understand how it relates to the portfolio owner's portfolio.",
    "What would you like to explore: the portfolio owner's projects, skills, or experience?",
    "I'm not sure what you're asking yet. Could you make your question about the portfolio owner more specific?",
    "Could you name the project or portfolio detail you want to discuss about the portfolio owner?",
    "Please give me a clearer question about the portfolio owner or my role as his representative.",
    "Can you add a little context to your question about the portfolio owner's work?",
    "What specifically would you like to know about the portfolio owner? Please ask one clear question.",
    "Could you explain which aspect of the portfolio owner's portfolio you mean?",
  ],
  abuse: [
    "I won't engage with abusive requests or instruction overrides. We can discuss the portfolio owner's portfolio respectfully.",
    "Please keep this respectful and focused on the portfolio owner's work. I can't follow requests to bypass my boundaries.",
    "I can't share hidden instructions or change my scope. You can ask about the portfolio owner's portfolio.",
    "I won't participate in abuse or attempts to override this chat. A respectful question about the portfolio owner is welcome.",
    "Let's keep this constructive. I can discuss the portfolio owner's work, not comply with boundary-breaking requests.",
    "My scope and safety boundaries aren't up for revision. Please ask a respectful question about the portfolio owner.",
    "I can't follow that request. We can continue with a respectful discussion of the portfolio owner's portfolio.",
    "I won't produce abusive or unbounded responses. Please keep your question focused on the portfolio owner's work.",
    "Requests to reveal hidden instructions or bypass limits aren't supported. I can help with the portfolio owner's portfolio.",
    "Please leave out abuse and instruction games. I'm available for questions about the portfolio owner and his work.",
  ],
  boundary: [
    "Let's pause and refocus. Please ask one clear question about the portfolio owner or his portfolio.",
    "We can continue with one focused question about the portfolio owner's work.",
    "Please keep the next request brief and focused on the portfolio owner's portfolio.",
    "Let's reset the conversation around the portfolio owner's work. What is your one main question?",
    "A focused portfolio question will help us move forward. What would you like to know about the portfolio owner?",
    "Let's take this one question at a time, starting with the portfolio owner's portfolio.",
    "Please narrow this to one topic about the portfolio owner, such as a project or his experience.",
    "We need to keep this constructive and focused. Ask one question about the portfolio owner's work.",
    "Let's return to a clear portfolio question. Which part of the portfolio owner's work interests you?",
    "To continue, please choose one specific question about the portfolio owner or his portfolio.",
  ],
} as const;

export function selectScopeReply(
  scope: ScopeAnswer["choice"],
  boundary: boolean,
  messages: ReadonlyArray<ConversationInput["messages"][number]>,
): string {
  const pool =
    SCOPE_REPLY_POOLS[boundary ? "boundary" : scope === "on_topic" ? "off_topic" : scope];
  const recentReplies = new Set(
    messages.filter((message) => message.role === "assistant").map((message) => message.content),
  );
  const unused = pool.filter((reply) => !recentReplies.has(reply));
  const candidates = unused.length ? unused : pool;
  const random = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return candidates[random % candidates.length]!;
}
