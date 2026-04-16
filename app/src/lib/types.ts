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
