/**
 * LLM-based HTML renderer — uses Gemini to generate scene HTML on the fly.
 *
 * Each scene gets an independent Gemini call with only its own context.
 * The LLM generates HTML + CSS + JS, injected into base-layout.html.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getThemeCSS } from '../utils/theme-loader.js';
import { generateFontLinkTag, generateFontCSSVars } from '../utils/font-loader.js';
import { generateContent } from '../clients/gemini-client.js';
import { validateSceneHTML, buildCorrectionPrompt, buildSceneContext, closeValidator } from './html-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, '../templates');

// ─── Scene-type specific context ────────────────────────────────────────────

const SCENE_CONTEXT = {
  intro_scene: `## SCENE CONTEXT
This is the **opening title card** of an educational video. It sets the first impression and visual tone for everything that follows.
You have a background image and a title header. No other text elements, no avatar.
Make this cinematic and memorable — the viewer should immediately feel they're watching something premium.`,

  learning_objective_scene: `## SCENE CONTEXT
This scene presents the **learning objectives** — what the viewer will take away from this video.
You have a header and bullet points. No background image — use the theme gradient.
A large avatar video of the narrator will be overlaid on the left half of the screen later (bottom-anchored, ~50% width, ~85% height). Keep all your content on the right half so nothing gets covered.
This is a structured overview scene — left-aligned text reads better here.`,

  avatar_image_circle: `## SCENE CONTEXT
The narrator is explaining a concept over a **background image**. You have the image, a header, and optionally keyphrases and/or bullets.
A circular avatar video (~420px) of the narrator will be overlaid in one corner of the screen later. You get to decide which corner works best for the composition — bottom-left, bottom-right, top-left, or top-right. Place your text content on the opposite half of the screen so nothing overlaps the avatar. For example, if the avatar is bottom-left, put text on the right half; if bottom-right, put text on the left half.
The image sets the mood — let it breathe while making the text content clear and engaging.`,

  avatar_presenter_torso: `## SCENE CONTEXT
This is a **presenter-driven scene** — the narrator is summarizing or concluding. You have a header and bullet points, no background image (use theme gradient).
An avatar video of the narrator will be overlaid later. You must choose ONE of these layout options and set avatarPosition accordingly:

**Option A — "presenter-left"**: Avatar on the left (~30% width, 85% height, bottom-anchored). Place text on the right 55% of the screen. Good for 3-4+ bullet points that need vertical space.

**Option B — "presenter-center"**: Avatar centered at bottom (~30% width, 70% height). Place text in the upper 40-50% of the screen, full width available. Think TV news anchor. Good for 1-3 short bullet points or a header with keyphrases.

**Option C — "presenter-right"**: Avatar on the right (~30% width, 85% height, bottom-anchored). Place text on the left 55% of the screen. Good for variety when previous scenes had left-anchored layouts.

Choose the option that best fits the amount of content you have and provides visual variety from neighboring scenes. Set avatarPosition to one of: "presenter-left", "presenter-center", "presenter-right".`,

  character_image_torso: `## SCENE CONTEXT
A **character** (not the narrator) is speaking in a pre-rendered video. The video plays as the full-screen background — the character is already visible in it.
You have a header, bullets, and optionally a keyphrase. Audio comes from the media URL.
Do NOT add any avatar element — the character is in the video. Place text creatively so it complements the character without covering them.`,

  character_based_roleplay: `## SCENE CONTEXT
This is a **roleplay dialogue** between characters. The video plays as a full-screen background with the characters already in it.
Audio comes from the media URL. There may or may not be text elements to display.
Do NOT add any avatar element. If there is text content, keep it subtle so it doesn't obstruct the dialogue scene.`,

  ai_image_slideshow: `## SCENE CONTEXT
This is a **single slide** from a slideshow sequence. One full-screen image with a header and optionally a keyphrase. No avatar.
The image is the hero — let it fill the screen.
**Layout constraint:** Place the text in a compact glass-card in ONE CORNER of the screen (bottom-left, bottom-right, top-left, or top-right). The card must be LESS THAN HALF the screen width (max ~800px). Do NOT create a full-width horizontal banner across the top or bottom. The card should be a compact rectangle or square, not a strip.
This is a static frame — do NOT write any slideshow transition JS.`,

  // split_screen_image is built dynamically in buildSplitScreenContext() below
  split_screen_image: null,

  panning_video: `## SCENE CONTEXT
A **cinematic/atmospheric video** plays as the visual backdrop while the narrator speaks.
You have the video URL and optionally header, bullets, and keyphrase. Audio is generated separately.
Let the video be the star — if there's text, keep it compact and unobtrusive.`,

  first_person_video_staticBg: `## SCENE CONTEXT
The **narrator is speaking directly to camera** in a pre-rendered video that plays as the full-screen background.
Audio comes from the media URL. You may have a header, bullets, and keyphrase.
The speaker is already in the video — do NOT add an avatar. Keep any text minimal so the focus stays on the speaker.`,

  table_image: `## SCENE CONTEXT
This scene shows a **data table or chart** as a pre-rendered image. The image IS the content.
Display it centered and fully visible (object-fit: contain) so every cell is readable. Give it a clean frame — no text overlays needed.`,

  // infographics_scene is built dynamically in buildInfographicsContext() below
  infographics_scene: null,
};

// ─── Split screen context builder ───────────────────────────────────────────

function buildSplitScreenContext(numPanels, subimageAspect = '') {
  const n = numPanels || 2;
  const isGrid = n === 4 && subimageAspect === 'square';

  // Fixed image container: 1680px wide (1920 - 120px padding each side), centered
  const containerWidth = 1680;
  const gap = 12;

  if (isGrid) {
    // 2x2 grid layout
    const cols = 2;
    const colWidth = Math.floor((containerWidth - gap) / cols);

    return `## SCENE CONTEXT
This scene features a **composite image** — a single image file containing 4 sub-images arranged in a **2x2 grid** (2 columns, 2 rows).
You have the composite image, a header, and 4 bullet points (one label per panel).

**Layout spec for this 2x2 grid split screen:**
- **HEADER** at the top, centered. Use a compact glassmorphism card or strip with border-left: 4px solid var(--theme-accent).
- **IMAGE CONTAINER** below the header: a rounded container (border-radius: 16px; overflow: hidden) that is ${containerWidth}px wide, centered horizontally (left: 50%; transform: translateX(-50%)). The image inside: width: 100%, height: auto, object-fit: cover, max-height: 720px.
- **BULLET LABELS** below the image in a 2x2 grid matching the image layout. Use a CSS grid or two flex rows, container ${containerWidth}px wide, centered. Each label box: width ~${colWidth}px, text-align: center, no bullet markers or dots, font-size: 28px, border-left: 3px solid var(--theme-accent), padding-left: 12px. Row 1 labels = top-left and top-right panels, Row 2 labels = bottom-left and bottom-right panels.
- The image must be an <img> element, NOT a background.
- The image must remain completely static — no animation. Only text elements animate.`;
  }

  // Horizontal row layout (2, 3, or 4 vertical panels side by side)
  const totalGaps = (n - 1) * gap;
  const panelWidth = Math.floor((containerWidth - totalGaps) / n);

  return `## SCENE CONTEXT
This scene features a **composite image** — a single image file containing ${n} sub-images arranged **side by side in a horizontal row**.
You have the composite image, a header, and ${n} bullet points (one label per panel).

**Layout spec for this ${n}-panel split screen:**
- **HEADER** at the top, centered. Use a compact glassmorphism card or strip with border-left: 4px solid var(--theme-accent).
- **IMAGE CONTAINER** below the header: a rounded container (border-radius: 16px; overflow: hidden) that is ${containerWidth}px wide, centered horizontally (left: 50%; transform: translateX(-50%)). The image inside: width: 100%, height: auto, object-fit: cover, max-height: 720px.
- **BULLET LABELS** directly below the image, in a single flex row that is exactly ${containerWidth}px wide, centered the same way. Use ${n} equal-width boxes (each ~${panelWidth}px) with ${gap}px gap between them. Each label box: text-align: center, no bullet markers or dots, font-size: 28px, border-left: 3px solid var(--theme-accent), padding-left: 12px. This ensures each label sits perfectly centered under its corresponding image panel.
- The image must be an <img> element, NOT a background.
- The image must remain completely static — no animation. Only text elements animate.`;
}

// ─── Infographics context builder ────────────────────────────────────────────

const INFOGRAPHIC_STYLES = [
  { id: 'flow', name: 'Flow/Process', bullets: '2-5', desc: 'Arrange items as connected steps in a horizontal or vertical flow. Use numbered circles connected by lines/arrows (CSS borders or pseudo-elements). Great for sequential content (step 1 → step 2 → step 3).' },
  { id: 'hub-spoke', name: 'Hub & Spoke', bullets: '3-5', desc: 'Place the header or keyphrase in a central circle/hexagon, with items radiating outward as connected nodes. Use CSS borders/pseudo-elements for connecting lines. Great for showing how parts relate to a central concept.' },
  { id: 'card-grid', name: 'Card Grid', bullets: '2-4', desc: 'Arrange items as individual styled cards in a 2x2 or 1x2/1x3 grid. Each card gets a large number (36-48px bold text inside a 64px circle with var(--theme-accent) background), the item text, and a glass-card background. Great for equal-weight items.' },
  { id: 'timeline', name: 'Vertical Timeline', bullets: '3-5', desc: 'Items arranged along a vertical line with alternating left/right placement. Each node has a circle marker on the timeline and a glass-card with the content. Great for chronological or phased content.' },
  { id: 'comparison', name: 'Stacked Bars / Comparison', bullets: '2-3', desc: 'Horizontal bars or layered strips, each representing an item, with varying widths or visual weights. Use contrasting accent colors from the theme. Great for showing relative importance, comparison, or two opposing sides.' },
];

function buildInfographicsContext(numBullets) {
  // Filter styles that work for this bullet count
  const available = INFOGRAPHIC_STYLES.filter(s => {
    const [min, max] = s.bullets.split('-').map(Number);
    return numBullets >= min && numBullets <= max;
  });

  const styleList = available.map((s, i) => `**Style ${i + 1} — ${s.name}:** ${s.desc}`).join('\n\n');

  return `## SCENE CONTEXT
This is an **infographic scene** — a visually rich, data-driven layout that presents information in a structured, engaging way. No background image, no avatar — use the theme gradient as the backdrop.
You have a header, sub-header, ${numBullets} bullet points, and a keyphrase. Your job is to turn these into a compelling infographic composition.

**Choose the infographic style that best fits the content and voiceover narrative:**

${styleList}

**IMPORTANT — Bullet structure override for infographics:**
Do NOT use the standard \`bullet-item\` / \`bullet-marker\` / \`text-bullet\` classes for this scene. Infographic items are NOT bulleted lists — they are visual elements.
Instead, use custom divs with unique classes for each infographic item. Each item still needs \`class="anim-hidden"\` and \`id="bullet_N"\` for the animation system, but the inner structure is entirely yours to design. Example:
\`<div class="infographic-card anim-hidden" id="bullet_1"><div class="card-number">1</div><div class="card-label">Item text</div></div>\`
You have full freedom to style these custom classes — just don't use bullet-item, bullet-marker, or text-bullet.

**Design rules for infographics:**
- Use CSS-only decorative elements (borders, gradients, shapes via border-radius, clip-path, pseudo-elements). No images, no SVG, no emoji, no icon fonts.
- Connecting lines, arrows, and decorative structural elements can be standalone divs or pseudo-elements — your choice for best visual result. But they MUST NOT be visible at t=0. Wrap any standalone decorative group in a div with \`class="ost-container"\` (no id needed) so it reveals alongside nearby content. Or place them inside an animated \`bullet_N\` container.
- Number markers should use large bold text (36-48px, font-weight:700) inside styled circles (e.g., \`width:64px; height:64px; border-radius:50%; background:var(--theme-accent); color:#fff; display:flex; align-items:center; justify-content:center;\`).
- Item text should be clean and prominent (26-30px, font-weight:500), not crammed with a chevron marker.
- The keyphrase should be prominently placed — as a tagline at the bottom, a central element, or an accent strip.
- The sub-header goes below the header as supporting context.
- Keep the layout balanced and centered on the 1920x1080 canvas.
- **Nothing should be visible at t=0.** Every element on screen (text, cards, connectors, decorative shapes) must either be inside an \`ost-container\` or have \`anim-hidden\`. The screen starts empty and elements animate in.
- Do NOT put \`ost-container\` on elements that already have \`anim-hidden\` and an \`id="bullet_N"\` — that causes double animation. Use \`ost-container\` only on wrapper containers that hold multiple animated children (like a header card holding header + subheader).
- This should look like a professionally designed infographic, not a bulleted list with decorations.`;
}

// ─── Prompt builder ─────────────────────────────────────────────────────────

function buildPrompt(scene, _storyboard, themeCSS, neighbors = {}) {
  const media = scene.content.media || {};
  const images = (media.images || []).map(i => i.url);
  const imagePrompts = (media.images || []).filter(i => i.prompt).map(i => i.prompt);
  const videos = (media.videos || []).map(v => v.url);
  const audios = (media.audios || []).map(a => a.url);

  let sceneContext;
  if (scene.sceneType === 'split_screen_image') {
    sceneContext = buildSplitScreenContext(media.numberOfSubImages, media.subimageAspectRatio || '');
  } else if (scene.sceneType === 'infographics_scene') {
    const numBullets = scene.content.bulletPoints?.length || 3;
    sceneContext = buildInfographicsContext(numBullets);
  } else {
    sceneContext = SCENE_CONTEXT[scene.sceneType] || '## SCENE CONTEXT\nDesign an appropriate layout for the given content and media.';
  }

  // Neighboring scenes for flow context + variety hint
  let flowContext = '';
  if (neighbors.prev) {
    flowContext += `\nPrevious scene was: "${neighbors.prev.sceneType}" — ${neighbors.prev.content.headers[0]?.text || 'no header'}`;
  }
  if (neighbors.next) {
    flowContext += `\nNext scene will be: "${neighbors.next.sceneType}" — ${neighbors.next.content.headers[0]?.text || 'no header'}`;
  }
  if (neighbors.prev) {
    flowContext += `\n⚠️ VARIETY RULE: Your layout must look visually DIFFERENT from the previous scene. If the previous scene had a right-aligned card, try a bottom strip or different card position. If it used a left accent bar, use underline accent or no accent. Vary card placement, card shape, and accent style.`;
  }

  return `You are a world-class visual designer creating a single frame for a premium educational video series. Your output will be screen-recorded at 1920×1080 into a final MP4.

${sceneContext}
${flowContext ? `\n## NARRATIVE FLOW${flowContext}\n` : ''}
## YOUR ASSETS

**Text content to display:**
${scene.content.headers.length ? `- Headers: ${JSON.stringify(scene.content.headers.map(h => h.text))}` : '- Headers: none'}
${scene.content.subHeaders.length ? `- Sub-headers: ${JSON.stringify(scene.content.subHeaders.map(s => s.text))}` : '- Sub-headers: none'}
${scene.content.bulletPoints.length ? `- Bullets: ${JSON.stringify(scene.content.bulletPoints.map(b => b.text))}` : '- Bullets: none'}
${scene.content.keyPhrases.length ? `- Key phrases: ${JSON.stringify(scene.content.keyPhrases.map(k => k.text))}` : '- Key phrases: none'}

**Media assets:**
${images.length ? `- Images: ${JSON.stringify(images)}` : '- Images: none'}
${videos.length ? `- Videos: ${JSON.stringify(videos)}` : '- Videos: none'}
${audios.length ? `- Audio: ${JSON.stringify(audios)}` : '- Audio: none'}
- Image aspect ratio: ${media.imageAspectRatio || 'none'}
${media.compositeImage ? `- COMPOSITE IMAGE: This single image contains ${media.numberOfSubImages} sub-images stitched together` : ''}
${imagePrompts.length ? `\n**Image description (tells you how the image is composed):**\n${imagePrompts[0]}` : ''}

**Narration script (for context only — do NOT display this on screen):**
${scene.voScripts.map(v => v.text).join('\n') || 'No VO script.'}

## DESIGN SYSTEM

**Color palette (use ONLY these CSS variables — never hardcode colors):**
${themeCSS}

**Typography:**
- var(--font-primary) — body/bullet text
- var(--font-heading) — headings, keyphrases, titles

**Canvas:** 1920×1080px fixed. body is already set with overflow:hidden.

## DESIGN GUIDELINES

### Quality & Creativity
- This is premium educational content — think Kurzgesagt, Brilliant.org, TED-Ed, Masterclass. NOT PowerPoint or Canva.
- Be highly creative with layouts, card shapes, and visual treatments. Each scene should feel fresh and unique.
- If someone watches 8 scenes in a row, they should feel visually connected (same brand) but never repetitive.

### Brand System (follow these for visual consistency)

**Glassmorphism cards** for all text containers:
\`background: var(--theme-ost-bg); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid var(--theme-ost-border); border-radius: 12-24px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);\`

**Typography scale:**
- Headers: 44–52px, font-weight: 700, var(--font-heading)
- Sub-headers: 28–32px, font-weight: 600, var(--font-heading)
- Bullets: 24–28px, font-weight: 400, var(--font-primary)
- Key phrases: 32–36px, font-weight: 600, var(--font-heading) — make them visually distinct from headers (accent color, underline, etc.)
- Never exceed 56px or go below 22px for any text.

**Colors:** Use ONLY CSS variables from the theme — never hardcode colors.

**Safe zone:** Keep all content at least 60px from every canvas edge. If positioning with \`left: X%\`, also set \`right: 60px\` or max-width to prevent clipping.

**Text on images/video:** Always add a dark gradient overlay or use a glass card for contrast. Add text-shadow for crispness.

**Background media:** position:absolute, top:0, left:0, width/height 100%, object-fit:cover. Videos: autoplay, muted, loop, playsinline.

**Layout:** Use position:absolute for layout blocks. Z-index order: background (1) → overlay (2) → content (3).

### No image overlays
Do NOT add any gradient overlay, darkening div, or semi-transparent layer on top of background images. Images must show without any overlay. Use glass-cards for text readability instead.

### Container visibility
EVERY container, card, box, or wrapper div that holds or surrounds OST text elements (headers, bullets, keyphrases, subheaders) MUST have the CSS class \`ost-container\`. This includes glass-cards, label containers, header strips, bullet wrappers — any div with a visible background, border, or backdrop that wraps text. The container stays invisible until the first OST element inside it animates in. If you have separate containers (e.g. header card at top, bullet card at bottom), EACH one needs \`ost-container\`. Example: \`<div class="glass-card ost-container">\`

### Bullet structure
Each bullet must use this exact structure: \`<div class="bullet-item anim-hidden" id="bullet_N"><span class="bullet-marker"></span><span class="text-bullet">text here</span></div>\`
The bullet-marker span must be EMPTY — the chevron marker is added via CSS ::after. Do NOT put any text or symbol inside the bullet-marker span.
**CRITICAL:** Do NOT restyle \`.bullet-marker\` or \`.bullet-item\` in your CSS. These classes are already fully styled in the base CSS with the correct chevron, padding, background, and border-radius. If you redefine them, you will break the design system.

### Keyphrase styling
Keyphrases must use the \`text-keyphrase\` class and one accent class: \`keyphrase-underline\`, \`keyphrase-accent-color\`, or \`keyphrase-left-bar\`. Do NOT create background boxes, padding boxes, or custom containers around keyphrases. The keyphrase should be clean inline text with only the accent style applied.

### Do NOT override base component styles
The following CSS classes are pre-styled in the base layout and must NOT be redefined in your scene CSS: \`.bullet-item\`, \`.bullet-marker\`, \`.text-bullet\`, \`.text-header\`, \`.text-subheader\`, \`.text-keyphrase\`, \`.glass-card\`, \`.avatar-circle\`, \`.avatar-torso\`. You may create new custom classes but never redefine these.

### Consistent container alignment
When a scene has multiple content groups (e.g., a header card and a bullet list below it), their left and right edges MUST be aligned flush. Use the same \`left\`, \`width\`, and horizontal \`margin\`/\`padding\` values so all containers form a single clean column. Misaligned containers look broken — treat this as a hard requirement.

### Flexible text containers (multi-language support)
All text containers (cards, boxes, wrappers) must use \`min-height\` instead of \`height\` so they grow if text is longer in other languages. Never set a fixed \`height\` on any element that contains text. Use \`padding\` for spacing, not fixed dimensions.

### Things to Avoid
- Never place text directly on a busy image without a glass card
- Never add gradient overlays or darkening divs on images
- Never set a fixed \`height\` on text containers — use \`min-height\` or \`padding\` instead
- Never let content clip outside the canvas or its container
- Never hardcode colors — always use theme CSS variables
- Never invent text, labels, or categories not in the provided content
- Never apply continuous/looping animation (zoom, pulse, float) to images — images must be static
- Never add ambient glow divs, blurred circles, radial gradients, or soft light effects on the background. These cause severe color banding artifacts in video encoding. Keep backgrounds flat and clean — the theme solid color is the background.
- Never make a keyphrase larger than the header
- Never create random or extra bullet points not in the provided content

## OUTPUT FORMAT
Return ONLY a raw JSON object. No markdown, no backticks, no commentary:
{"html": "...", "css": "...", "script": "...", "avatarPosition": "bottom-left"}

- html: inner body content (goes inside <body>). Must be clean semantic HTML.
- css: scene-specific styles (goes inside an existing <style> block). Follow the spacing and glassmorphism specs above exactly.
- script: JS if needed (slideshow transitions, etc.), otherwise empty string ""
- avatarPosition: where to place the avatar overlay — one of "bottom-left", "bottom-right", "top-left", "top-right". Only relevant for scenes with an avatar; use "bottom-left" as default. Choose based on your layout so text and avatar don't overlap.

**Animation system (GSAP-powered):** Every text element that should animate in MUST have class="anim-hidden" and a unique sequential id. GSAP handles all text animations automatically via a timing system — do NOT write any animation JS yourself (no setTimeout, no requestAnimationFrame, no DOMContentLoaded, no IntersectionObserver, no CSS animation/transition on text elements). GSAP controls all text reveals.
- Headers: id="header_1", id="header_2" ...
- Bullets: id="bullet_1", id="bullet_2" ...
- Key phrases: id="keyphrase_1", id="keyphrase_2" ...
- Sub-headers: id="subheader_1" ...

You may still use CSS animation classes for non-text elements like background images (anim-kenBurns) but NEVER on text elements.

**Avatar overlay:** Do NOT include any avatar or narrator video element in your HTML. The avatar is added separately as an overlay after your HTML. Just leave visual space for it as described in the scene context.

**Content integrity:** Only display text from the provided content elements. Never invent labels, categories, numbering, or decorative text that isn't in the assets above.`;
}

// ─── Response parser ────────────────────────────────────────────────────────

function parseLLMResponse(responseText) {
  try {
    return JSON.parse(responseText);
  } catch {
    const jsonMatch = responseText.match(/\`\`\`(?:json)?\s*\n?([\s\S]*?)\`\`\`/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[1].trim()); } catch { /* fall through */ }
    }
    const start = responseText.indexOf('{');
    const end = responseText.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(responseText.slice(start, end + 1)); } catch { /* fall through */ }
    }
    throw new Error(`Failed to parse LLM response as JSON:\n${responseText.slice(0, 500)}`);
  }
}

