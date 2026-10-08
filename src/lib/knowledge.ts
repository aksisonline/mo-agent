// Replace these empty sections with facts you have permission to publish.
// Knowledge is bundled at deploy time; visitor-provided URLs are never fetched.
export const KNOWLEDGE_SOURCE = "Not configured";
export const KNOWLEDGE_FETCHED_AT = "Not configured";
export const BASE_KNOWLEDGE =
  "No portfolio owner facts have been configured. Say that details are unavailable; never invent a biography or contact information.";
export const KNOWLEDGE_DETAILS = {
  experience: "",
  skills: "",
  projects: "",
  education: "",
  recognition: "",
} as const;
export type KnowledgeSection = keyof typeof KNOWLEDGE_DETAILS;

// JEV opens the gate; keywords select only from this bounded, server-owned snapshot.
export function additionalKnowledge(messages: { content: string }[]): string {
  const text = messages
    .slice(-3)
    .map((message) => message.content)
    .join(" ");
  const selectors: Record<KnowledgeSection, RegExp> = {
    experience: /experience|work|role|career/i,
    skills: /skill|stack|tool|creative|design|language/i,
    projects: /project|github|built|demo/i,
    education: /education|degree|university|college|studied/i,
    recognition: /award|recognition|hack|mentor|talk|speaker/i,
  };
  const sections = (Object.keys(selectors) as KnowledgeSection[]).filter((key) =>
    selectors[key].test(text),
  );
  return (sections.length ? sections : (Object.keys(KNOWLEDGE_DETAILS) as KnowledgeSection[]))
    .map((key) => `${key}: ${KNOWLEDGE_DETAILS[key]}`)
    .join("\n");
}
