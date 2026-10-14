export const formatName = (s: string): string => s.trim();

export function formatTimestamp(date: Date): string {
  return date.toISOString();
}