// ─── Avatar overlay builder ─────────────────────────────────────────────────

function buildAvatarOverlay(avatarVideoUrl, sceneType, avatarPosition = 'bottom-left') {
  if (!avatarVideoUrl) return '';

  const cropStyles = {
    learning_objective_scene: 'torso',
    avatar_presenter_torso: 'torso',
    avatar_image_circle: 'circle',
  };
  const crop = cropStyles[sceneType];
  if (!crop) return '';

  if (crop === 'circle') {
    const posStyles = {
      'bottom-left':  'bottom:60px; left:60px;',
      'bottom-right': 'bottom:60px; right:60px;',
      'top-left':     'top:60px; left:60px;',
      'top-right':    'top:60px; right:60px;',
    };
    const pos = posStyles[avatarPosition] || posStyles['bottom-left'];
    return `
    <!-- Avatar overlay (circle) — audio comes from this video -->
    <div id="avatar" style="position:absolute; ${pos} z-index:10;">
      <div class="avatar-circle">
        <video id="avatar-video" src="${avatarVideoUrl}" playsinline preload="auto"></video>
      </div>
    </div>`;
  }

  // Learning objective scenes: avatar takes left half, 80%+ height, bottom-anchored
  if (sceneType === 'learning_objective_scene') {
    return `
    <!-- Avatar overlay — avatar video drives audio (Mode 1) -->
    <div id="avatar" style="position:absolute; bottom:0; left:0; width:50%; height:85%; z-index:10; overflow:hidden;">
      <video id="avatar-video" src="${avatarVideoUrl}" playsinline preload="auto"
        style="width:100%; height:100%; object-fit:cover; object-position:center top;"></video>
    </div>`;
  }

  // Presenter torso — position based on LLM choice
  const torsoPositions = {
    'presenter-left': 'bottom:0; left:20px; width:40%; height:90%;',
    'presenter-center': 'bottom:0; left:50%; transform:translateX(-50%); width:40%; height:80%;',
    'presenter-right': 'bottom:0; right:20px; width:40%; height:90%;',
  };
  const torsoStyle = torsoPositions[avatarPosition] || torsoPositions['presenter-left'];

  return `
    <!-- Avatar overlay — avatar video drives audio (Mode 1) -->
    <div id="avatar" style="position:absolute; ${torsoStyle} z-index:10; overflow:hidden;">
      <video id="avatar-video" src="${avatarVideoUrl}" playsinline preload="auto"
        style="width:100%; height:100%; object-fit:cover; object-position:center top;"></video>
    </div>`;
}

