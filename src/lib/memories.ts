import type { Memory } from "../schemas/conversation";

export function activeMemories(memories: Memory[], now = Date.now()): Memory[] {
  return memories.filter((memory) => memory.expiresAt > now).slice(-24);
}
