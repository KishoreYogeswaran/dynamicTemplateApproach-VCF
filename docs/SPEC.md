# MASTER PROMPT — Educational Video Pipeline: Storyboard → HTML Scenes → Final Video

You are building an automated pipeline that takes a structured JSON storyboard (educational content for Indian micro-entrepreneurs) and produces a complete video by:

1. Generating audio for each scene (ElevenLabs TTS)
2. Generating additional visual assets where needed (avatar videos via WAN + FIBO transparency)
3. Rendering each scene as an animated HTML slide (1920×1080) with embedded media, OSTs, and synced animations
4. Recording each HTML scene as a video clip (Puppeteer)
5. Stitching all scene clips into one final MP4 (FFmpeg)

This is a **production system** — not a prototype. It will process hundreds of storyboards across multiple Indian languages, domains, and themes.

---

## 1. PROJECT STRUCTURE

```
project/
├── config/
│   ├── themes.json              # Theme definitions (base + domain overrides)
│   ├── fonts.json               # Font mappings per language
│   └── elevenlabs.json          # API key, voice IDs per character
├── src/
│   ├── pipeline/
│   │   ├── orchestrator.js      # Main pipeline: reads storyboard, runs all steps
│   │   ├── audio-generator.js   # ElevenLabs TTS per scene
│   │   ├── asset-generator.js   # WAN video gen + FIBO transparency for avatar scenes
│   │   ├── html-renderer.js     # Generates HTML per scene from templates
│   │   ├── scene-recorder.js    # Puppeteer records each HTML as video
│   │   └── video-stitcher.js    # FFmpeg combines all scene clips
│   ├── templates/
│   │   ├── base-layout.html     # Shared HTML shell (fonts, CSS vars, animation framework)
│   │   ├── scenes/
│   │   │   ├── intro-scene.html
│   │   │   ├── learning-objective-scene.html
│   │   │   ├── avatar-image-circle.html
│   │   │   ├── avatar-presenter-torso.html
│   │   │   ├── character-image-torso.html
│   │   │   ├── table-image.html
│   │   │   ├── ai-image-slideshow.html
│   │   │   ├── split-screen-image.html
│   │   │   ├── first-person-video-static-bg.html
│   │   │   ├── panning-video.html
│   │   │   └── character-based-roleplay.html
│   │   └── ost-layouts/         # Fixed set of HTML patterns for OST presentation
│   │       ├── bullet-list.html
│   │       ├── numbered-steps.html
│   │       ├── comparison-cards.html
│   │       ├── icon-text-grid.html
│   │       ├── highlighted-keyphrase.html
│   │       ├── timeline-bar.html
│   │       ├── stat-callout.html
│   │       └── table-layout.html
│   ├── themes/
│   │   ├── base-themes/         # 6 generic base themes
│   │   │   ├── professional-blue.css
│   │   │   ├── warm-earth.css
│   │   │   ├── fresh-green.css
│   │   │   ├── vibrant-orange.css
│   │   │   ├── calm-neutral.css
│   │   │   └── bold-contrast.css
│   │   └── domain-overrides/    # Domain-specific accent overrides
│   │       ├── motor-vehicle-workshop.css
│   │       ├── tailoring.css
│   │       ├── kirana-store.css
│   │       ├── beauty-salon.css
│   │       ├── electrician.css
│   │       └── ... (extensible)
│   └── utils/
│       ├── storyboard-parser.js # Parses JSON, extracts scene data
│       ├── timing-calculator.js # Calculates animation timings from audio duration + word count
│       ├── ost-layout-picker.js # LLM-assisted: picks best OST layout per scene
│       └── font-loader.js       # Loads Google Fonts dynamically per language
├── output/
│   ├── {storyboard_id}/
│   │   ├── audio/               # Generated .mp3 per scene
│   │   ├── assets/              # Generated avatar videos (transparent)
│   │   ├── html/                # Rendered HTML per scene
│   │   ├── clips/               # Recorded video per scene
│   │   └── final.mp4            # Stitched output
├── package.json
└── README.md
```

---

## 2. INPUT: STORYBOARD JSON FORMAT

Each storyboard JSON follows this structure (the pipeline must handle ALL of these fields):

