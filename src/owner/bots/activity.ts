/** Crawler visits read from the owner's access logs or CDN analytics, each identity verified where the operator allows. */
export interface BotActivity {
  /** When the data was read; windows such as "the last 30 days" end here. */
  readonly fetchedAt: string;
}
