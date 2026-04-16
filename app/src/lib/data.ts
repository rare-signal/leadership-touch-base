/** Server-side loaders that read pipeline outputs from ../data/. */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Character, CharacterPack, GruntEntry, Persona, TileDoc } from "./types";

// app/src/lib -> app -> repo root
export const REPO_ROOT = path.resolve(process.cwd(), "..");
export const DATA_DIR = path.join(REPO_ROOT, "data");

async function readJsonIfExists<T>(p: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function loadCharacters(): Promise<Character[]> {
  const doc = await readJsonIfExists<{ characters: Character[] }>(
    path.join(DATA_DIR, "characters", "characters.json")
  );
  return doc?.characters ?? [];
}

export async function loadPersona(id: string): Promise<Persona | null> {
  return readJsonIfExists<Persona>(path.join(DATA_DIR, "personas", `${id}.json`));
}

export async function loadGruntSprite(): Promise<Record<string, GruntEntry[]>> {
  return (
    (await readJsonIfExists<Record<string, GruntEntry[]>>(
      path.join(DATA_DIR, "grunts", "sprite.json")
    )) ?? {}
  );
}

export async function loadCharacterPacks(): Promise<CharacterPack[]> {
  const [chars, sprite] = await Promise.all([loadCharacters(), loadGruntSprite()]);
  const packs = await Promise.all(
    chars.map(async (character) => {
      const persona = await loadPersona(character.id);
      return {
        character,
        persona: persona ?? undefined,
        grunts: sprite[character.id] ?? [],
      } satisfies CharacterPack;
    })
  );
  return packs;
}

export function safeId(id: string): string {
  return /^[a-z0-9_-]+$/i.test(id) ? id : "";
}

export async function loadTileDoc(vid: string): Promise<TileDoc | null> {
  return readJsonIfExists<TileDoc>(path.join(DATA_DIR, "tiles", `${vid}.json`));
}

export async function loadAllTileDocs(): Promise<TileDoc[]> {
  const dir = path.join(DATA_DIR, "tiles");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const jsons = entries.filter((e) => e.endsWith(".json")).sort();
  const docs = await Promise.all(
    jsons.map(async (name) => {
      const p = path.join(dir, name);
      return readJsonIfExists<TileDoc>(p);
    })
  );
  return docs.filter((d): d is TileDoc => !!d);
}

export async function saveTileDoc(vid: string, doc: TileDoc): Promise<void> {
  const p = path.join(DATA_DIR, "tiles", `${vid}.json`);
  await fs.writeFile(p, JSON.stringify(doc, null, 2));
}