```json
{
  "domain_key": "motor_vehicle_workshop",
  "module_name": "...",
  "lesson_name": "...",
  "ml_id": "ML3",
  "ml_title": "Identify Gaps and Find Your Edge",
  "learning_objectives": ["...", "..."],
  "language": "en",
  "total_word_count": 205,
  "approximate_duration_seconds": 131,
  "number_of_scenes": 9,
  "scenes": [
    {
      "scene_id": "M2_L3_ML3_SC1",
      "character": "Anil",
      "word_count": 11,
      "approx_duration_seconds": 7,
      "vo_scripts": {
        "template_key_voScript_1": "Voice over text...",
        "template_key_voScript_2": "Optional second VO segment..."
      },
      "scene_typology_name": "intro_scene",
      "selected_template_name": "ME_intro_template_1",
      "selected_family_name": "intro_scene_family_1_1avatar_1img_1hdr",
      "characterCrop": "0",
      "characterPosition": "0",
      "content_elements": {
        "headers": { "template_key_header_1": "Header text" },
        "subHeaders": { "template_key_subHeader_1": "Sub header text" },
        "bulletPoints": { "template_key_bulletpoint_1": "Bullet 1", "...": "..." },
        "keyPhrases": { "template_key_keyPhrase_1": "Key phrase text" },
        "media": {
          "compositeImage": "TRUE" | "FALSE",
          "image_aspectRatio": "horizontal" | "vertical" | "square" | "0",
          "numberOf_subImages": 0 | 2 | 3 | 4,
          "template_key_image_1": "https://blob.url/to/image.png",
          "template_key_image_2": "https://...",
          "template_key_image_1_prompt": "AI generation prompt (not needed by pipeline)"
        }
      }
    }
  ]
}
```

### Key parsing rules:
- `vo_scripts` keys are dynamic (prefixed with template name). Concatenate ALL values in order for full VO text. Individual keys map to separate VO segments (important for slideshow timing).
- `content_elements.media` — image URLs use dynamic keys. Filter keys ending in `_image_N` (where N is a digit) to get actual URLs. Keys ending in `_prompt` are generation prompts (ignore in rendering).
- `compositeImage: "TRUE"` means a single pre-composited image containing N sub-images. `"FALSE"` means separate individual images.
- `image_aspectRatio` of `"0"` means no image in this scene.
- `characterCrop` and `characterPosition` are avatar placement hints (values TBD — treat as configurable).

---

## 3. THE 10 SCENE TYPES — TEMPLATE SPECIFICATIONS

Each scene type below needs its own HTML template. The template receives parsed scene data and renders at **1920×1080 (16:9 landscape)**.

### 3.1 `intro_scene`
**Layout:** Full-screen AI-generated background image (9:16 vertical — will be rendered fitting within the 16:9 frame with artistic blur/crop). Circular talking avatar overlay (positioned bottom-left or as configured). Header text overlay (the video title) displayed prominently.
**Content elements used:** 1 header, 1 background image, avatar video overlay.
**Animation:** Header fades/slides in. Background has subtle Ken Burns (slow zoom). Avatar appears with a soft entrance.
**Media:** 1 vertical background image from `media` URLs.
**Avatar overlay:** YES — circular crop avatar video.

### 3.2 `learning_objective_scene`
**Layout:** NO background image. Clean, branded background using theme colors/gradients. Avatar TORSO video on one side (left or right). Learning objectives as bullet points on the other side.
**Content elements used:** 1 header ("Learning Objectives"), 2-4 bullet points, avatar torso video.
**Animation:** Bullet points appear one-by-one, timed to match when the VO mentions each objective. Header enters first, then bullets stagger in.
**Media:** None (no AI image).
**Avatar overlay:** YES — torso crop avatar video (generated via WAN → FIBO transparent pipeline).

### 3.3 `avatar_image_circle`
**Layout:** AI-generated background image (horizontal, fills most of the frame). Circular avatar overlay (bottom-left or configurable). OST elements (header, bullet points, key phrases) overlaid on a semi-transparent card/panel on one side.
**Content elements used:** 1 header, 1-3 bullet points, 0-1 key phrases, 1 background image, avatar circular overlay.
**Animation:** Background image has subtle parallax/Ken Burns. OST elements animate in sequentially, synced to VO. Key phrase gets a highlight/emphasis animation.
**Media:** 1 horizontal background image.
**Avatar overlay:** YES — circular crop avatar video (generated via WAN → FIBO transparent pipeline).

### 3.4 `avatar_presenter_torso` (OUTRO)
**Layout:** NO background image. Clean branded background. Avatar TORSO video on one side. Recap header + bullet points on the other side. May include a closing logo/branding element.
**Content elements used:** 1 header ("Key Takeaways"), 2-4 bullet points, avatar torso video.
**Animation:** Similar to learning_objective_scene — bullet points stagger in synced to VO.
**Media:** None.
**Avatar overlay:** YES — torso crop avatar video (generated via WAN → FIBO transparent pipeline).

### 3.5 `character_image_torso`
**Layout:** AI-generated background image (contextual, NO characters in image). Non-avatar character TORSO video overlay on one side. OST elements (header, bullets, key phrases) on a card/panel.
**Content elements used:** 1 header, 0-3 bullet points, 0-1 key phrases, 1 background image, non-avatar character torso video.
**Animation:** Background has subtle Ken Burns. OSTs animate in synced to VO.
**Media:** 1 background image (horizontal). Character torso video generated externally.
**Note:** The character torso video is for a NON-avatar character. This may come from a different WAN generation pipeline or be pre-supplied. The template should have a video placeholder that accepts any transparent video overlay.