// ─── HTML assembly helper ────────────────────────────────────────────────────

function assembleHTML(baseLayout, llmResult, { language, fontLinkTag, themeCSS, fontCSSVars, sceneDuration, audioSrc, timings, avatarVideoUrl, sceneType }) {
  const avatarHtml = buildAvatarOverlay(avatarVideoUrl, sceneType, llmResult.avatarPosition);
  const finalTimings = timings || { ost_timings: [] };

  return baseLayout
    .replace('{{language}}', language)
    .replace('{{fontLinkTag}}', fontLinkTag)
    .replace('{{themeCSS}}', themeCSS)
    .replace('{{fontCSSVars}}', `${fontCSSVars}\n  --scene-duration: ${sceneDuration}s;`)
    .replace('{{sceneCSS}}', llmResult.css || '')
    .replace('{{audioPath}}', audioSrc)
    .replace('{{timingsJSON}}', JSON.stringify(finalTimings))
    .replace('{{sceneScript}}', llmResult.script || '')
    .replace('{{sceneContent}}', llmResult.html || '')
    .replace('{{avatarOverlay}}', avatarHtml);
}

// ─── Single scene render ────────────────────────────────────────────────────

const MAX_VALIDATION_RETRIES = 2;

/**
 * @param {object} scene
 * @param {object} storyboard
 * @param {object} [options]
 * @param {string} [options.audioUrl]        — HTTPS URL for the VO audio
 * @param {string} [options.avatarVideoUrl]  — HTTPS URL for the avatar video
 * @param {string} [options.audioPath]       — local path fallback (for preview)
 * @param {object} [options.timings]         — pre-calculated timing data
 * @param {string} [options.outputDir]       — write HTML file to this directory
 * @param {object} [options.neighbors]       — prev/next scenes for flow context
 * @param {string} [options.themeOverride]
 * @param {boolean} [options.validate=true]  — run visual validation
 */
