/**
 * ElevenLabs Text-to-Speech Client (JS port)
 *
 * Handles TTS generation using ElevenLabs API.
 * Supports dynamic voice selection based on character name,
 * with fuzzy matching and per-language voice IDs.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { requireEnv } from '../utils/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_VOICE_JSON = join(__dirname, '../../config/character_voiceID_elevenLabs.json');

export class ElevenLabsTTSClient {
  /**
   * @param {object} opts
   * @param {string} [opts.apiKey]                  — falls back to ELEVENLABS_API_KEY env
   * @param {string} [opts.characterVoiceJsonPath]  — path to character_voiceID_elevenLabs.json
   *                                                  defaults to config/character_voiceID_elevenLabs.json
   */
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || requireEnv('ELEVENLABS_API_KEY');
    this.characterVoices = null; // loaded lazily
    this._characterVoiceJsonPath = opts.characterVoiceJsonPath || DEFAULT_VOICE_JSON;
  }

  // ------------------------------------------------------------------
  // Character voice mapping
  // ------------------------------------------------------------------

  /**
   * Load character→voice mapping from JSON.
   * Expected shape:
   *   { "DC_ANIL_MMV_NARRATOR": { "voice_id_en": "xxx", "voice_id_hi": "yyy" }, ... }
   */
  async loadCharacterVoices(jsonPath) {
    const path = jsonPath || this._characterVoiceJsonPath;
    if (!path) throw new Error('No characterVoiceJsonPath provided');
    const raw = JSON.parse(await readFile(path, 'utf-8'));
    if (!raw || Object.keys(raw).length === 0) {
      throw new Error(`Character voice JSON at ${path} is empty`);
    }
    this.characterVoices = raw;
    return raw;
  }

  /**
   * Fuzzy-match a character name against the loaded voice mapping keys.
   *
   * Strategies (in order):
   *   1. Exact match (case-insensitive, space→underscore)
   *   2. Character name is a substring of a key
   *   3. Significant name parts match (stripping common suffixes)
   */
  findMatchingCharacterId(characterName) {
    if (!characterName || !this.characterVoices) return null;

    const normalized = characterName.toUpperCase().trim().replace(/\s+/g, '_');
    const keys = Object.keys(this.characterVoices);

    // Strategy 1 — exact
    for (const id of keys) {
      if (id.toUpperCase() === normalized) return id;
    }

    // Strategy 2 — substring
    for (const id of keys) {
      if (id.toUpperCase().includes(normalized)) return id;
    }

    // Strategy 3 — significant name parts
    const suffixes = new Set(['BHAIYA', 'SIR', 'JI', 'MADAM', 'DIDI', 'BEN']);
    const significantParts = normalized.split('_').filter(p => p && !suffixes.has(p));

    for (const id of keys) {
      const idParts = id.toUpperCase().split('_');
      if (significantParts.length && significantParts.some(p => idParts.includes(p))) {
        return id;
      }
    }

    return null;
  }

  /**
   * Resolve a voice ID for a character + language.
   * Falls back to a gendered default if the character isn't mapped.
   */
  getVoiceIdForCharacter(characterName, language = 'en') {
    const charId = this.findMatchingCharacterId(characterName);

    if (!charId) {
      throw new Error(
        `Character '${characterName}' not found in voice mapping. ` +
        `Available: ${Object.keys(this.characterVoices || {}).join(', ')}`
      );
    }

    const voiceKey = `voice_id_${language}`;
    const voiceId = this.characterVoices[charId]?.[voiceKey];

    if (!voiceId) {
      throw new Error(
        `No voice_id found for '${characterName}' (matched '${charId}') ` +
        `with language '${language}'. Expected key '${voiceKey}'.`
      );
    }

    return voiceId;
  }

  // ------------------------------------------------------------------
  // TTS generation
  // ------------------------------------------------------------------

  /**
   * Generate speech from text.
   *
   * @param {object} opts
   * @param {string}  opts.text         — text to synthesise
   * @param {string}  opts.outputPath   — file path for the .mp3
   * @param {string}  [opts.characterName] — resolves voice from mapping
   * @param {string}  [opts.language]   — 'en' | 'hi' | … (default 'en')
   * @param {string}  [opts.voiceId]    — explicit voice ID (overrides character)
   * @param {string}  [opts.modelId]    — ElevenLabs model (default 'eleven_v3')
   * @returns {{ success, outputPath, voiceId, textLength, characterName?, language? }}
   */
  async generateSpeech({
    text,
    outputPath,
    characterName,
    language = 'en',
    voiceId,
    modelId = 'eleven_v3',
  }) {
    try {
      // Resolve voice
      if (!voiceId) {
        if (!characterName) {
          throw new Error("Either 'characterName' or 'voiceId' must be provided.");
        }
        voiceId = this.getVoiceIdForCharacter(characterName, language);
      }

      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: 1.0,
            use_speaker_boost: true,
          },
        }),
        signal: AbortSignal.timeout(180_000),
      });

      if (response.status === 429) {
        return { success: false, error: `Rate limited: ${await response.text()}` };
      }

      if (!response.ok) {
        return { success: false, error: `ElevenLabs ${response.status}: ${await response.text()}` };
      }

      // Write audio to disk
      const buffer = Buffer.from(await response.arrayBuffer());
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, buffer);

      const result = { success: true, outputPath, voiceId, textLength: text.length };
      if (characterName) {
        result.characterName = characterName;
        result.language = language;
      }
      return result;

    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Generate speech WITH word-level timestamps.
   * Returns audio + alignment data for syncing OST animations.
   *
   * @param {object} opts — same as generateSpeech
   * @returns {{ success, outputPath, alignment?, voiceId, textLength, error? }}
   *   alignment: Array<{ word, start_ms, end_ms }>
   */
  async generateSpeechWithTimestamps({
    text,
    outputPath,
    characterName,
    language = 'en',
    voiceId,
    modelId = 'eleven_v3',
  }) {
    try {
      if (!voiceId) {
        if (!characterName) {
          throw new Error("Either 'characterName' or 'voiceId' must be provided.");
        }
        voiceId = this.getVoiceIdForCharacter(characterName, language);
      }

      const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            speed: 1.0,
            use_speaker_boost: true,
          },
        }),
        signal: AbortSignal.timeout(180_000),
      });

      if (response.status === 429) {
        return { success: false, error: `Rate limited: ${await response.text()}` };
      }

      if (!response.ok) {
        return { success: false, error: `ElevenLabs ${response.status}: ${await response.text()}` };
      }

      const data = await response.json();

      // Decode base64 audio
      const audioBuffer = Buffer.from(data.audio_base64, 'base64');
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, audioBuffer);

      // Parse alignment: ElevenLabs returns character-level alignment
      // Convert to word-level timestamps
      const alignment = this._buildWordAlignment(data.alignment);

      const result = {
        success: true,
        outputPath,
        voiceId,
        textLength: text.length,
        alignment,
      };
      if (characterName) {
        result.characterName = characterName;
        result.language = language;
      }
      return result;

    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Convert ElevenLabs character-level alignment to word-level timestamps.
   * Input: { characters: ['H','e','l','l','o',' ','w','o','r','l','d'],
   *          character_start_times_seconds: [0.0, 0.05, ...],
   *          character_end_times_seconds: [0.05, 0.1, ...] }
   * Output: [{ word: 'Hello', start_ms: 0, end_ms: 250 }, ...]
   */
  _buildWordAlignment(alignment) {
    if (!alignment || !alignment.characters) return [];

    const chars = alignment.characters;
    const starts = alignment.character_start_times_seconds;
    const ends = alignment.character_end_times_seconds;

    const words = [];
    let currentWord = '';
    let wordStartMs = 0;
    let wordEndMs = 0;

    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];

      if (ch === ' ' || ch === '\n' || ch === '\t') {
        // End of word
        if (currentWord) {
          words.push({
            word: currentWord,
            start_ms: Math.round(wordStartMs * 1000),
            end_ms: Math.round(wordEndMs * 1000),
          });
          currentWord = '';
        }
      } else {
        if (!currentWord) {
          wordStartMs = starts[i];
        }
        currentWord += ch;
        wordEndMs = ends[i];
      }
    }

    // Last word
    if (currentWord) {
      words.push({
        word: currentWord,
        start_ms: Math.round(wordStartMs * 1000),
        end_ms: Math.round(wordEndMs * 1000),
      });
    }

    return words;
  }
}