### 3.6 `table_image`
**Layout:** Full-screen table display. No avatar visible on screen. The table is the primary content — shows items, descriptions, values/amounts in a clean, readable format. VO plays in background narrating the table contents.
**Content elements used:** Table data extracted from VO/content (items + values). No headers/bullets in the traditional sense — the table IS the content.
**Animation:** Table rows appear one-by-one or section-by-section as the VO narrates each item. Highlight/accent the row being discussed. Total row gets special emphasis.
**Media:** None (no AI image).
**Avatar overlay:** NO — VO plays as background audio only.
**Special:** This scene type is used ONLY in financial planning lessons (Module 2, Lesson 6). The table data (products, costs, amounts in ₹) must be parsed from the VO script and content elements. Design the table to be highly readable at 1920×1080 — large fonts, clear grid, alternating row colors, ₹ symbol formatting.

### 3.7 `ai_image_slideshow`
**Layout:** Full-screen images shown sequentially (2-4 images). Each image takes over the entire frame for its segment. OST elements (header, key phrase per slide) overlay each image. NO avatar on screen.
**Content elements used:** 2-4 headers (one per slide), 0-4 key phrases (one per slide), 0-4 sub-headers, 2-4 images. Each slide maps to one VO segment.
**Animation:** Smooth crossfade or slide transition between images. Within each slide: header and key phrase animate in, timed to VO segment. Each image has subtle Ken Burns.
**Media:** 2-4 separate images (when `compositeImage: "FALSE"`) OR handled as sequential crops if composite. Images can be horizontal or square aspect ratio.
**Avatar overlay:** NO.
**Timing critical:** Each VO segment (`voScript_1`, `voScript_2`, etc.) maps to one slide. The pipeline must calculate duration per segment (from word count or audio duration) to time transitions.

### 3.8 `split_screen_image`
**Layout:** Single composite image (2-4 sub-images arranged in a grid/row) displayed prominently. Header text above or overlaid. 2-4 bullet points — each bullet maps to one sub-image. VO narrates in background.
**Content elements used:** 1 header, 2-4 bullet points, 1 composite image (containing 2-4 sub-images).
**Animation:** The composite image can be shown whole, OR each sub-image section can be highlighted/zoomed as the VO discusses it. Bullet points appear one-by-one synced to VO.
**Media:** 1 composite image (horizontal, `compositeImage: "TRUE"`, `numberOf_subImages: 2|3|4`).
**Avatar overlay:** NO.
**Design note:** Since the image is pre-composited, the template should display it at maximum size. The bullet points should be positioned in a clean panel (bottom or side) that doesn't obscure the image. Consider highlighting/dimming sub-image regions as each bullet appears.

### 3.9 `first_person_video_staticBg`
**Layout:** Static AI-generated background image (the environment). Character video overlay (avatar or non-avatar) positioned in frame, talking to camera. Minimal or no OSTs — the focus is on the character's personal story.
**Content elements used:** 0-1 headers, minimal bullets/keyphrases (if any), 1 static background image, 1 character video overlay.
**Animation:** Background is static or very subtle. Character video plays naturally (body movement, gestures). Any OSTs enter minimally.
**Media:** 1 background image. Character video generated via WAN (with natural movement/gestures) → FIBO (transparent background).
**Avatar overlay:** YES — but this is a FULL character video (not just circular crop). The character stands in the scene and talks to camera. The transparent video is composited onto the background.

### 3.10 `panning_video` / `character_based_roleplay`
**These share similar technical needs but different content purposes.**

**`panning_video` layout:** Single high-resolution AI image with a panning/Ken Burns effect applied to simulate camera movement. NO character on screen. VO plays in background. Minimal OSTs.
**Content elements used:** 0-1 headers, minimal bullets/keyphrases, 1 high-res image.
**Animation:** The signature element — a cinematic pan/zoom across the image (left-to-right, or slow zoom in, or diagonal sweep) timed to the VO duration. OSTs enter subtly.
**Media:** 1 landscape image (16:9).
**Avatar overlay:** NO.

**`character_based_roleplay` layout:** Static AI-generated background (an EMPTY environment — no people in the image). TWO character video overlays composited into the scene, positioned to look like they're facing each other in conversation. Dialogue-style VO plays.
**Content elements used:** 0-1 headers, 0-4 bullets, 1 background image, 2 character videos.
**Animation:** Character videos play with conversational gestures. OSTs may show dialogue captions or key points. Background is static.
**Media:** 1 background image (empty scene). 2 character videos (transparent, generated via WAN → FIBO).
**Avatar overlay:** YES — 2 character videos overlaid on the background.

---

## 4. THEME SYSTEM

### 4.1 Base Themes (6 generic themes)
Each theme defines CSS custom properties that ALL templates consume:

