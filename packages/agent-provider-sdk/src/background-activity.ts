/** Application-owned provenance. It never changes native execution or delivery evidence. */
export interface BackgroundActivity {
  id: string;
  kind: 'review';
  status: 'pending' | 'silent' | 'visible' | 'failed';
  summary?: string;
}
