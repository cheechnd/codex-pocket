export interface ThreadStatus { type: string; activeFlags?: string[] }
export interface Thread { id: string; name?: string | null; cwd: string; preview?: string; updatedAt?: number; recencyAt?: number | null; status: ThreadStatus; latestTurn?: { id: string; status: string } }
export interface SavedThread extends Thread { loaded: boolean }
export interface SavedPage { data: SavedThread[]; nextCursor: string | null }
export interface QuestionTarget { itemId: string; turnId: string }
export interface Item { delivery?: string | null; questions?: { title: string; options?: string[] | null }[] | null; id: string; clientId?: string | null; type: string; text?: string; content?: { type: string; text?: string; url?: string; path?: string }[]; status?: string; command?: string }
export interface Entry { turnId: string; item: Item }
export interface Page { data: Entry[]; nextCursor: string | null }
export interface Notice { method: string; params: Record<string, any>; requestId?: string | number }
export class PocketError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export interface Submission {
  id: string; threadId: string; state: 'sending' | 'accepted' | 'completed' | 'failed' | 'outcome-unknown';
  turnId?: string; message?: string;
}