```css
:root {
  /* Primary palette */
  --theme-primary: #2563EB;
  --theme-primary-light: #60A5FA;
  --theme-primary-dark: #1E40AF;
  --theme-secondary: #F59E0B;
  --theme-accent: #10B981;

  /* Backgrounds */
  --theme-bg-solid: #0F172A;
  --theme-bg-gradient: linear-gradient(135deg, #0F172A 0%, #1E293B 100%);
  --theme-bg-card: rgba(255, 255, 255, 0.08);
  --theme-bg-card-border: rgba(255, 255, 255, 0.12);

  /* Text */
  --theme-text-primary: #F8FAFC;
  --theme-text-secondary: #CBD5E1;
  --theme-text-muted: #64748B;

  /* OST specific */
  --theme-ost-bg: rgba(15, 23, 42, 0.85);
  --theme-ost-border: rgba(255, 255, 255, 0.1);
  --theme-ost-highlight: #FBBF24;
  --theme-bullet-marker: #60A5FA;
  --theme-keyphrase-bg: rgba(251, 191, 36, 0.15);
  --theme-keyphrase-border: #FBBF24;

  /* Table specific */
  --theme-table-header-bg: #1E40AF;
  --theme-table-row-even: rgba(255, 255, 255, 0.03);
  --theme-table-row-odd: rgba(255, 255, 255, 0.06);
  --theme-table-border: rgba(255, 255, 255, 0.08);
  --theme-table-highlight: rgba(251, 191, 36, 0.12);

  /* Shadows & effects */
  --theme-shadow-card: 0 8px 32px rgba(0, 0, 0, 0.3);
  --theme-shadow-text: 0 2px 8px rgba(0, 0, 0, 0.5);

  /* Animation */
  --theme-transition-speed: 0.4s;
  --theme-ease: cubic-bezier(0.22, 1, 0.36, 1);
}
```

The 6 base themes are:
1. **Professional Blue** — Dark navy backgrounds, blue accents, white text. Corporate but warm.
2. **Warm Earth** — Deep brown/terracotta tones, cream text, amber accents. Grounded, relatable.
3. **Fresh Green** — Dark forest tones, green/teal accents, clean whites. Growth-oriented.
4. **Vibrant Orange** — Dark charcoal base, orange/amber energy, warm highlights. Motivational.
5. **Calm Neutral** — Soft grays, subtle blue-gray accents, very clean. Minimal distraction.
6. **Bold Contrast** — Near-black backgrounds, high-contrast white text, single bright accent color. High impact.

### 4.2 Domain Overrides
Each domain (from `domain_key` in storyboard) can override specific CSS variables:

```css
/* motor-vehicle-workshop.css */
:root {
  --domain-accent: #F97316;     /* Workshop orange */
  --domain-icon-set: "workshop"; /* For icon selection */
  --domain-bg-texture: url('...'); /* Optional subtle texture */
}
```

Domain overrides layer ON TOP of the selected base theme. The pipeline selects: `base theme + domain override = final theme`.

### 4.3 Theme Selection
The storyboard JSON does NOT specify a theme. The pipeline should:
- Accept theme as a CLI parameter OR auto-select based on domain
- Default mapping: each domain maps to a recommended base theme (configurable in `config/themes.json`)

---

## 5. FONT SYSTEM

### 5.1 Dynamic Font Loading
Fonts are loaded from Google Fonts (Noto Sans family) based on the `language` field in the storyboard:

```json
{
  "en": { "primary": "Noto Sans", "heading": "Noto Sans Display", "weight_range": "400;500;600;700" },
  "hi": { "primary": "Noto Sans Devanagari", "heading": "Noto Sans Devanagari", "weight_range": "400;500;600;700" },
  "ta": { "primary": "Noto Sans Tamil", "heading": "Noto Sans Tamil", "weight_range": "400;500;600;700" },
  "te": { "primary": "Noto Sans Telugu", "heading": "Noto Sans Telugu", "weight_range": "400;500;600;700" },
  "kn": { "primary": "Noto Sans Kannada", "heading": "Noto Sans Kannada", "weight_range": "400;500;600;700" },
  "ml": { "primary": "Noto Sans Malayalam", "heading": "Noto Sans Malayalam", "weight_range": "400;500;600;700" },
  "bn": { "primary": "Noto Sans Bengali", "heading": "Noto Sans Bengali", "weight_range": "400;500;600;700" },
  "mr": { "primary": "Noto Sans Devanagari", "heading": "Noto Sans Devanagari", "weight_range": "400;500;600;700" },
  "gu": { "primary": "Noto Sans Gujarati", "heading": "Noto Sans Gujarati", "weight_range": "400;500;600;700" }
}
```

Each HTML template includes a dynamic `<link>` tag:
```html
<link href="https://fonts.googleapis.com/css2?family={primary_font}:wght@{weights}&family={heading_font}:wght@{weights}&display=swap" rel="stylesheet">
```

