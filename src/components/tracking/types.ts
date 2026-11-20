// Formes renvoyées par les fonctions site_stats_* (agrégats calculés en base).
export type SeriesPoints = { bucket: "day" | "week"; points: { d: string; visits?: number; visitors?: number; bookings?: number; by: Record<string, number>; impressions?: number; clicks?: number }[] };
export type Kpis = { visits: number; visitors: number; bookings: number; rate: number; ai_visits: number; cta_visits: number; pageviews: number };
export type Overview = { from: string; to: string; previous_from: string; previous_to: string; kpis: Kpis; previous: Kpis; series: SeriesPoints; has_data: boolean };
export type Live = { visitors: number; pages: { path: string; n: number }[] };
export type Options = { campaigns: string[]; pages: string[]; countries: string[] };
export type Recommendation =
  | { kind: "connector"; data: { provider: "gsc" | "bing"; status: string } }
  | { kind: "keyword"; data: { query: string; provider: string; position: number; impressions: number; clicks: number } }
  | { kind: "page"; data: { path: string; visits: number } }
  | { kind: "trend"; data: { scope: "channel" | "campaign"; name: string; visits: number; previous: number; change: number } }
  | { kind: "untagged"; data: { channel: string; source: string | null; visits: number } }
  | { kind: "ai_unread"; data: { path: string; visits: number } };

export type SourcesReport = {
  channels: { channel: string; visits: number; visitors: number; previous_visits: number; bookings_first: number; bookings_last: number }[];
  details: { channel: string; source: string; visits: number; visitors: number; bookings_first: number; bookings_last: number }[];
  referrers: { host: string; visits: number; visitors: number; bookings: number }[];
  declared: { declared: string; measured: string; n: number }[];
  bookings: number; series: SeriesPoints;
};
export type CampaignsReport = {
  campaigns: { campaign: string; visits: number; visitors: number; pageviews: number; avg_duration: number; sources: string[] | null; mediums: string[] | null; bookings: number; bookings_first: number }[];
  links: { id: string; name: string; url: string; path: string; utm_source: string; utm_medium: string; utm_campaign: string; utm_content: string | null; created_at: string; visits: number; visitors: number; pageviews: number; bookings: number }[];
  top: string[]; series: SeriesPoints;
};
export type PagesReport = { visits: number; pages: { path: string; views: number; visits: number; avg_duration: number; avg_scroll: number; entries: number; bounces: number; exits: number; exit_rate: number; bookings: number; rate: number }[] };
export type Touch = { channel: string | null; source: string | null; campaign: string | null };
export type ProspectsReport = { prospects: { key: string; company_id: string | null; company_name: string | null; person_name: string | null; booked: boolean; counted: boolean; converted_at: string | null; booking_starts_at: string | null; booking_status: string | null; first: Touch; last: Touch; declared_source: string | null; visits: number; last_visit_at: string | null }[] };
export type SeoReport = {
  connections: { provider: "gsc" | "bing"; status: string; site_url: string | null; last_sync_at: string | null; history_done: boolean; last_error: string | null }[];
  has_data: boolean;
  totals: { clicks: number; impressions: number; previous_clicks: number; previous_impressions: number };
  series: SeriesPoints;
  queries: { provider: string; query: string; clicks: number; impressions: number; position: number | null; ctr: number; previous_position: number | null; previous_clicks: number | null; page: string | null; page_bookings: number | null }[];
  pages: { provider: string; page: string; clicks: number; impressions: number; position: number | null; visits: number; bookings: number; queries: number }[];
  query: string | null;
  positions: { d: string; by: Record<string, number>; clicks: number }[];
};
export type AiReport = {
  engines: { source: string; visits: number; visitors: number; avg_duration: number; avg_pages: number; bookings: number; bookings_first: number }[];
  landing: { path: string; visits: number }[];
  series: SeriesPoints;
  bots: { bot: string; kind: "ai" | "search" | "other"; hits: number; verified: number | null; unverified: number | null; unverifiable: number | null; pages: number; days: number; last_at: string }[];
  bot_pages: { bot: string; path: string; hits: number; days: number; last_at: string }[];
  bot_series: SeriesPoints;
  unread: { path: string; views: number }[];
  has_bots: boolean;
};
export type GeoReport = {
  visits: number; returning: number;
  countries: { country: string; visits: number; visitors: number; bookings: number }[];
  devices: { device: string; visits: number; avg_duration: number; bookings: number }[];
  browsers: { browser: string; visits: number }[];
};