export async function renderSceneHTMLWithLLM(scene, storyboard, options = {}) {
  const {
    themeOverride = null,
    audioUrl = '',
    audioPath = '',
    avatarVideoUrl = '',
    timings = null,
    outputDir = null,
    neighbors = {},
    validate = true,
  } = options;

  const baseLayout = await readFile(join(TEMPLATES_DIR, 'base-layout.html'), 'utf-8');
  const themeCSS = await getThemeCSS(storyboard.domainKey, themeOverride);
  const fontLinkTag = await generateFontLinkTag(storyboard.language);
  const fontCSSVars = await generateFontCSSVars(storyboard.language);
  const sceneDuration = scene.approxDurationSeconds || 10;

  const prompt = buildPrompt(scene, storyboard, themeCSS, neighbors);

  // Save the latest prompt for debugging (overwrites each run)
  const promptsDir = join(__dirname, '../../prompts');
  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, 'scene-html-generator.txt'), prompt, 'utf-8');

  const assemblyArgs = {
    language: storyboard.language,
    fontLinkTag, themeCSS, fontCSSVars, sceneDuration,
    audioSrc: audioUrl || audioPath,
    timings, avatarVideoUrl, sceneType: scene.sceneType,
  };

  // ── Generate + validate loop ──────────────────────────────────
  let result = null;
  let html = null;
  let currentPrompt = prompt;

  for (let attempt = 0; attempt <= (validate ? MAX_VALIDATION_RETRIES : 0); attempt++) {
    if (attempt === 0) {
      console.log(`  [llm] Generating HTML for ${scene.sceneId} (${scene.sceneType})...`);
    } else {
      console.log(`  [llm] Retrying ${scene.sceneId} (attempt ${attempt + 1}/${MAX_VALIDATION_RETRIES + 1})...`);
    }

    const responseText = await generateContent({ prompt: currentPrompt });
    result = parseLLMResponse(responseText);
    html = assembleHTML(baseLayout, result, assemblyArgs);

    if (!validate) break;

    // Run visual validation
    const sceneContext = buildSceneContext(scene, result.avatarPosition);
    const validation = await validateSceneHTML(html, sceneContext);

    if (validation.pass) {
      if (attempt > 0) console.log(`  [validate] ✓ ${scene.sceneId} passed on retry ${attempt}`);
      else console.log(`  [validate] ✓ ${scene.sceneId} — ${validation.summary}`);
      break;
    }

    console.warn(`  [validate] ✗ ${scene.sceneId} — ${validation.summary}`);
    validation.issues.forEach(issue => console.warn(`    → [${issue.check}] ${issue.message}`));

    if (attempt < MAX_VALIDATION_RETRIES) {
      // Re-prompt with specific errors
      currentPrompt = buildCorrectionPrompt(prompt, result, validation.issues);
    } else {
      console.warn(`  [validate] Proceeding with best effort for ${scene.sceneId}`);
    }
  }

  // Clean up validator browser
  if (validate) await closeValidator();

  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    const outputPath = join(outputDir, `${scene.sceneId}.html`);
    await writeFile(outputPath, html, 'utf-8');
    return outputPath;
  }

  return html;
}