Font family is injected via CSS variables:
```css
:root {
  --font-primary: 'Noto Sans', sans-serif;
  --font-heading: 'Noto Sans Display', sans-serif;
}
```

Templates ALWAYS use `var(--font-primary)` and `var(--font-heading)` — never hardcoded font names.

---

## 6. OST LAYOUT SYSTEM (On-Screen Text Patterns)

Instead of always rendering bullet points the same way, the pipeline uses a **fixed set of HTML layout patterns** that an LLM call selects from based on the content.

### 6.1 Available OST Layouts

1. **`bullet-list`** — Classic vertical bullet list with icons/markers. Best for: sequential items, learning objectives, feature lists.
2. **`numbered-steps`** — Large step numbers with text. Best for: processes, instructions, ordered sequences.
3. **`comparison-cards`** — Side-by-side cards. Best for: contrasts, before/after, options.
4. **`icon-text-grid`** — 2×2 or 1×3 grid with icon + text per cell. Best for: categories, features, multi-concept scenes.
5. **`highlighted-keyphrase`** — Large, prominent single phrase with decorative emphasis. Best for: definitions, key terms, memorable quotes.
6. **`timeline-bar`** — Horizontal or vertical timeline with nodes. Best for: processes over time, history, stages.
7. **`stat-callout`** — Large number/stat with supporting text. Best for: financial data, metrics, percentages.
8. **`table-layout`** — Structured rows and columns. Best for: financial tables, comparisons with values.

### 6.2 Layout Selection (LLM-Assisted)
For each scene, the pipeline calls an LLM with:

```
Given this scene's content elements:
- Headers: [...]
- Bullet points: [...]
- Key phrases: [...]
- Scene type: [...]
- VO script: [...]

Select the best OST layout from: [bullet-list, numbered-steps, comparison-cards, icon-text-grid, highlighted-keyphrase, timeline-bar, stat-callout, table-layout]

Respond with ONLY the layout name.
```

For `table_image` scenes, always use `table-layout`. For scenes with a single key phrase and no bullets, always use `highlighted-keyphrase`. The LLM decides for ambiguous cases.

### 6.3 Icons
OST layouts that use icons (icon-text-grid, bullet-list with icons) should use a bundled SVG icon set. Icons are selected by the LLM based on the bullet point content. Keep the icon set small and relevant to micro-entrepreneurship domains (tools, money, people, clock, chart, checkmark, star, location, phone, handshake, etc.).

---

## 7. AUDIO GENERATION (ElevenLabs)

### 7.1 Setup
- API key and voice IDs are pre-configured in `config/elevenlabs.json`
- Each character (Anil, Geeta Ji, Ravi, etc.) maps to a voice ID
- The `character` field in each scene determines which voice to use

### 7.2 Per-Scene Audio Generation
```javascript
// For each scene:
// 1. Concatenate all vo_scripts values in order
// 2. Call ElevenLabs TTS API
// 3. Save as output/{storyboard_id}/audio/{scene_id}.mp3
// 4. Get audio duration (used for animation timing)

// For slideshow scenes with multiple vo_scripts:
// Generate SEPARATE audio files per vo_script segment
// This enables per-slide timing in the slideshow template
// Save as: {scene_id}_seg1.mp3, {scene_id}_seg2.mp3, etc.
```

### 7.3 Timing Extraction
After generating audio, extract:
- Total duration per scene
- Per-segment duration (for slideshow scenes)
- Word-level timestamps if ElevenLabs provides them (for precise animation sync)

This timing data drives ALL animation timing in the HTML templates.

---

## 8. AVATAR VIDEO PIPELINE (WAN → FIBO → Transparent Overlay)

### 8.1 Which Scenes Need Avatar Videos
These scene types require externally generated avatar/character videos:

| Scene Type | Avatar Type | Crop Style |
|---|---|---|
| `learning_objective_scene` | Avatar character | Torso crop |
| `avatar_presenter_torso` | Avatar character | Torso crop |
| `avatar_image_circle` | Avatar character | Circular crop |
| `first_person_video_staticBg` | Avatar OR non-avatar | Full body, standing |
| `character_image_torso` | Non-avatar character | Torso crop |
| `character_based_roleplay` | 2 characters (any combo) | Torso/upper body |

Scenes that do NOT need avatar videos: `intro_scene` (uses pre-made circular avatar — could be static or a short loop), `table_image`, `ai_image_slideshow`, `split_screen_image`, `panning_video`.

### 8.2 Pipeline Steps
```
1. WAN Video Generation
   Input: Character reference image + audio file + motion prompt
   Output: Video of character speaking/gesturing with a background
   
2. FIBO Background Removal
   Input: WAN-generated video
   Output: Video with transparent background (alpha channel)
   API: FIBO endpoint (details TBD — placeholder in code)
   
3. HTML Overlay
   The transparent video is placed in the HTML template via:
   <video src="transparent_avatar.webm" autoplay muted></video>
   Positioned according to scene type requirements (circular crop via CSS border-radius,
   torso crop via object-fit/object-position, full body via absolute positioning).
```

