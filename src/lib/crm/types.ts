// Types des lignes renvoyées par Supabase (alignés sur supabase/migrations).

export type Channel = "linkedin" | "email" | "phone" | "other";
export type ProspectStatus = "nouveau" | "contacte" | "en_discussion" | "qualifie" | "pas_interesse";
export type DealStatus = "open" | "won" | "lost";
export type ParticipantStatus = "a_contacter" | "en_cours" | "a_repondu" | "termine" | "arrete";
export type InteractionKind =
  | "note" | "message_out" | "message_in" | "call" | "meeting"
  | "stage_change" | "deal_status" | "prospecting" | "task_done" | "merge" | "system";

export type Company = {
  id: string;
  name: string;
  website: string | null;
  domain_norm: string | null;
  description: string | null;
  source_id: string | null;
  tags: string[];
  prospect_status: ProspectStatus;
  pipeline_id: string | null;
  stage_id: string | null;
  deal_status: DealStatus;
  amount: number | null;
  expected_close_date: string | null;
  lost_reason: string | null;
  deal_closed_at: string | null;
  last_interaction_at: string | null;
  archived_at: string | null;
  merged_into_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CompanyOverview = Company & {
  primary_person_id: string | null;
  primary_person_name: string | null;
  primary_person_email: string | null;
  people_count: number;
  list_ids: string[];
  next_action_title: string | null;
  next_action_due: string | null;
  next_action_type: "task" | "followup" | null;
  people_search: string;
};

export type Person = {
  id: string;
  company_id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  is_primary: boolean;
  created_at: string;
};

export type Interaction = {
  id: string;
  company_id: string;
  person_id: string | null;
  kind: InteractionKind;
  channel: Channel | null;
  occurred_at: string;
  content: string | null;
  content_origin: "user" | "claude_suggestion" | "system";
  source: "user" | "claude" | "import" | "system";
  campaign_participant_id: string | null;
  meta: Record<string, unknown>;
  created_at: string;
};

export type Task = {
  id: string;
  company_id: string;
  person_id: string | null;
  title: string;
  due_date: string;
  done_at: string | null;
  source: "user" | "claude";
  created_at: string;
};

export type CampaignStep = { position: number; name: string; channel: Channel; delay_days: number; message: string | null };

export type Participant = {
  id: string;
  campaign_id: string;
  company_id: string;
  person_id: string | null;
  current_step: number;
  status: ParticipantStatus;
  next_due_date: string | null;
  last_done_at: string | null;
  stop_reason: string | null;
  campaign: { id: string; name: string; archived_at: string | null; steps: CampaignStep[] };
};

export type ClaudeLogEntry = {
  id: number;
  table_name: string;
  operation: string;
  summary: string | null;
  created_at: string;
  data: Record<string, unknown>;
};

export type CompanyDetail = {
  company: Company & {
    source: { id: string; name: string } | null;
    pipeline: { id: string; name: string } | null;
    stage: { id: string; name: string } | null;
  };
  people: Person[];
  interactions: Interaction[];
  tasks: Task[];
  participants: Participant[];
  lists: { id: string; name: string }[];
  claudeLog: ClaudeLogEntry[];
};

export type DuplicateCandidate = {
  company_id: string;
  name: string;
  website: string | null;
  archived: boolean;
  strength: "exact" | "similar";
  reasons: string[];
};

export type SearchResult = { id: string; name: string; website: string | null; archived: boolean; matched: string | null };

export type Stage = { id: string; name: string; position: number };
export type PipelineWithStages = { id: string; name: string; position: number; stages: Stage[] };

export type TodoItem = {
  item_type: "task" | "followup";
  id: string;
  company_id: string;
  company_name: string;
  person_id: string | null;
  person_name: string | null;
  title: string;
  due_date: string;
  campaign_id: string | null;
  campaign_name: string | null;
  channel: Channel | null;
  step_position: number | null;
  step_message: string | null;
};

export type LeadSource = { id: string; name: string; position: number };
export type List = { id: string; name: string; description: string | null; created_at: string };