// ─── Batch render with concurrency ──────────────────────────────────────────

export async function renderAllScenesWithLLM(storyboard, options = {}) {
  const { outputDir, themeOverride = null, concurrency = 5, validate = true } = options;

  // Pre-load shared resources once
  const themeCSS = await getThemeCSS(storyboard.domainKey, themeOverride);
  const fontLinkTag = await generateFontLinkTag(storyboard.language);
  const fontCSSVars = await generateFontCSSVars(storyboard.language);
  const baseLayout = await readFile(join(TEMPLATES_DIR, 'base-layout.html'), 'utf-8');

  const scenes = [...storyboard.scenes];
  const results = [];

  for (let i = 0; i < scenes.length; i += concurrency) {
    const batch = scenes.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (scene, batchIdx) => {
        const sceneIdx = i + batchIdx;
        const neighbors = {
          prev: sceneIdx > 0 ? scenes[sceneIdx - 1] : null,
          next: sceneIdx < scenes.length - 1 ? scenes[sceneIdx + 1] : null,
        };

        const sceneDuration = scene.approxDurationSeconds || 10;
        const assemblyArgs = {
          language: storyboard.language,
          fontLinkTag, themeCSS, fontCSSVars, sceneDuration,
          audioSrc: '', timings: null, avatarVideoUrl: '', sceneType: scene.sceneType,
        };

        let result = null;
        let html = null;
        let currentPrompt = buildPrompt(scene, storyboard, themeCSS, neighbors);
        const originalPrompt = currentPrompt;

        for (let attempt = 0; attempt <= (validate ? MAX_VALIDATION_RETRIES : 0); attempt++) {
          if (attempt === 0) {
            console.log(`  [llm] Generating ${scene.sceneId} (${scene.sceneType})...`);
          } else {
            console.log(`  [llm] Retrying ${scene.sceneId} (attempt ${attempt + 1})...`);
          }

          const responseText = await generateContent({ prompt: currentPrompt });
          result = parseLLMResponse(responseText);
          html = assembleHTML(baseLayout, result, assemblyArgs);

          if (!validate) break;

          const sceneContext = buildSceneContext(scene, result.avatarPosition);
          const validation = await validateSceneHTML(html, sceneContext);

          if (validation.pass) {
            if (attempt > 0) console.log(`  [validate] ✓ ${scene.sceneId} passed on retry ${attempt}`);
            else console.log(`  [validate] ✓ ${scene.sceneId} — ${validation.summary}`);
            break;
          }

          console.warn(`  [validate] ✗ ${scene.sceneId} — ${validation.summary}`);
          if (attempt < MAX_VALIDATION_RETRIES) {
            currentPrompt = buildCorrectionPrompt(originalPrompt, result, validation.issues);
          } else {
            console.warn(`  [validate] Proceeding with best effort for ${scene.sceneId}`);
          }
        }

        if (outputDir) {
          await mkdir(outputDir, { recursive: true });
          const outputPath = join(outputDir, `${scene.sceneId}.html`);
          await writeFile(outputPath, html, 'utf-8');
          return { sceneId: scene.sceneId, path: outputPath };
        }
        return { sceneId: scene.sceneId, html };
      })
    );
    results.push(...batchResults);
  }

  // Clean up validator browser
  await closeValidator();

  return results;
}