### 8.3 Placeholder Strategy
Since WAN and FIBO APIs are external and details may change, the code should:
- Define a clear interface: `generateAvatarVideo(characterRef, audioPath, motionType) → videoPath`
- Use a stub/mock that returns a placeholder transparent video during development
- Make the pipeline work END-TO-END with placeholder assets so HTML templates and recording can be tested independently

---

## 9. ANIMATION & VO SYNC SYSTEM

This is critical for making the videos feel professional rather than like static slideshows.

### 9.1 Timing Data Structure
```javascript
const sceneTimings = {
  scene_id: "M2_L3_ML3_SC2",
  total_duration_ms: 14000,
  segments: [
    { text: "By the end of this video...", start_ms: 0, end_ms: 14000 }
  ],
  // For slideshow scenes, segments map to slides:
  // segments: [
  //   { text: "VO segment 1", start_ms: 0, end_ms: 5000, slide_index: 0 },
  //   { text: "VO segment 2", start_ms: 5000, end_ms: 10000, slide_index: 1 },
  // ]
  ost_timings: [
    { element: "header_1", appear_ms: 500, animation: "fadeSlideUp" },
    { element: "bullet_1", appear_ms: 2000, animation: "fadeSlideRight" },
    { element: "bullet_2", appear_ms: 6000, animation: "fadeSlideRight" },
  ]
};
```

### 9.2 How OST Timings Are Calculated
The pipeline uses a heuristic + optional LLM assist:

1. **Divide VO into segments** — if multiple `vo_scripts`, use them directly. If single VO, split by sentence.
2. **Map each OST element to a VO segment** — the LLM (or simple keyword matching) determines which sentence in the VO corresponds to which bullet/header/keyphrase.
3. **Calculate appear time** — based on the start time of the corresponding VO segment + a small offset (e.g., 300ms after the sentence begins).
4. **Header always appears first** — within the first 500ms.
5. **Key phrases appear with emphasis** — slightly delayed with a highlight animation.

### 9.3 Animation Library
Each HTML template includes a shared CSS animation library:

```css
/* Base animations — all use var(--theme-transition-speed) and var(--theme-ease) */
.anim-fadeIn { opacity: 0; animation: fadeIn var(--theme-transition-speed) var(--theme-ease) forwards; }
.anim-fadeSlideUp { opacity: 0; transform: translateY(30px); animation: fadeSlideUp 0.6s var(--theme-ease) forwards; }
.anim-fadeSlideRight { opacity: 0; transform: translateX(-30px); animation: fadeSlideRight 0.5s var(--theme-ease) forwards; }
.anim-scaleIn { opacity: 0; transform: scale(0.8); animation: scaleIn 0.5s var(--theme-ease) forwards; }
.anim-highlight { animation: highlightPulse 0.8s var(--theme-ease); }
.anim-kenBurns { animation: kenBurns var(--scene-duration) linear forwards; }

/* Delay classes generated dynamically */
.delay-500 { animation-delay: 500ms; }
.delay-1000 { animation-delay: 1000ms; }
/* ... etc, generated from timing data */
```

Animation delays are injected as inline styles based on the calculated `ost_timings`.

### 9.4 Slideshow Transitions
For `ai_image_slideshow` scenes:
- Each slide has its own duration (from per-segment audio)
- Transitions between slides: crossfade (default), slide-left, or zoom-through
- Within each slide, OSTs animate in relative to that slide's start time
- The HTML template uses JavaScript to orchestrate slide timing:

```javascript
// Injected timing data
const slideTimings = [
  { start_ms: 0, end_ms: 5000, image: "url1", header: "...", keyphrase: "..." },
  { start_ms: 5000, end_ms: 10000, image: "url2", header: "...", keyphrase: "..." },
  { start_ms: 10000, end_ms: 14000, image: "url3", header: "...", keyphrase: "..." },
];
// JS cycles through slides at the right times
```

---

## 10. HTML TEMPLATE DESIGN PRINCIPLES

### 10.1 Visual Design Standards
- **Resolution:** All templates render at exactly 1920×1080 pixels
- **Modern & clean:** Use generous whitespace, subtle gradients, refined shadows. Not cluttered.
- **Glassmorphism for OST cards:** Semi-transparent backgrounds with backdrop-blur for OST panels overlaid on images.
- **Consistent typography scale:** 
  - Headers: 48-64px, font-weight 700
  - Sub-headers: 32-40px, font-weight 600
  - Bullet points: 28-36px, font-weight 400-500
  - Key phrases: 36-44px, font-weight 600, with accent color
