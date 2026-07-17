export interface FeedbackDraft { id: string; text: string }

export function addFeedback(list: FeedbackDraft[], id: string, text: string): FeedbackDraft[] {
  return [...list, { id, text }]
}
export function editFeedback(list: FeedbackDraft[], id: string, text: string): FeedbackDraft[] {
  return list.map((f) => (f.id === id ? { ...f, text } : f))
}
export function removeFeedback(list: FeedbackDraft[], id: string): FeedbackDraft[] {
  return list.filter((f) => f.id !== id)
}
export function drainFeedback(list: FeedbackDraft[]): { text: string; drained: FeedbackDraft[] } {
  return { text: list.map((f) => f.text).join('\n'), drained: [] }
}
