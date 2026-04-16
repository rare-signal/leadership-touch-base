export type PersonalityPrimitives = {
  assertiveness: number;
  warmth: number;
  competence_belief: number;
  corporate_fluency: number;
  chaos: number;
};

export type Persona = {
  id: string;
  display_name: string;
  one_liner: string;
  role: string;
  core_motivation: string;
  personality_primitives: PersonalityPrimitives;
  speech_patterns: string[];
  catchphrases: string[];
  triggers: { engages_when: string[]; derails_to: string[] };
  meeting_behavior: string;
  system_prompt: string;
};

export type GruntEntry = {
  path: string;
  text: string;
  duration: number;
  source_video: string;
  source_start: number;
};

export type CharacterAppearance = {
  video_id: string;
  frame_idx?: number;
  note?: string;
};

export type Character = {
  id: string;
  display_name: string;
  aliases: string[];
  role: string;
  visual_description: string;
  voice_register: string;
  signature_phrases: string[];
  appearances: CharacterAppearance[];
  thumb_video_id?: string;
};

export type CharacterPack = {
  character: Character;
  persona?: Persona;
  grunts: GruntEntry[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "character";
  character_id?: string;
  text: string;
  timestamp: number;
};

export type TileBox = {
  idx: number;
  row: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  character_id?: string | null;
};

export type TileDoc = {
  video_id: string;
  layout: string; // "1x1" | "2x2" | "2x3" | "3x2" | "1x2" | "2x1" | "1x3" | "3x1" | "skip"
  source_size: [number, number];
  content_bbox: [number, number, number, number]; // x,y,w,h
  tiles: TileBox[];
  confidence: number;
  character_id_by_tile: Record<string, string>; // tile_idx (stringified) -> character_id
  notes?: string;
};