- **Image treatment:** All background images get a subtle dark overlay (linear-gradient) to ensure text readability. Ken Burns effect for engagement.
- **Spacing rhythm:** Use a consistent spacing scale (8px base unit: 8, 16, 24, 32, 48, 64, 80, 96).
- **No generic AI look:** Follow the frontend-design skill principles — intentional aesthetic choices, bold but cohesive, no cookie-cutter layouts.

### 10.2 Template Structure
Every template follows this HTML shell:

```html
<!DOCTYPE html>
<html lang="{language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1920, height=1080">
  <link href="https://fonts.googleapis.com/css2?family={fonts}&display=swap" rel="stylesheet">
  <style>
    /* Theme CSS variables injected here */
    /* Font CSS variables injected here */
    /* Animation library injected here */
    /* Scene-specific styles */
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      width: 1920px; 
      height: 1080px; 
      overflow: hidden; 
      font-family: var(--font-primary);
      background: var(--theme-bg-gradient);
      color: var(--theme-text-primary);
    }
  </style>
</head>
<body>
  <!-- Scene content rendered here -->
  
  <!-- Audio element (for Puppeteer recording sync) -->
  <audio id="scene-audio" src="{audio_path}"></audio>
  
  <script>
    // Animation timing controller
    // Starts animations when audio begins playing
    // Puppeteer triggers: audio.play() → animations fire → recording captures
    const timings = {/* injected timing data */};
    
    document.getElementById('scene-audio').addEventListener('play', () => {
      // Start all timed animations
      timings.ost_timings.forEach(t => {
        setTimeout(() => {
          document.getElementById(t.element).classList.add(t.animation);
        }, t.appear_ms);
      });
    });
  </script>
</body>
</html>
```

---

## 11. RECORDING & STITCHING PIPELINE

### 11.1 Puppeteer Scene Recording
For each scene:
```javascript
// 1. Launch Puppeteer with viewport 1920x1080
// 2. Load the scene HTML file
// 3. Wait for all assets (images, fonts, videos) to load
// 4. Start screen recording
// 5. Trigger audio playback (which triggers animations)
// 6. Wait for audio to complete + 500ms buffer
// 7. Stop recording
// 8. Save as output/{storyboard_id}/clips/{scene_id}.webm
```

Use `puppeteer-screen-recorder` or Puppeteer's built-in `Page.screencast()` (Chrome DevTools Protocol) for recording. Ensure:
- 30fps minimum (prefer 30fps for file size, 60fps if animations are fast)
- Audio from the HTML `<audio>` element is captured in the recording
- If Puppeteer can't capture audio natively, record video-only and merge audio in the FFmpeg step

### 11.2 FFmpeg Stitching
```bash
# 1. Convert each scene clip to a consistent format
ffmpeg -i clip_sc1.webm -c:v libx264 -preset medium -crf 23 -r 30 -s 1920x1080 clip_sc1.mp4

# 2. Create concat list
echo "file 'clip_sc1.mp4'" > concat_list.txt
echo "file 'clip_sc2.mp4'" >> concat_list.txt
# ... for all scenes in order

# 3. Concatenate
ffmpeg -f concat -safe 0 -i concat_list.txt -c copy final_no_audio.mp4

# 4. If audio was recorded separately, merge:
# First concatenate all audio files
ffmpeg -f concat -safe 0 -i audio_list.txt -c copy full_audio.mp3

# Then merge video + audio
ffmpeg -i final_no_audio.mp4 -i full_audio.mp3 -c:v copy -c:a aac -shortest final.mp4
```

### 11.3 Scene Transitions (Between Scenes)
Add brief transitions between scenes during stitching:
- Default: 300ms crossfade dissolve between scenes
- Configurable per scene type if needed
- Applied via FFmpeg's `xfade` filter:
```bash
ffmpeg -i clip1.mp4 -i clip2.mp4 -filter_complex "xfade=transition=fade:duration=0.3:offset={clip1_duration - 0.3}" output.mp4
```

---

## 12. PIPELINE ORCHESTRATION

### 12.1 CLI Interface
```bash
# Process a single storyboard
node src/pipeline/orchestrator.js --input storyboard.json --theme professional-blue --output ./output/

# Options:
# --input        Path to storyboard JSON (required)
# --theme        Base theme name (default: auto-select from domain)
# --output       Output directory (default: ./output/)
# --skip-audio   Skip audio generation (use existing audio files)
# --skip-avatar  Skip avatar video generation (use placeholders)
# --skip-record  Skip Puppeteer recording (generate HTML only)
# --skip-stitch  Skip FFmpeg stitching (generate clips only)
# --preview      Open each HTML in browser for visual preview
# --font-override  Override font family (e.g., "Noto Sans Tamil")
# --lang-override  Override language code
```

### 12.2 Processing Order
```
1. PARSE storyboard JSON
   ↓
2. GENERATE AUDIO for all scenes (parallel where possible)
   ├── Single audio per scene (most types)
   └── Per-segment audio for slideshow scenes
   ↓
3. EXTRACT TIMING DATA from generated audio
   ↓
4. SELECT OST LAYOUTS (LLM call for each scene)
   ↓
5. CALCULATE ANIMATION TIMINGS (VO sync mapping)
   ↓
6. GENERATE AVATAR VIDEOS for applicable scenes (parallel)
   ├── WAN generation
   └── FIBO background removal
   ↓
7. RENDER HTML for each scene (inject: theme, fonts, timings, media URLs, avatar videos, OST layout)
   ↓
8. RECORD each HTML scene via Puppeteer (sequential)
   ↓
9. STITCH all clips via FFmpeg
   ↓
10. OUTPUT: final.mp4 + all intermediate artifacts
```

### 12.3 Error Handling & Resume
- Each step saves its output to disk
- If the pipeline fails at step 6, re-running skips steps 1-5 (detects existing output)
- Each scene is independent — a failure in one scene doesn't block others
- Log all steps with timestamps for debugging

---

## 13. DEVELOPMENT PLAN — BUILD ORDER

Build in this order to get value incrementally:

### Phase 1: Foundation (Do First)
1. Storyboard parser (read JSON, extract all scene data)
2. Theme system (CSS variables, base themes, domain overrides)
3. Font loader (Google Fonts integration, language mapping)
4. Base HTML shell template

### Phase 2: Templates (Core Work)
5. Build HTML templates for ALL 10 scene types (start with `learning_objective_scene` and `avatar_presenter_torso` — simplest, no images)
6. OST layout system (all 8 patterns)
7. OST layout picker (LLM integration)
8. Animation library (CSS + JS timing controller)

### Phase 3: Audio Pipeline
9. ElevenLabs integration (TTS generation)
10. Audio timing extraction
11. VO-to-OST sync calculator

### Phase 4: Recording & Stitching
12. Puppeteer recording setup
13. FFmpeg stitching
14. Scene transitions

### Phase 5: Avatar Pipeline
15. WAN video generation integration (stub first, real API later)
16. FIBO background removal integration
17. Avatar overlay in templates

### Phase 6: Polish & Scale
18. End-to-end testing with sample storyboard
19. Multi-language testing
20. Performance optimization (parallel processing)
21. Error handling & resume logic

---

## 14. IMPORTANT NOTES & CONSTRAINTS

1. **All templates must be self-contained HTML files.** Each scene's HTML has everything inline — no external CSS/JS dependencies except Google Fonts CDN. This ensures Puppeteer renders them reliably.

2. **Image URLs in the storyboard are Azure Blob Storage URLs with SAS tokens.** They are long-lived (10-year expiry) and can be used directly in `<img src="...">` tags. No authentication needed.

3. **The `selected_template_name` and `selected_family_name` fields in the storyboard** tell you what the original system used. You do NOT need to replicate these exact templates. Our new templates are REPLACEMENTS with better design. Use `scene_typology_name` as the primary key.

4. **`characterCrop` and `characterPosition`** fields will be mapped to specific avatar placement configs later. For now, use sensible defaults (circular crop for avatar_image_circle, torso crop for presenter scenes, etc.).

5. **Voice scripts have dynamic keys** — don't hardcode key names. Pattern: `{template_name}_voScript_{N}`. Parse all keys matching `*_voScript_*` pattern.

6. **Same for all content elements** — headers, bullets, keyphrases all have dynamic keys prefixed with the template name. Parse by key pattern, not exact name.

7. **The `panning_video` and `character_based_roleplay` may share a scene type key in some storyboards.** Handle both layouts — detect based on content (roleplay has dialogue-style VO with multiple characters, panning has single narrator).

8. **Indian Rupee symbol (₹)** appears frequently in financial content. Ensure fonts support it. The Noto Sans family handles it well.

9. **Videos will eventually be generated in 10+ Indian languages.** The entire template and font system must be language-agnostic — no hardcoded English text in templates.

10. **Quality bar:** These videos replace what was previously done with HeyGen (AI avatar platform). The HTML templates need to look AT LEAST as polished as professional educational video content. Think: Coursera/Khan Academy production quality for the slide design.

---

## 15. SAMPLE STORYBOARD

A complete sample storyboard JSON is included in the project at `sample/M2_L3_ML3.json`. Use it for all development and testing. It contains 9 scenes covering these scene types: `intro_scene`, `learning_objective_scene`, `avatar_image_circle`, `ai_image_slideshow`, `split_screen_image`, `avatar_presenter_torso`.

---

Now, start by setting up the project structure and building Phase 1 (Foundation). Then proceed through the phases in order. For each template you build, render a visual preview and iterate on the design until it looks production-quality. Ask me if you need clarification on any scene type, API details, or design direction.