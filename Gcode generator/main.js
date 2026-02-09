// main.js - G-code generator voor eenvoudige 2D-vormen

/**
 * Conceptuele enumeraties (stringwaarden in de praktijk).
 */
const ShapeType = {
  CIRCLE: "circle",
  SQUARE: "square",
  RECTANGLE: "rectangle",
  FACING: "facing",
  ELLIPSE: "ellipse",
  LETTERS: "letters",
  COUNTERSUNK_BOLT: "countersunk_bolt",
  PATTERNED_HOLES: "patterned_holes",
};

const OperationType = {
  POCKET: "pocket",
  CONTOUR: "contour",
  FACING: "facing",
};

const XYOrigin = {
  CENTER: "center",
  BOTTOM_LEFT: "bottom_left",
  BOTTOM_RIGHT: "bottom_right",
  TOP_LEFT: "top_left",
  TOP_RIGHT: "top_right",
};

const ZOrigin = {
  STOCK_TOP: "stock_top",
  STOCK_BOTTOM: "stock_bottom",
};

const EntryMethod = {
  PLUNGE: "plunge",
  RAMP: "ramp",
};

/**
 * @typedef {{ x: number, y: number, z: number, type: 'rapid'|'cut' }} ToolpathMove
 * @typedef {{ moves: ToolpathMove[] }} Toolpath
 */

const DEFAULT_SAFE_Z = 10; // mm, standaard veilige hoogte (overschrijfbaar via formulier)

/** Conversie display-eenheid naar mm (intern). */
const MM_PER_INCH = 25.4;
function toMm(value, unit) {
  if (!Number.isFinite(value)) return value;
  return unit === "inch" ? value * MM_PER_INCH : value;
}
function fromMm(mm, unit) {
  if (!Number.isFinite(mm)) return mm;
  return unit === "inch" ? mm / MM_PER_INCH : mm;
}

/** Maximale afwijking (mm) van cirkelboog bij polygoonbenadering; gebruikt om aantal segmenten te bepalen. */
const CIRCLE_TOLERANCE_MM = 0.01;

/**
 * Berekent het aantal lijnsegmenten voor een cirkel met gegeven straal (mm) zodat de maximale
 * afwijking (sagitta) ≤ CIRCLE_TOLERANCE_MM blijft.
 * @param {number} radiusMm - straal in mm
 * @returns {number} aantal segmenten (min 4, max 360)
 */
function segmentsForCircleRadius(radiusMm) {
  if (!Number.isFinite(radiusMm) || radiusMm <= 0) return 4;
  const arg = Math.max(-1, 1 - CIRCLE_TOLERANCE_MM / radiusMm);
  const n = Math.ceil(Math.PI / Math.acos(arg));
  return Math.max(4, Math.min(360, n));
}

/** Font voor lettergravering. Eerst lokaal, anders dit fallback-URL (opentype.js testfont, werkt zonder variable-font fout). */
const LETTER_FONT_URL =
  "https://cdn.jsdelivr.net/gh/opentypejs/opentype.js@master/test/fonts/Roboto-Black.ttf";
/** Lokaal fontbestand (relatief aan de pagina); voor offline gebruik bestand in fonts/ map zetten. */
const LETTER_FONT_LOCAL = "fonts/Roboto-Black.ttf";
let cachedLetterFont = null;

const PreviewViewMode = {
  ISO: "iso",
  TOP: "top",
  FRONT: "front",
  SIDE: "side",
};

/** @type {keyof typeof PreviewViewMode} */
let currentPreviewView = PreviewViewMode.ISO;

/** @type {Toolpath} */
let lastToolpath = { moves: [] };

/**
 * Meertaligheid (i18n). Taal wordt opgeslagen in localStorage onder "gcode-lang".
 * Nieuwe talen: voeg een key toe in TRANSLATIONS (translations.js) en een knop in de lang-switcher.
 */
const LANG_STORAGE_KEY = "gcode-lang";
const DEFAULT_LANG = "nl";
let currentLang = DEFAULT_LANG;

const THEME_STORAGE_KEY = "gcode-theme";
const DEFAULT_THEME = "dark";

const UNIT_STORAGE_KEY = "gcode-unit";
const DEFAULT_UNIT = "mm";
function getDisplayUnit() {
  try {
    const stored = localStorage.getItem(UNIT_STORAGE_KEY);
    if (stored === "mm" || stored === "inch") return stored;
  } catch (_) {}
  return DEFAULT_UNIT;
}

function getCurrentTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch (_) {}
  return DEFAULT_THEME;
}

function getCurrentLang() {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (stored && typeof TRANSLATIONS !== "undefined" && TRANSLATIONS[stored]) return stored;
  } catch (_) {}
  return DEFAULT_LANG;
}

/** Vertaal een key; optioneel object met placeholders, bijv. { label: "Freesdiameter" } voor "{{label}} moet..." */
function t(key, vars) {
  const dict = typeof TRANSLATIONS !== "undefined" && TRANSLATIONS[currentLang] ? TRANSLATIONS[currentLang] : {};
  let s = dict[key] != null ? dict[key] : (TRANSLATIONS[DEFAULT_LANG] && TRANSLATIONS[DEFAULT_LANG][key]) || key;
  if (vars && typeof vars === "object") {
    Object.keys(vars).forEach((k) => {
      s = s.replace(new RegExp("\\{\\{\\s*" + k + "\\s*\\}\\}", "g"), String(vars[k]));
    });
  }
  return s;
}

function setLanguage(lang) {
  if (!TRANSLATIONS[lang]) return;
  currentLang = lang;
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch (_) {}
  document.documentElement.lang = lang;
  applyTranslations();
  document.querySelectorAll(".lang-switcher .lang-btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.getAttribute("data-lang") === lang ? "true" : "false");
  });
  document.dispatchEvent(new CustomEvent("languagechange"));
}

/** Keys die een inch-variant hebben (form.xxxIn) voor label-weergave. */
const UNIT_LABEL_KEYS = [
  "form.patternedHolesDiameter", "form.patternedHolesSpacingX", "form.patternedHolesSpacingY",
  "form.diameter", "form.countersunkHeadDiameter", "form.countersinkDepth", "form.countersunkBoltDiameter",
  "form.side", "form.width", "form.height", "form.majorAxis", "form.minorAxis", "form.letterSize",
  "form.tabInterval", "form.tabWidth", "form.tabHeight",
  "form.toolDiameter", "form.totalDepth", "form.stepdown", "form.feedrate", "form.safeHeight", "form.leadInAbove", "form.zOffset",
];

function applyTranslations() {
  const displayUnit = getDisplayUnit();
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    const effectiveKey = (displayUnit === "inch" && UNIT_LABEL_KEYS.includes(key)) ? key + "In" : key;
    const text = t(effectiveKey);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      /** placeholder wordt apart gezet via data-i18n-placeholder */
      if (!el.hasAttribute("data-i18n-placeholder")) el.placeholder = text;
    } else {
      el.textContent = text;
    }
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.getAttribute("data-i18n-title"));
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label")));
  });
  const titleEl = document.querySelector("title[data-i18n]");
  if (titleEl) titleEl.textContent = t(titleEl.getAttribute("data-i18n"));
}

/**
 * Hulpfuncties
 */
function toNumber(input) {
  if (input == null) return NaN;
  if (typeof input === "number") return Number.isFinite(input) ? input : NaN;
  // Sta zowel punt als komma als decimaalteken toe
  const v = String(input).trim().replace(",", ".");
  if (v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function distance2D(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/**
 * Kleinste karakteristieke maat van de vorm (mm), gebruikt voor checks
 * t.o.v. freesdiameter (bij pocket / binnencontour).
 */
function getShapeMinSize(shape, shapeParams) {
  switch (shape) {
    case ShapeType.CIRCLE:
      return shapeParams.diameter;
    case ShapeType.SQUARE:
      return shapeParams.size;
    case ShapeType.RECTANGLE:
    case ShapeType.FACING:
      return Math.min(shapeParams.width, shapeParams.height);
    case ShapeType.ELLIPSE:
      return Math.min(shapeParams.major, shapeParams.minor);
    case ShapeType.LETTERS:
      return shapeParams.fontSize;
    case ShapeType.COUNTERSUNK_BOLT:
      return Math.min(shapeParams.headDiameter || Infinity, shapeParams.boltDiameter || Infinity);
    case ShapeType.PATTERNED_HOLES:
      return shapeParams.diameter;
    default:
      return NaN;
  }
}

/**
 * Laad het letterfont voor gravering (eenmalig gecached).
 * Volgorde: 1) ingesloten base64 (offline), 2) lokaal bestand fonts/..., 3) CDN-URL.
 * @returns {Promise<import('opentype.js').Font>}
 */
function loadLetterFont() {
  if (cachedLetterFont) return Promise.resolve(cachedLetterFont);
  if (typeof opentype === "undefined") {
    return Promise.reject(new Error(t("error.opentypeNotLoaded")));
  }

  function parseBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return opentype.parse(bytes.buffer);
  }

  if (typeof window !== "undefined" && window.LETTER_FONT_BASE64) {
    try {
      cachedLetterFont = parseBase64(window.LETTER_FONT_BASE64);
      return Promise.resolve(cachedLetterFont);
    } catch (e) {
      console.warn("Ingesloten lettertype kon niet worden geparsed:", e);
    }
  }

  function tryLoad(url) {
    return new Promise((resolve, reject) => {
      opentype.load(url, (err, font) => {
        if (err) reject(err);
        else {
          cachedLetterFont = font;
          resolve(font);
        }
      });
    });
  }

  // Bij file:// (lokaal bestand) faalt laden van fonts/... door CORS; sla lokaal over en gebruik CDN.
  const isFileProtocol = typeof window !== "undefined" && (window.location.protocol === "file:" || !window.location.origin || window.location.origin === "null");
  const loadOrder = isFileProtocol ? [LETTER_FONT_URL] : [LETTER_FONT_LOCAL, LETTER_FONT_URL];

  let chain = Promise.reject();
  for (const url of loadOrder) {
    chain = chain.catch(() => tryLoad(url));
  }
  return chain.catch((err) =>
    Promise.reject(new Error(t("error.fontNotLoaded") + (err && err.message ? err.message : err)))
  );
}

/** Aantal punten om een Bézier-curve te benaderen */
const BEZIER_SEGMENTS = 16;

/**
 * Converteer opentype path-commando's naar een reeks contour-paden (array van punten per contour).
 * @param {import('opentype.js').Path} path
 * @returns {{ x: number, y: number, z: number }[][]}
 */
function pathCommandsToContours(path) {
  const contours = [];
  let current = [];
  let lastX = 0;
  let lastY = 0;

  function addPoint(x, y) {
    current.push({ x, y, z: 0 });
    lastX = x;
    lastY = y;
  }

  function sampleCubic(x1, y1, x2, y2, x, y) {
    for (let i = 1; i <= BEZIER_SEGMENTS; i++) {
      const t = i / BEZIER_SEGMENTS;
      const u = 1 - t;
      const u2 = u * u;
      const u3 = u2 * u;
      const t2 = t * t;
      const t3 = t2 * t;
      const px = u3 * lastX + 3 * u2 * t * x1 + 3 * u * t2 * x2 + t3 * x;
      const py = u3 * lastY + 3 * u2 * t * y1 + 3 * u * t2 * y2 + t3 * y;
      addPoint(px, py);
    }
  }

  function sampleQuadratic(x1, y1, x, y) {
    for (let i = 1; i <= BEZIER_SEGMENTS; i++) {
      const t = i / BEZIER_SEGMENTS;
      const u = 1 - t;
      const px = u * u * lastX + 2 * u * t * x1 + t * t * x;
      const py = u * u * lastY + 2 * u * t * y1 + t * t * y;
      addPoint(px, py);
    }
  }

  const cmds = path.commands;
  if (!Array.isArray(cmds) || cmds.length === 0) return contours;

  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    let cmdType = typeof c.type === "string" ? c.type : "";
    if (cmdType === "curveTo" || cmdType === "bezierCurveTo") cmdType = "C";
    if (cmdType === "quadTo" || cmdType === "quadraticCurveTo") cmdType = "Q";
    cmdType = cmdType.toUpperCase();
    const rel = c.type === "c" || c.type === "q" || c.type === "l" || c.type === "m";
    const ox = rel ? lastX : 0;
    const oy = rel ? lastY : 0;
    const x = (c.x ?? 0) + ox;
    const y = (c.y ?? 0) + oy;
    let x1 = c.x1 ?? c.cp1x;
    let y1 = c.y1 ?? c.cp1y;
    let x2 = c.x2 ?? c.cp2x;
    let y2 = c.y2 ?? c.cp2y;
    if (rel) {
      if (x1 !== undefined) x1 = Number(x1) + ox;
      if (y1 !== undefined) y1 = Number(y1) + oy;
      if (x2 !== undefined) x2 = Number(x2) + ox;
      if (y2 !== undefined) y2 = Number(y2) + oy;
    }

    switch (cmdType) {
      case "M":
        if (current.length > 0) contours.push(current);
        current = [];
        addPoint(x, y);
        break;
      case "L":
        addPoint(x, y);
        break;
      case "C":
        if (
          Number.isFinite(x1) && Number.isFinite(y1) &&
          Number.isFinite(x2) && Number.isFinite(y2) &&
          Number.isFinite(x) && Number.isFinite(y)
        ) {
          sampleCubic(x1, y1, x2, y2, x, y);
        } else {
          addPoint(x, y);
        }
        break;
      case "Q":
        if (Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x) && Number.isFinite(y)) {
          sampleQuadratic(x1, y1, x, y);
        } else {
          addPoint(x, y);
        }
        break;
      case "Z":
        if (current.length > 0) {
          current.push({ ...current[0], z: 0 });
          lastX = current[0].x;
          lastY = current[0].y;
        }
        break;
      default:
        if (Number.isFinite(x) && Number.isFinite(y)) addPoint(x, y);
        break;
    }
  }
  if (current.length > 0) contours.push(current);
  return contours;
}

/**
 * Genereer lettercontouren voor de gegeven tekst (omtrek per contour, in mm).
 * Vereist dat loadLetterFont() eerder is aangeroepen.
 * @param {string} text
 * @param {number} fontSizeMm
 * @param {string} xyOrigin - "center" | "bottom_left" | "bottom_right" | "top_left" | "top_right"
 * @param {import('opentype.js').Font} font
 * @returns {{ x: number, y: number, z: number }[][]}
 */
function getLetterPathsFromFont(text, fontSizeMm, xyOrigin, font) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0);
  const lineHeight = fontSizeMm * 1.25;
  /** @type {{ x: number, y: number, z: number }[][]} */
  let allContours = [];
  let yOff = 0;
  for (const line of lines) {
    const path = font.getPath(line, 0, yOff, fontSizeMm);
    const contours = pathCommandsToContours(path);
    allContours = allContours.concat(contours);
    yOff -= lineHeight;
  }
  if (allContours.length === 0) return [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const contour of allContours) {
    for (const p of contour) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  let dx, dy;
  switch (xyOrigin) {
    case XYOrigin.CENTER: dx = -cx; dy = -cy; break;
    case XYOrigin.BOTTOM_LEFT: dx = -minX; dy = -minY; break;
    case XYOrigin.BOTTOM_RIGHT: dx = -maxX; dy = -minY; break;
    case XYOrigin.TOP_LEFT: dx = -minX; dy = -maxY; break;
    case XYOrigin.TOP_RIGHT: dx = -maxX; dy = -maxY; break;
    default: dx = -minX; dy = -minY; break;
  }

  // Fontcoördinaten: alleen Y spiegelen zodat letters rechtop staan; X niet spiegelen zodat tekst links-naar-rechts leesbaar is (HANS)
  return allContours.map((contour) =>
    contour.map((p) => ({
      x: p.x + dx,
      y: -(p.y + dy),
      z: 0,
    }))
  );
}

/**
 * Roteer een lijst contour-paden rond de oorsprong (0,0).
 * @param {{ x: number, y: number, z: number }[][]} paths
 * @param {number} angleDeg - hoek in graden; positief = met de klok mee (90 = tekst 90° naar rechts)
 * @returns {{ x: number, y: number, z: number }[][]}
 */
function rotatePathsAroundOrigin(paths, angleDeg) {
  if (!paths || paths.length === 0 || (angleDeg % 360 === 0)) return paths;
  const rad = degToRad(-angleDeg); // omzetten naar wiskundige hoek (CCW positief)
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return paths.map((contour) =>
    contour.map((p) => ({
      x: p.x * cos - p.y * sin,
      y: p.x * sin + p.y * cos,
      z: p.z,
    }))
  );
}

/**
 * Bepaal de kleinste afmeting van een contour (geschatte breedte/hoogte van de bbox).
 * @param {{ x: number, y: number }[]} pts
 * @returns {number}
 */
function contourMinSize(pts) {
  if (!pts || pts.length < 2) return 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.min(maxX - minX, maxY - minY);
}

/**
 * Bepaal of een gesloten polygoon (punten tegen de klok in) rechtsom (CW) of linksom (CCW) is.
 * Positieve signed area = CCW (tegen de klok in), negatief = CW.
 * @param {{ x: number, y: number }[]} pts
 * @returns {number} signed area * 2 (positief = CCW)
 */
function polygonSignedArea2(pts) {
  if (!pts || pts.length < 3) return 0;
  let sum = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += (pts[j].x - pts[i].x) * (pts[j].y + pts[i].y);
  }
  return sum;
}

/**
 * Contour één afstand naar binnen (inset) of buiten (outset) verschuiven.
 * Startpunt: letteromtrek → contour op freesstraal naar binnen = rand waar het toolcentrum mag.
 * Simpel miter-offset; contour wordt eerst genormaliseerd (dubbele punten en nul-randen weg).
 *
 * @param {{ x: number, y: number, z: number }[]} contour - gesloten contour
 * @param {number} distance - positief = naar binnen, negatief = naar buiten (mm)
 * @param {{ failReason?: string }} [debug]
 * @returns {{ x: number, y: number, z: number }[] | null}
 */
function contourOffset(contour, distance, debug) {
  if (!contour || contour.length < 3) {
    if (debug) debug.failReason = "contour te kort of leeg";
    return null;
  }
  if (distance === 0) return contour.map((p) => ({ ...p }));

  let pts = contour;
  const n = pts.length;
  const closed = n >= 2 && Math.abs(pts[n - 1].x - pts[0].x) < 1e-9 && Math.abs(pts[n - 1].y - pts[0].y) < 1e-9;
  if (closed) pts = pts.slice(0, n - 1);

  const tol = 1e-6;
  const minLen = 1e-6;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = out.length ? out[out.length - 1] : null;
    if (!prev || Math.abs(p.x - prev.x) > tol || Math.abs(p.y - prev.y) > tol) out.push({ ...p });
  }
  pts = out;
  if (pts.length < 3) {
    if (debug) debug.failReason = "te weinig punten na opschonen";
    return null;
  }

  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i + pts.length - 1) % pts.length];
      const curr = pts[i];
      const nextP = pts[(i + 1) % pts.length];
      const len1 = Math.hypot(curr.x - prev.x, curr.y - prev.y);
      const len2 = Math.hypot(nextP.x - curr.x, nextP.y - curr.y);
      if (len1 < minLen && len2 < minLen) { changed = true; continue; }
      if (len1 < minLen) {
        next.push({ x: 0.5 * (prev.x + curr.x), y: 0.5 * (prev.y + curr.y), z: curr.z ?? 0 });
        changed = true;
        continue;
      }
      if (len2 < minLen) {
        next.push({ x: 0.5 * (curr.x + nextP.x), y: 0.5 * (curr.y + nextP.y), z: curr.z ?? 0 });
        changed = true;
        continue;
      }
      next.push(curr);
    }
    if (next.length < 3) return null;
    pts = next;
    if (!changed) break;
  }

  const num = pts.length;
  const area2 = polygonSignedArea2(pts);
  const sign = area2 >= 0 ? 1 : -1;
  const d = distance;
  const z0 = pts[0].z ?? 0;

  const result = [];
  for (let i = 0; i < num; i++) {
    const prev = pts[(i + num - 1) % num];
    const curr = pts[i];
    const next = pts[(i + 1) % num];
    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;
    const len1 = Math.hypot(dx1, dy1);
    const len2 = Math.hypot(dx2, dy2);
    if (len1 < minLen || len2 < minLen) {
      if (debug) debug.failReason = "nul-rand in contour (letter te smal voor offset)";
      return null;
    }
    const nx1 = sign * (-dy1 / len1);
    const ny1 = sign * (dx1 / len1);
    const nx2 = sign * (-dy2 / len2);
    const ny2 = sign * (dx2 / len2);
    const A1x = prev.x + d * nx1;
    const A1y = prev.y + d * ny1;
    const A2x = curr.x + d * nx2;
    const A2y = curr.y + d * ny2;
    const D1x = dx1;
    const D1y = dy1;
    const D2x = dx2;
    const D2y = dy2;
    const cross = D1x * D2y - D1y * D2x;
    if (Math.abs(cross) < 1e-14) {
      result.push({ x: 0.5 * (A1x + A2x), y: 0.5 * (A1y + A2y), z: z0 });
      continue;
    }
    const t = ((A2x - A1x) * D2y - (A2y - A1y) * D2x) / cross;
    result.push({
      x: A1x + t * D1x,
      y: A1y + t * D1y,
      z: z0,
    });
  }

  if (result.length < 3) return null;
  const outArea2 = polygonSignedArea2(result);
  if (Math.abs(outArea2) < 1e-6) {
    if (debug) debug.failReason = "te kleine oppervlakte na offset (frees te groot of letter te smal)";
    return null;
  }
  if (outArea2 * area2 < 0) {
    if (debug) debug.failReason = "polygoon kantelt na offset";
    return null;
  }
  result.push({ ...result[0], z: z0 });
  return result;
}

const MAX_POCKET_RINGS = 300;

/**
 * Pocket-ringen: start met gegeven contour (al op freesstraal naar binnen), dan herhaald stepover naar binnen.
 */
function pocketRingsFromInnerContour(innerContour, stepover) {
  const rings = [];
  let current = innerContour;
  let it = 0;
  while (current && current.length >= 3 && it < MAX_POCKET_RINGS) {
    it++;
    rings.push(current);
    current = contourOffset(current, stepover);
    if (!current) break;
  }
  return rings;
}

/**
 * Input lezen en valideren
 */
function readInputsFromForm() {
  const g = (id) => document.getElementById(id);
  const displayUnit = getDisplayUnit();

  const shape = /** @type {HTMLSelectElement} */ (g("shape")).value;
  const operationRaw = /** @type {HTMLSelectElement} */ (g("operation")).value;
  const operation = (shape === ShapeType.FACING ? OperationType.FACING : shape === ShapeType.PATTERNED_HOLES ? OperationType.POCKET : operationRaw);

  const shapeParams = { type: shape };
  if (shape === ShapeType.CIRCLE) {
    shapeParams.diameter = toMm(toNumber(g("circle-diameter").value), displayUnit);
  } else if (shape === ShapeType.SQUARE) {
    shapeParams.size = toMm(toNumber(g("square-size").value), displayUnit);
  } else if (shape === ShapeType.RECTANGLE || shape === ShapeType.FACING) {
    shapeParams.width = toMm(toNumber(g("rect-width").value), displayUnit);
    shapeParams.height = toMm(toNumber(g("rect-height").value), displayUnit);
  } else if (shape === ShapeType.ELLIPSE) {
    shapeParams.major = toMm(toNumber(g("ellipse-major").value), displayUnit);
    shapeParams.minor = toMm(toNumber(g("ellipse-minor").value), displayUnit);
  } else if (shape === ShapeType.LETTERS) {
    shapeParams.text = (g("letter-text") && g("letter-text").value) || "";
    shapeParams.fontSize = toMm(toNumber(g("letter-size")?.value) || 10, displayUnit);
    shapeParams.letterOrientation = toNumber(g("letter-orientation")?.value) || 0;
  } else if (shape === ShapeType.COUNTERSUNK_BOLT) {
    shapeParams.headDiameter = toMm(toNumber(g("countersunk-head-diameter")?.value), displayUnit);
    shapeParams.countersinkDepth = toMm(toNumber(g("countersunk-depth")?.value), displayUnit);
    shapeParams.boltDiameter = toMm(toNumber(g("countersunk-bolt-diameter")?.value), displayUnit);
    const totalD = toMm(toNumber(g("total-depth").value), displayUnit);
    shapeParams.boltHoleDepth = Number.isFinite(totalD) && Number.isFinite(shapeParams.countersinkDepth)
      ? Math.max(0, totalD - shapeParams.countersinkDepth)
      : 0;
  } else if (shape === ShapeType.PATTERNED_HOLES) {
    shapeParams.diameter = toMm(toNumber(g("patterned-holes-diameter")?.value), displayUnit);
    shapeParams.spacingX = toMm(toNumber(g("patterned-holes-spacing-x")?.value), displayUnit);
    shapeParams.spacingY = toMm(toNumber(g("patterned-holes-spacing-y")?.value), displayUnit);
    shapeParams.countX = Math.max(1, Math.floor(toNumber(g("patterned-holes-count-x")?.value) || 1));
    shapeParams.countY = Math.max(1, Math.floor(toNumber(g("patterned-holes-count-y")?.value) || 1));
  }

  const letterMode = shape === ShapeType.LETTERS
    ? (/** @type {HTMLSelectElement} */ (g("letter-mode"))?.value || "outline")
    : "outline";

  // Bij letters outline vragen we geen freesdikte; gebruik vaste kolom 0,5 mm
  const toolDiameter = (shape === ShapeType.LETTERS && letterMode === "outline")
    ? 0.5
    : toMm(toNumber(g("tool-diameter").value), displayUnit);
  let totalDepth = toMm(toNumber(g("total-depth").value), displayUnit);
  const multipleDepths = /** @type {HTMLInputElement} */ (g("multiple-depths"))?.checked ?? false;
  let stepdown = multipleDepths ? toMm(toNumber(g("stepdown").value), displayUnit) : totalDepth;
  if (shape === ShapeType.COUNTERSUNK_BOLT && !multipleDepths) {
    stepdown = totalDepth;
  }
  const stepoverUnit = /** @type {HTMLInputElement} */ (document.querySelector('input[name="stepover-unit"]:checked'))?.value ?? "percent";
  const stepoverEl = /** @type {HTMLInputElement | null} */ (g("stepover"));
  const stepoverValue = stepoverEl ? toNumber(stepoverEl.value) : NaN;
  let stepoverMm = stepoverUnit === "percent" && Number.isFinite(toolDiameter) && Number.isFinite(stepoverValue)
    ? (stepoverValue / 100) * toolDiameter
    : stepoverUnit === "mm"
      ? toMm(stepoverValue, displayUnit)
      : NaN;
  // Fallback bij lege/ongeldige stepover: 50% van freesdiameter
  if (!Number.isFinite(stepoverMm) || stepoverMm <= 0) {
    stepoverMm = Number.isFinite(toolDiameter) && toolDiameter > 0 ? 0.5 * toolDiameter : 3;
    if (stepoverEl) {
      if (stepoverUnit === "percent") {
        stepoverEl.value = "50";
      } else {
        stepoverEl.value = String(Math.round(fromMm(stepoverMm, displayUnit) * 1000) / 1000);
      }
    }
  }
  stepoverMm = Math.min(stepoverMm, Number.isFinite(toolDiameter) ? toolDiameter : stepoverMm);

  const cutParams = {
    toolDiameter,
    totalDepth,
    stepdown,
    stepover: stepoverMm,
    feedrate: toMm(toNumber(g("feedrate").value), displayUnit),
    safeHeight: toMm(toNumber(g("safe-height").value) || DEFAULT_SAFE_Z, displayUnit),
    leadInAboveMm: toMm(toNumber(g("lead-in-above").value), displayUnit),
  };

  const originParams = {
    xyOrigin: /** @type {HTMLSelectElement} */ (g("xy-origin")).value,
    zOrigin: /** @type {HTMLSelectElement} */ (g("z-origin")).value,
    zOffset: toMm(toNumber(g("z-offset").value) || 0, displayUnit),
  };
  const entryMethod = /** @type {HTMLInputElement} */ (g("entry-method"))?.value;

  const rampAngle = toNumber(g("ramp-angle").value);

  const plungeOutsideRaw = /** @type {HTMLInputElement} */ (g("plunge-outside"))?.value ?? "off";
  // Bij pocket en facing altijd uit: optie "insteken naast part" is alleen voor contour
  const plungeOutside = (operation === OperationType.POCKET || operation === OperationType.FACING) ? false : plungeOutsideRaw === "on";

  const facingModeRaw = (/** @type {HTMLSelectElement} */ (g("facing-mode")))?.value?.trim?.() ?? "";
  const facingMode = facingModeRaw === "within" ? "within" : "full";

  const contourType = /** @type {HTMLSelectElement} */ (
    g("contour-type")
  )?.value;

  const tabsEnabled = /** @type {HTMLInputElement} */ (
    g("tabs-enabled")
  )?.checked ?? false;
  let tabInterval = toMm(toNumber(g("tab-interval")?.value), displayUnit);
  let tabWidth = toMm(toNumber(g("tab-width")?.value), displayUnit);
  let tabHeight = toMm(toNumber(g("tab-height")?.value), displayUnit);

  // Defaults/fix bij ingeschakelde tabs met lege/ongeldige waarden
  if (tabsEnabled) {
    const tabIntervalEl = /** @type {HTMLInputElement | null} */ (g("tab-interval"));
    const tabWidthEl = /** @type {HTMLInputElement | null} */ (g("tab-width"));
    const tabHeightEl = /** @type {HTMLInputElement | null} */ (g("tab-height"));

    if (!Number.isFinite(tabInterval) || tabInterval <= 0) {
      tabInterval = 40;
      if (tabIntervalEl) tabIntervalEl.value = String(fromMm(40, displayUnit));
    }
    if (!Number.isFinite(tabWidth) || tabWidth <= 0) {
      tabWidth = 8;
      if (tabWidthEl) tabWidthEl.value = String(fromMm(8, displayUnit));
    }
    if (!Number.isFinite(tabHeight) || tabHeight <= 0) {
      tabHeight = 1.0;
      if (tabHeightEl) tabHeightEl.value = String(fromMm(1.0, displayUnit));
    }
  }

  return {
    shape,
    operation,
    shapeParams,
    letterMode,
    contourType: contourType === "inside" ? "inside" : "outside",
    facingMode,
    cutParams: {
      ...cutParams,
      entryMethod: entryMethod || EntryMethod.PLUNGE,
      rampAngleMax: rampAngle || 3,
    },
    originParams,
    plungeOutside,
    tabs: {
      enabled: tabsEnabled,
      interval: tabInterval,
      width: tabWidth,
      height: tabHeight,
    },
  };
}

function validateInputs(raw) {
  const errors = [];

  const cp = raw.cutParams;
  const sp = raw.shapeParams;

  function assertPositive(value, labelKey) {
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(t("error.positive", { label: t(labelKey) }));
    }
  }

  const isLettersOutline =
    raw.shape === ShapeType.LETTERS && (raw.letterMode || "outline") === "outline";
  if (!isLettersOutline) {
    assertPositive(cp.toolDiameter, "field.toolDiameter");
  }
  assertPositive(cp.totalDepth, "field.totalDepth");
  assertPositive(cp.stepdown, "field.stepdown");
  if (!isLettersOutline) {
    assertPositive(cp.stepover, "field.stepover");
  }
  assertPositive(cp.feedrate, "field.feedrate");
  assertPositive(cp.safeHeight, "field.safeHeight");
  if (Number.isFinite(cp.leadInAboveMm) && cp.leadInAboveMm < 0) {
    errors.push(t("error.leadInNegative"));
  }

  if (cp.stepdown > cp.totalDepth) {
    errors.push(t("error.stepdownTooBig"));
  }

  if (
    !isLettersOutline &&
    Number.isFinite(cp.toolDiameter) &&
    cp.stepover > cp.toolDiameter
  ) {
    errors.push(t("error.stepoverTooBig"));
  }

  if (raw.cutParams.entryMethod === EntryMethod.RAMP) {
    assertPositive(raw.cutParams.rampAngleMax, "field.rampAngle");
  }

  if (raw.operation === OperationType.CONTOUR && raw.tabs?.enabled) {
    assertPositive(raw.tabs.interval, "field.tabInterval");
    assertPositive(raw.tabs.width, "field.tabWidth");
    assertPositive(raw.tabs.height, "field.tabHeight");
  }

  switch (raw.shape) {
    case ShapeType.CIRCLE:
      assertPositive(sp.diameter, "field.diameter");
      break;
    case ShapeType.SQUARE:
      assertPositive(sp.size, "field.side");
      break;
    case ShapeType.RECTANGLE:
    case ShapeType.FACING:
      assertPositive(sp.width, "field.width");
      assertPositive(sp.height, "field.height");
      break;
    case ShapeType.ELLIPSE:
      assertPositive(sp.major, "field.majorAxis");
      assertPositive(sp.minor, "field.minorAxis");
      break;
    case ShapeType.LETTERS:
      if (!sp.text || String(sp.text).trim() === "") {
        errors.push(t("error.enterText"));
      }
      assertPositive(sp.fontSize, "field.letterSize");
      break;
    case ShapeType.COUNTERSUNK_BOLT: {
      assertPositive(sp.headDiameter, "field.countersunkHeadDiameter");
      assertPositive(sp.countersinkDepth, "field.countersinkDepth");
      assertPositive(sp.boltDiameter, "field.countersunkBoltDiameter");
      const boltHoleDepth = Number.isFinite(cp.totalDepth) && Number.isFinite(sp.countersinkDepth)
        ? cp.totalDepth - sp.countersinkDepth
        : NaN;
      if (Number.isFinite(boltHoleDepth) && boltHoleDepth <= 0) {
        errors.push(t("error.countersunkTotalDepthTooSmall"));
      }
      if (Number.isFinite(sp.headDiameter) && Number.isFinite(sp.boltDiameter) && sp.headDiameter < sp.boltDiameter) {
        errors.push(t("error.countersunkHeadSmallerThanBolt"));
      }
      break;
    }
    case ShapeType.PATTERNED_HOLES: {
      assertPositive(sp.diameter, "field.patternedHolesDiameter");
      assertPositive(sp.spacingX, "field.patternedHolesSpacingX");
      assertPositive(sp.spacingY, "field.patternedHolesSpacingY");
      if (!Number.isFinite(sp.countX) || sp.countX < 1) {
        errors.push(t("error.positive", { label: t("field.patternedHolesCountX") }));
      }
      if (!Number.isFinite(sp.countY) || sp.countY < 1) {
        errors.push(t("error.positive", { label: t("field.patternedHolesCountY") }));
      }
      break;
    }
    default:
      errors.push(t("error.unknownShape"));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const toolD = cp.toolDiameter;
  const isPocketOrInsideContour =
    raw.operation === OperationType.POCKET ||
    (raw.operation === OperationType.CONTOUR && raw.contourType === "inside");
  if (
    raw.shape !== ShapeType.LETTERS &&
    raw.shape !== ShapeType.COUNTERSUNK_BOLT &&
    isPocketOrInsideContour &&
    Number.isFinite(toolD) &&
    toolD > 0
  ) {
    const minSize = getShapeMinSize(raw.shape, sp);
    if (Number.isFinite(minSize)) {
      const eps = 1e-6;
      if (minSize + eps < toolD) {
        errors.push(t("error.pocketSmallerThanTool"));
      }
    }
  }
  if (raw.shape === ShapeType.COUNTERSUNK_BOLT && Number.isFinite(toolD) && toolD > 0) {
    const eps = 1e-6;
    if (Number.isFinite(sp.headDiameter) && sp.headDiameter + eps < toolD) {
      errors.push(t("error.pocketSmallerThanTool"));
    }
    if (Number.isFinite(sp.boltDiameter) && sp.boltDiameter + eps < toolD) {
      errors.push(t("error.pocketSmallerThanTool"));
    }
  }

  if ((raw.operation === OperationType.FACING || raw.shape === ShapeType.FACING) &&
      Number.isFinite(toolD) &&
      toolD > 0) {
    const w = raw.shape === ShapeType.SQUARE ? sp.size : sp.width;
    const h = raw.shape === ShapeType.SQUARE ? sp.size : sp.height;
    if (Number.isFinite(w) && Number.isFinite(h)) {
      const minDim = Math.min(w, h);
      if (raw.facingMode === "within" && minDim + 1e-6 <= toolD) {
        errors.push(t("error.pocketSmallerThanTool"));
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, params: raw };
}

/**
 * Dieptes per laag bepalen (negatieve Z, uitgaande van Z=0 op stock-oppervlak).
 * stepdown = max. laaghoogte; alle tussenlagen worden even hoog (bijv. diepte 3, max laag 2 → lagen 1.5, 3).
 */
function computeDepthLevels(totalDepth, stepdown) {
  const numLayers = Math.max(1, Math.ceil(totalDepth / stepdown));
  const layerHeight = totalDepth / numLayers;
  const depths = [];
  const round1 = (v) => Math.round(v * 10) / 10;
  for (let i = 1; i <= numLayers; i++) {
    const z = i === numLayers ? -totalDepth : -i * layerHeight;
    depths.push(-round1(Math.abs(z)));
  }
  return depths;
}

/**
 * Basisvormpaden (XY, Z=0) genereren.
 * Resultaat: array van punten (gesloten polyline) op Z=0.
 */
function generateBasePath(shape, shapeParams, operation) {
  const points = [];

  if (shape === ShapeType.CIRCLE) {
    const radius = shapeParams.diameter / 2;
    const SEGMENTS = segmentsForCircleRadius(radius);
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = (i / SEGMENTS) * 2 * Math.PI;
      points.push({ x: radius * Math.cos(t), y: radius * Math.sin(t), z: 0 });
    }
  } else if (shape === ShapeType.ELLIPSE) {
    const rx = shapeParams.major / 2;
    const ry = shapeParams.minor / 2;
    const SEGMENTS = segmentsForCircleRadius(Math.max(rx, ry));
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = (i / SEGMENTS) * 2 * Math.PI;
      points.push({ x: rx * Math.cos(t), y: ry * Math.sin(t), z: 0 });
    }
  } else if (shape === ShapeType.SQUARE) {
    const half = shapeParams.size / 2;
    points.push({ x: -half, y: -half, z: 0 });
    points.push({ x: half, y: -half, z: 0 });
    points.push({ x: half, y: half, z: 0 });
    points.push({ x: -half, y: half, z: 0 });
    points.push({ x: -half, y: -half, z: 0 });
  } else if (shape === ShapeType.RECTANGLE) {
    const hw = shapeParams.width / 2;
    const hh = shapeParams.height / 2;
    points.push({ x: -hw, y: -hh, z: 0 });
    points.push({ x: hw, y: -hh, z: 0 });
    points.push({ x: hw, y: hh, z: 0 });
    points.push({ x: -hw, y: hh, z: 0 });
    points.push({ x: -hw, y: -hh, z: 0 });
  }

  return points;
}

/**
 * Contourpad met freescompensatie: pad ligt op halve freesdiameter van de vorm.
 * @param {string} shape
 * @param {*} shapeParams
 * @param {number} toolRadius
 * @param {boolean} contourInside - true = binnencontour (pad naar binnen), false = buitencontour (pad naar buiten)
 * @returns {{x:number,y:number,z:number}[]}
 */
function generateContourPathWithOffset(shape, shapeParams, toolRadius, contourInside) {
  const offset = contourInside ? -toolRadius : toolRadius;
  const points = [];

  if (shape === ShapeType.CIRCLE) {
    const radius = shapeParams.diameter / 2 + offset;
    if (radius <= 0) return [];
    const SEGMENTS = segmentsForCircleRadius(radius);
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = (i / SEGMENTS) * 2 * Math.PI;
      points.push({ x: radius * Math.cos(t), y: radius * Math.sin(t), z: 0 });
    }
  } else if (shape === ShapeType.ELLIPSE) {
    const rx = shapeParams.major / 2 + offset;
    const ry = shapeParams.minor / 2 + offset;
    if (rx <= 0 || ry <= 0) return [];
    const SEGMENTS = segmentsForCircleRadius(Math.max(rx, ry));
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = (i / SEGMENTS) * 2 * Math.PI;
      points.push({ x: rx * Math.cos(t), y: ry * Math.sin(t), z: 0 });
    }
  } else if (shape === ShapeType.SQUARE) {
    const half = shapeParams.size / 2 + offset;
    if (half <= 0) return [];

    if (!contourInside) {
      // Buitencontour vierkant: hoeken afronden om trillingen te verminderen.
      const hw = half;
      const hh = half;
      const rCorner = Math.max(
        Math.min(toolRadius * 0.8, hw * 0.5, hh * 0.5),
        0
      );
      const cornerSteps = 10;
      // Rechte stukken beginnen/stoppen rCorner voor de hoeken.
      const left = -hw;
      const right = hw;
      const bottom = -hh;
      const top = hh;

      // Start op midden van onderzijde (links) en ga tegen de klok in.
      // Onderzijde: van (left + rCorner, bottom) naar (right - rCorner, bottom)
      for (let x = left + rCorner; x <= right - rCorner + 1e-6; x += (right - left - 2 * rCorner) / Math.max(cornerSteps, 1)) {
        points.push({ x, y: bottom, z: 0 });
      }
      // Onder‑rechts hoek (kwartcirkel)
      {
        const cx = right - rCorner;
        const cy = bottom + rCorner;
        for (let i = 0; i <= cornerSteps; i++) {
          const t = -Math.PI / 2 + (i / cornerSteps) * (Math.PI / 2);
          points.push({ x: cx + rCorner * Math.cos(t), y: cy + rCorner * Math.sin(t), z: 0 });
        }
      }
      // Rechterzijde
      for (let y = bottom + rCorner; y <= top - rCorner + 1e-6; y += (top - bottom - 2 * rCorner) / Math.max(cornerSteps, 1)) {
        points.push({ x: right, y, z: 0 });
      }
      // Boven‑rechts hoek
      {
        const cx = right - rCorner;
        const cy = top - rCorner;
        for (let i = 0; i <= cornerSteps; i++) {
          const t = 0 + (i / cornerSteps) * (Math.PI / 2);
          points.push({ x: cx + rCorner * Math.cos(t), y: cy + rCorner * Math.sin(t), z: 0 });
        }
      }
      // Bovenzijde
      for (let x = right - rCorner; x >= left + rCorner - 1e-6; x -= (right - left - 2 * rCorner) / Math.max(cornerSteps, 1)) {
        points.push({ x, y: top, z: 0 });
      }
      // Boven‑links hoek
      {
        const cx = left + rCorner;
        const cy = top - rCorner;
        for (let i = 0; i <= cornerSteps; i++) {
          const t = Math.PI / 2 + (i / cornerSteps) * (Math.PI / 2);
          points.push({ x: cx + rCorner * Math.cos(t), y: cy + rCorner * Math.sin(t), z: 0 });
        }
      }
      // Linkerzijde
      for (let y = top - rCorner; y >= bottom + rCorner - 1e-6; y -= (top - bottom - 2 * rCorner) / Math.max(cornerSteps, 1)) {
        points.push({ x: left, y, z: 0 });
      }
      // Onder‑links hoek
      {
        const cx = left + rCorner;
        const cy = bottom + rCorner;
        for (let i = 0; i <= cornerSteps; i++) {
          const t = Math.PI + (i / cornerSteps) * (Math.PI / 2);
          points.push({ x: cx + rCorner * Math.cos(t), y: cy + rCorner * Math.sin(t), z: 0 });
        }
      }
      // Sluiten
      points.push(points[0]);
    } else {
      // Binnencontour: klassieke scherpe hoeken.
      points.push({ x: -half, y: -half, z: 0 });
      points.push({ x: half, y: -half, z: 0 });
      points.push({ x: half, y: half, z: 0 });
      points.push({ x: -half, y: half, z: 0 });
      points.push({ x: -half, y: -half, z: 0 });
    }
  } else if (shape === ShapeType.RECTANGLE) {
    const hw = shapeParams.width / 2 + offset;
    const hh = shapeParams.height / 2 + offset;
    if (hw <= 0 || hh <= 0) return [];

    if (!contourInside) {
      // Buitencontour rechthoek: hoeken afronden.
      const rCorner = Math.max(
        Math.min(toolRadius * 0.8, hw * 0.5, hh * 0.5),
        0
      );
      const cornerSteps = 10;
      const left = -hw;
      const right = hw;
      const bottom = -hh;
      const top = hh;

      // Onderzijde
      for (let x = left + rCorner; x <= right - rCorner + 1e-6; x += (right - left - 2 * rCorner) / Math.max(cornerSteps, 1)) {
        points.push({ x, y: bottom, z: 0 });
      }
      // Onder‑rechts hoek
      {
        const cx = right - rCorner;
        const cy = bottom + rCorner;
        for (let i = 0; i <= cornerSteps; i++) {
          const t = -Math.PI / 2 + (i / cornerSteps) * (Math.PI / 2);
          points.push({ x: cx + rCorner * Math.cos(t), y: cy + rCorner * Math.sin(t), z: 0 });
        }
      }
      // Rechterzijde
      for (let y = bottom + rCorner; y <= top - rCorner + 1e-6; y += (top - bottom - 2 * rCorner) / Math.max(cornerSteps, 1)) {
        points.push({ x: right, y, z: 0 });
      }
      // Boven‑rechts hoek
      {
        const cx = right - rCorner;
        const cy = top - rCorner;
        for (let i = 0; i <= cornerSteps; i++) {
          const t = 0 + (i / cornerSteps) * (Math.PI / 2);
          points.push({ x: cx + rCorner * Math.cos(t), y: cy + rCorner * Math.sin(t), z: 0 });
        }
      }
      // Bovenzijde
      for (let x = right - rCorner; x >= left + rCorner - 1e-6; x -= (right - left - 2 * rCorner) / Math.max(cornerSteps, 1)) {
        points.push({ x, y: top, z: 0 });
      }
      // Boven‑links hoek
      {
        const cx = left + rCorner;
        const cy = top - rCorner;
        for (let i = 0; i <= cornerSteps; i++) {
          const t = Math.PI / 2 + (i / cornerSteps) * (Math.PI / 2);
          points.push({ x: cx + rCorner * Math.cos(t), y: cy + rCorner * Math.sin(t), z: 0 });
        }
      }
      // Linkerzijde
      for (let y = top - rCorner; y >= bottom + rCorner - 1e-6; y -= (top - bottom - 2 * rCorner) / Math.max(cornerSteps, 1)) {
        points.push({ x: left, y, z: 0 });
      }
      // Onder‑links hoek
      {
        const cx = left + rCorner;
        const cy = bottom + rCorner;
        for (let i = 0; i <= cornerSteps; i++) {
          const t = Math.PI + (i / cornerSteps) * (Math.PI / 2);
          points.push({ x: cx + rCorner * Math.cos(t), y: cy + rCorner * Math.sin(t), z: 0 });
        }
      }
      // Sluiten
      points.push(points[0]);
    } else {
      // Binnencontour: klassieke scherpe hoeken.
      points.push({ x: -hw, y: -hh, z: 0 });
      points.push({ x: hw, y: -hh, z: 0 });
      points.push({ x: hw, y: hh, z: 0 });
      points.push({ x: -hw, y: hh, z: 0 });
      points.push({ x: -hw, y: -hh, z: 0 });
    }
  }

  return points;
}

/**
 * Voor vierkant/rechthoek: startpunt van contourpad verplaatsen naar
 * het midden van een zijde (in plaats van een hoek), zodat lead-in
 * netjes tangent op een rechte zijde kan zijn.
 * @param {{x:number,y:number,z:number}[]} path
 */
function adjustRectContourStartToEdgeMid(path) {
  if (!path || path.length < 4) return path;

  // Zoek een hoek met maximale X (rechterzijde).
  let maxX = -Infinity;
  let idx = -1;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (p.x > maxX + 1e-9) {
      maxX = p.x;
      idx = i;
    }
  }
  if (idx < 0) return path;

  const nextIdx = (idx + 1) % path.length;
  const v0 = path[idx];
  const v1 = path[nextIdx];
  const mid = {
    x: (v0.x + v1.x) / 2,
    y: (v0.y + v1.y) / 2,
    z: v0.z,
  };

  const newPath = [];
  newPath.push(mid);
  // vanaf volgende hoek tot einde
  for (let i = nextIdx; i < path.length; i++) {
    newPath.push(path[i]);
  }
  // van begin tot en met gekozen hoek
  for (let i = 0; i <= idx; i++) {
    newPath.push(path[i]);
  }
  // sluiten op mid
  newPath.push(mid);

  return newPath;
}

/**
 * Pocket-paden genereren als reeks van polyline-ringen.
 * Voor een simpele eerste versie gebruiken we offset-ringen:
 * - Cirkel/ellipse: schalen
 * - Vierkant/rechthoek: offsetten van de randen
 */
function generatePocketRings(shape, shapeParams, stepover, toolRadius) {
  const rings = [];

  if (shape === ShapeType.CIRCLE) {
    const maxR = shapeParams.diameter / 2 - toolRadius;
    if (maxR <= 0) return [];
    const SEGMENTS = segmentsForCircleRadius(maxR);
    for (let r = toolRadius; r <= maxR + 1e-6; r += stepover) {
      const pts = [];
      for (let i = 0; i <= SEGMENTS; i++) {
        const t = (i / SEGMENTS) * 2 * Math.PI;
        pts.push({ x: r * Math.cos(t), y: r * Math.sin(t), z: 0 });
      }
      rings.push(pts);
    }
  } else if (shape === ShapeType.ELLIPSE) {
    const rxMax = shapeParams.major / 2 - toolRadius;
    const ryMax = shapeParams.minor / 2 - toolRadius;
    if (rxMax <= 0 || ryMax <= 0) return [];
    const SEGMENTS = segmentsForCircleRadius(Math.max(rxMax, ryMax));
    // gebruik een factor op basis van minimale straal
    const minR = Math.min(rxMax, ryMax);
    for (let d = toolRadius; d <= minR + 1e-6; d += stepover) {
      const scale = d / minR;
      const rx = rxMax * scale;
      const ry = ryMax * scale;
      const pts = [];
      for (let i = 0; i <= SEGMENTS; i++) {
        const t = (i / SEGMENTS) * 2 * Math.PI;
        pts.push({ x: rx * Math.cos(t), y: ry * Math.sin(t), z: 0 });
      }
      rings.push(pts);
    }
  } else if (shape === ShapeType.SQUARE || shape === ShapeType.RECTANGLE) {
    const hw =
      (shape === ShapeType.SQUARE
        ? shapeParams.size
        : shapeParams.width) /
        2 -
      toolRadius;
    const hh =
      (shape === ShapeType.SQUARE
        ? shapeParams.size
        : shapeParams.height) /
        2 -
      toolRadius;
    if (hw <= 0 || hh <= 0) return [];

    const maxOffset = Math.min(hw, hh);
    for (let off = 0; off <= maxOffset + 1e-6; off += stepover) {
      const w = hw - off;
      const h = hh - off;
      if (w <= 0 || h <= 0) break;
      const pts = [];
      pts.push({ x: -w, y: -h, z: 0 });
      pts.push({ x: w, y: -h, z: 0 });
      pts.push({ x: w, y: h, z: 0 });
      pts.push({ x: -w, y: h, z: 0 });
      pts.push({ x: -w, y: -h, z: 0 });
      rings.push(pts);
    }
  }

  return rings;
}

/**
 * Spiraal-pocket voor cirkel: start- en eindcirkel + spiraal ertussen.
 * De buitenste ring ligt op (pocketgrens − toolRadius) zodat de snijkant van de frees
 * precies op de opgegeven diameter komt; de pocket wordt dus niet te groot.
 * Ondersteunt ook pockets kleiner dan 2× freesdiameter (bv. 10mm pocket, 6mm frees).
 */
function generateSpiralPocketCircle(shapeParams, stepover, toolRadius) {
  const pocketBoundaryRadius = shapeParams.diameter / 2; // gewenste rand van de pocket (snijkant)
  const outerRingRadius = pocketBoundaryRadius - toolRadius; // toolcenter op rand: snijkant = boundary
  if (outerRingRadius <= 0) return [];

  const segments = segmentsForCircleRadius(pocketBoundaryRadius);

  // Pocket kleiner dan 2× frees (bv. 10mm pocket, 6mm frees): alleen randcirkel. Start in het
  // midden; spiraal naar de rand (geen rechte lijn) zodat er geen haakse hoek op de rand is.
  if (outerRingRadius < toolRadius) {
    const pts = [];
    pts.push({ x: 0, y: 0, z: 0 }); // start in midden: lead-in blijft in het centrum
    // Spiraal van midden naar rand (één winding)
    const spiralSegments = segments;
    for (let i = 1; i <= spiralSegments; i++) {
      const t = i / spiralSegments;
      const angle = t * 2 * Math.PI;
      const r = t * outerRingRadius;
      pts.push({ x: r * Math.cos(angle), y: r * Math.sin(angle), z: 0 });
    }
    // Randcirkel: start bij hoek 2π (waar spiraal eindigt) voor vloeiende aansluiting, geen haakse hoek
    for (let i = 1; i <= segments; i++) {
      const angle = 2 * Math.PI + (i / segments) * 2 * Math.PI;
      pts.push({ x: outerRingRadius * Math.cos(angle), y: outerRingRadius * Math.sin(angle), z: 0 });
    }
    return pts;
  }

  const innerR = toolRadius;
  const outerR = outerRingRadius;
  const radialSpan = outerR - innerR;
  if (radialSpan <= 1e-9) {
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * 2 * Math.PI;
      pts.push({ x: outerRingRadius * Math.cos(angle), y: outerRingRadius * Math.sin(angle), z: 0 });
    }
    return pts;
  }

  const pts = [];

  // Start: volledige cirkel op binnenstraal (toolRadius)
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * 2 * Math.PI;
    pts.push({ x: innerR * Math.cos(angle), y: innerR * Math.sin(angle), z: 0 });
  }

  // Midden: spiraal van innerR naar outerR (naar pocketgrens)
  const turns = Math.max(1, Math.ceil(radialSpan / stepover));
  const totalAngle = turns * 2 * Math.PI;
  const steps = Math.max(segments * turns, 1);
  for (let i = 1; i <= steps; i++) {
    const angle = (i / steps) * totalAngle;
    const r = innerR + (radialSpan * i) / steps;
    pts.push({ x: r * Math.cos(angle), y: r * Math.sin(angle), z: 0 });
  }

  // Eind: volledige cirkel op buitenstraal (pocketgrens, offset voor freesdikte)
  const endAngleStart = totalAngle;
  for (let i = 1; i <= segments; i++) {
    const angle = endAngleStart + (i / segments) * 2 * Math.PI;
    pts.push({ x: outerR * Math.cos(angle), y: outerR * Math.sin(angle), z: 0 });
  }

  return pts;
}

/**
 * Spiraal-pocket voor ellips: start- en eindellips + spiraal.
 * Buitenellips op (halve as − toolRadius) zodat de snijkant op de opgegeven grens ligt.
 * Bij zeer kleine ellips (kleiner dan 2× frees): alleen één ellips op de grens.
 */
function generateSpiralPocketEllipse(shapeParams, stepover, toolRadius) {
  const rxMax = shapeParams.major / 2 - toolRadius;   // toolcenter: snijkant op major/2
  const ryMax = shapeParams.minor / 2 - toolRadius;  // toolcenter: snijkant op minor/2
  if (rxMax <= 0 || ryMax <= 0) return [];

  const segments = segmentsForCircleRadius(Math.max(rxMax, ryMax));
  const minR = Math.min(rxMax, ryMax);
  const rMin = minR > 0 ? toolRadius / minR : 0;
  const radialSpan = 1 - rMin;

  if (radialSpan <= 1e-9) {
    // Pocket kleiner dan ~2× frees: alleen randellips
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * 2 * Math.PI;
      pts.push({
        x: rxMax * Math.cos(angle),
        y: ryMax * Math.sin(angle),
        z: 0,
      });
    }
    return pts;
  }

  const pts = [];

  // Start: volledige ellips op binnenstraal (r = rMin)
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * 2 * Math.PI;
    pts.push({
      x: rMin * rxMax * Math.cos(angle),
      y: rMin * ryMax * Math.sin(angle),
      z: 0,
    });
  }

  // Midden: spiraal van rMin naar 1
  const turns = Math.max(1, Math.ceil((radialSpan * minR) / stepover));
  const totalAngle = turns * 2 * Math.PI;
  const steps = Math.max(segments * turns, 1);
  for (let i = 1; i <= steps; i++) {
    const angle = (i / steps) * totalAngle;
    const r = rMin + (radialSpan * i) / steps;
    pts.push({
      x: r * rxMax * Math.cos(angle),
      y: r * ryMax * Math.sin(angle),
      z: 0,
    });
  }

  // Eind: volledige ellips op buitenstraal (r = 1)
  const endAngleStart = totalAngle;
  for (let i = 1; i <= segments; i++) {
    const angle = endAngleStart + (i / segments) * 2 * Math.PI;
    pts.push({
      x: rxMax * Math.cos(angle),
      y: ryMax * Math.sin(angle),
      z: 0,
    });
  }

  return pts;
}

/**
 * Spiraal-pocket voor vierkant/rechthoek: spiraal blijft exact dezelfde (buiten → binnen).
 * G-code start in het midden (rode pijl) en volgt hetzelfde pad in omgekeerde richting (naar buiten).
 */
function generateSpiralPocketRectangle(shape, shapeParams, stepover, toolRadius) {
  const hw =
    (shape === ShapeType.SQUARE ? shapeParams.size : shapeParams.width) / 2 - toolRadius;
  const hh =
    (shape === ShapeType.SQUARE ? shapeParams.size : shapeParams.height) / 2 - toolRadius;
  if (hw <= 0 || hh <= 0) return [];

  const path = [];
  path.push({ x: 0, y: 0, z: 0 });
  path.push({ x: -hw, y: -hh, z: 0 });

  let L = -hw;
  let R = hw;
  let B = -hh;
  let T = hh;

  while (L < R - 1e-9 && B < T - 1e-9) {
    path.push({ x: R, y: B, z: 0 });
    path.push({ x: R, y: T, z: 0 });
    path.push({ x: L, y: T, z: 0 });
    const hasNextWinding = L + stepover < R - 1e-9 && B + stepover < T - 1e-9;
    if (hasNextWinding) {
      path.push({ x: L, y: B + stepover, z: 0 });
      path.push({ x: L + stepover, y: B + stepover, z: 0 });
    }
    L += stepover;
    R -= stepover;
    B += stepover;
    T -= stepover;
  }

  // Zelfde spiraal, maar start aan begin van spiraal (innermost): pad omkeren, plunge daar (geen lijn van midden)
  const spiralPts = path.slice(2);
  spiralPts.reverse();

  // Spiraal afsluiten: eindigt op (hw,-hh). Eerst onderkant dicht naar (-hw,-hh), dan lijntje omhoog naar (-hw,hh)
  spiralPts.push({ x: -hw, y: -hh, z: 0 });
  spiralPts.push({ x: -hw, y: hh, z: 0 });

  return spiralPts;
}

/**
 * Facing-paden: parallelle strips (rechthoekig gebied vlakfrezen).
 * @param {string} shape - ShapeType.SQUARE of RECTANGLE
 * @param {{ size?: number, width?: number, height?: number }} shapeParams
 * @param {number} stepover
 * @param {number} toolRadius
 * @param {string} facingMode - "within" (tool binnen gebied) of "full" (helemaal bereiken)
 * @returns {{x:number,y:number,z:number}[][]}
 */
function generateFacingPaths(shape, shapeParams, stepover, toolRadius, facingMode) {
  const hw = (shape === ShapeType.SQUARE ? shapeParams.size : shapeParams.width) / 2;
  const hh = (shape === ShapeType.SQUARE ? shapeParams.size : shapeParams.height) / 2;
  const isWithin = String(facingMode).toLowerCase().trim() === "within";
  const hwEff = isWithin ? hw - toolRadius : hw;
  const hhEff = isWithin ? hh - toolRadius : hh;
  if (hwEff <= 0 || hhEff <= 0) return [];

  /** @type {{x:number,y:number,z:number}[][]} */
  const paths = [];
  let y = -hhEff;
  let reverse = false;
  while (y <= hhEff + 1e-9) {
    const strip = reverse
      ? [
          { x: hwEff, y, z: 0 },
          { x: -hwEff, y, z: 0 },
        ]
      : [
          { x: -hwEff, y, z: 0 },
          { x: hwEff, y, z: 0 },
        ];
    paths.push(strip);
    reverse = !reverse;
    y += stepover;
  }
  return paths;
}

/**
 * Tab-configuratie langs een gesloten polyline berekenen.
 * Tabs worden om de X mm op de contour geplaatst, met gegeven breedte.
 * @param {{x:number,y:number,z:number}[]} path
 * @param {number} interval
 * @param {number} width
 * @param {number} totalDepth
 * @param {number} tabHeight
 */
function buildTabConfig(path, interval, width, totalDepth, tabHeight) {
  if (!path || path.length < 2 || interval <= 0 || width <= 0 || tabHeight <= 0) {
    return null;
  }

  const cumDist = [0];
  let totalLen = 0;
  for (let i = 1; i < path.length; i++) {
    const d = distance2D(path[i - 1], path[i]);
    totalLen += d;
    cumDist.push(totalLen);
  }
  if (totalLen <= 0) return null;

  const closingLen = path.length >= 2 ? distance2D(path[path.length - 1], path[0]) : 0;
  const totalLengthClosed = totalLen + closingLen;

  /** @type {{start:number,end:number}[]} */
  const ranges = [];
  const halfWidth = width / 2;
  // Tabs gelijkmatig over gesloten contour verdelen
  const n = Math.max(1, Math.round(totalLengthClosed / interval));
  const spacing = totalLengthClosed / n;
  for (let i = 0; i < n; i++) {
    const center = (i + 0.5) * spacing;
    const start = Math.max(0, center - halfWidth);
    const end = Math.min(totalLengthClosed, center + halfWidth);
    if (end > start) ranges.push({ start, end });
  }
  if (!ranges.length) return null;

  // Tab-top t.o.v. totale diepte: er blijft 'tabHeight' materiaal staan
  const cutDepthForTabs = Math.max(0, totalDepth - tabHeight);
  const tabZ = -cutDepthForTabs; // negatief, minder diep dan volledige diepte

  return {
    enabled: true,
    ranges,
    totalLength: totalLen,
    totalLengthClosed,
    cumulative: cumDist,
    tabZ,
    tabWidth: width,
  };
}

/**
 * Berekent Z voor een punt op het pad bij tabs: 25% van tabbreedte ramp omhoog, 50% vlak, 25% ramp omlaag.
 * @param {number} s - cumulatieve afstand langs het pad (mm), binnen [0, totalLengthClosed]
 * @param {number} depthZ - volledige snijdiepte (negatief)
 * @param {{enabled:boolean,ranges:{start:number,end:number}[],tabZ:number,tabWidth:number}|null} tabConfig
 * @returns {number} z-waarde voor dit punt
 */
function getZForTabProfile(s, depthZ, tabConfig) {
  if (!tabConfig || !tabConfig.enabled || depthZ >= tabConfig.tabZ + 1e-6) return depthZ;
  const rampLenMm = 0.25 * (tabConfig.tabWidth || 0);
  if (rampLenMm <= 1e-9) return depthZ;
  for (const r of tabConfig.ranges) {
    if (s < r.start || s > r.end) continue;
    const rangeLen = r.end - r.start;
    const rampLen = Math.min(rampLenMm, rangeLen / 2);
    if (rampLen <= 1e-9) return tabConfig.tabZ;
    const rampUpEnd = r.start + rampLen;
    const rampDownStart = r.end - rampLen;
    if (s <= rampUpEnd) {
      const t = (s - r.start) / rampLen;
      return depthZ + t * (tabConfig.tabZ - depthZ);
    }
    if (s >= rampDownStart) {
      const t = (s - rampDownStart) / rampLen;
      return tabConfig.tabZ + t * (depthZ - tabConfig.tabZ);
    }
    return tabConfig.tabZ;
  }
  return depthZ;
}

/**
 * Geeft alle s-waarden voor een segment (tab-grenzen) zodat 50% vlak echt vlak is en ramps gelijke hoek hebben.
 * @param {number} sStart
 * @param {number} sEnd
 * @param {{enabled:boolean,ranges:{start:number,end:number}[],tabWidth:number}|null} tabConfig
 * @returns {number[]} gesorteerde s-waarden in [sStart, sEnd]
 */
function getTabBoundarySInSegment(sStart, sEnd, tabConfig) {
  const out = [sStart, sEnd];
  if (!tabConfig || !tabConfig.enabled || !tabConfig.ranges.length) return out;
  const rampLenMm = 0.25 * (tabConfig.tabWidth || 0);
  if (rampLenMm <= 1e-9) return out;
  const eps = 1e-9;
  for (const r of tabConfig.ranges) {
    const rangeLen = r.end - r.start;
    const rampLen = Math.min(rampLenMm, rangeLen / 2);
    if (rampLen <= 1e-9) continue;
    const rampUpEnd = r.start + rampLen;
    const rampDownStart = r.end - rampLen;
    for (const bound of [r.start, rampUpEnd, rampDownStart, r.end]) {
      if (bound > sStart + eps && bound < sEnd - eps) out.push(bound);
    }
  }
  out.sort((a, b) => a - b);
  const deduped = [out[0]];
  for (let i = 1; i < out.length; i++) {
    if (out[i] - deduped[deduped.length - 1] > eps) deduped.push(out[i]);
  }
  return deduped;
}

/**
 * Toolpath genereren met lagen, insteek en origin-correctie.
 * @returns {Toolpath}
 */
function generateToolpath(params) {
  const { shape, operation, shapeParams, cutParams, originParams, plungeOutside, contourType, tabs, facingMode } =
    params;
  const toolRadius = cutParams.toolDiameter / 2;
  const minSizeForShape = getShapeMinSize(shape, shapeParams);
  const epsSize = 1e-6;
  const equalToToolDiameter =
    Number.isFinite(minSizeForShape) &&
    Math.abs(minSizeForShape - cutParams.toolDiameter) <= epsSize;

  /** @type {ToolpathMove[]} */
  const moves = [];

  const depths = computeDepthLevels(cutParams.totalDepth, cutParams.stepdown);

  // Lettergravering: outline (omtrek) of pocket (binnenkant uitfrezen)
  if (shape === ShapeType.LETTERS) {
    const font = params.letterFont;
    if (!font) return { moves: [] };
    const letterMode = params.letterMode || "outline";
    let letterPaths = getLetterPathsFromFont(
      shapeParams.text,
      shapeParams.fontSize,
      originParams.xyOrigin,
      font
    );
    const orientationDeg = Number(shapeParams.letterOrientation) || 0;
    if (orientationDeg !== 0) {
      letterPaths = rotatePathsAroundOrigin(letterPaths, orientationDeg);
    }
    const entryMethod = cutParams.entryMethod;
    const safeZ = cutParams.safeHeight;

    if (letterMode === "pocket") {
      // Pocket = start met contour op freesstraal naar binnen (rand waar toolcentrum mag), dan vullen met ringen.
      const getPts = (path) => {
        if (!path.length) return path;
        const last = path[path.length - 1];
        const first = path[0];
        if (Math.abs(last.x - first.x) < 1e-9 && Math.abs(last.y - first.y) < 1e-9) return path.slice(0, path.length - 1);
        return path;
      };
      const contourIsHole = (path) => polygonSignedArea2(getPts(path)) < 0;
      const minSize = 1.2 * cutParams.toolDiameter;

      /** @type {{ innerBoundary: { x: number, y: number, z: number }[] }[]} */
      const pocketable = [];
      let lastFailReason = "";
      for (let i = 0; i < letterPaths.length; i++) {
        const path = letterPaths[i];
        const pts = getPts(path);
        if (pts.length < 3 || contourMinSize(pts) < minSize) continue;
        const isHole = contourIsHole(path);
        const offset = isHole ? -toolRadius : toolRadius;
        const debug = {};
        let inner = contourOffset(path, offset, debug);
        if (!inner && Math.abs(offset) > 1e-6) inner = contourOffset(path, offset * 0.98, debug);
        if (inner && inner.length >= 3) pocketable.push({ innerBoundary: inner });
        else if (debug.failReason) lastFailReason = debug.failReason;
      }
      if (pocketable.length === 0) {
        throw new Error(
          t("error.lettersToolTooBig") + (lastFailReason ? " " + lastFailReason : "")
        );
      }

      depths.forEach((depthZ) => {
        pocketable.forEach(({ innerBoundary }, idxContour) => {
          const rings = pocketRingsFromInnerContour(innerBoundary, cutParams.stepover);
          if (!rings.length) return;
          const fromInsideOut = rings.slice().reverse();
          if (idxContour > 0) {
            const last = moves[moves.length - 1];
            if (last && last.z < safeZ - 1e-6) moves.push({ x: last.x, y: last.y, z: safeZ, type: "rapid" });
          }
          fromInsideOut.forEach((ring, ringIdx) => {
            addLayerForPath(moves, ring, depthZ, cutParams, plungeOutside && idxContour === 0 && ringIdx === 0, entryMethod, true, safeZ, undefined, true, true, toolRadius);
            const last = moves[moves.length - 1];
            if (last && last.z < safeZ - 1e-6) moves.push({ x: last.x, y: last.y, z: safeZ, type: "rapid" });
          });
        });
      });
    } else {
      // Outline: omtrek van elke letter volgen
      depths.forEach((depthZ) => {
        letterPaths.forEach((path, idx) => {
          if (idx > 0) {
            const last = moves[moves.length - 1];
            if (last && last.z < safeZ - 1e-6) {
              moves.push({ x: last.x, y: last.y, z: safeZ, type: "rapid" });
            }
          }
          addLayerForPath(
            moves,
            path,
            depthZ,
            cutParams,
            plungeOutside && idx === 0,
            entryMethod,
            true,
            safeZ,
            undefined,
            false,
            false,
            0
          );
        });
      });
    }

    if (moves.length > 0) {
      const last = moves[moves.length - 1];
      if (last.z < safeZ - 1e-6) {
        moves.push({ x: last.x, y: last.y, z: safeZ, type: "rapid" });
      }
    }
    applyOriginTransform(
      moves,
      originParams,
      cutParams.totalDepth,
      0,
      OperationType.POCKET,
      "inside"
    );
    return { moves };
  }

  // Bout met verzonken kop: eerst verzinking (kop-gat), dan boutgat
  if (shape === ShapeType.COUNTERSUNK_BOLT) {
    const headDiameter = shapeParams.headDiameter;
    const countersinkDepth = shapeParams.countersinkDepth;
    const boltDiameter = shapeParams.boltDiameter;
    const boltHoleDepth = shapeParams.boltHoleDepth;
    const safeZ = cutParams.safeHeight;
    const entryMethod = cutParams.entryMethod;
    const toolRadiusPocket = cutParams.toolDiameter / 2;

    const depthsCountersink = computeDepthLevels(countersinkDepth, cutParams.stepdown);
    const headPath = generateSpiralPocketCircle(
      { diameter: headDiameter },
      cutParams.stepover,
      toolRadiusPocket
    );
    const maxHelixRadiusHead = Math.max(0, headDiameter / 2 - toolRadiusPocket);

    depthsCountersink.forEach((depthZ, depthIndex) => {
      addLayerForPath(
        moves,
        headPath,
        depthZ,
        cutParams,
        false,
        entryMethod,
        depthIndex === 0,
        safeZ,
        undefined,
        false,
        true,
        toolRadiusPocket,
        true,
        maxHelixRadiusHead,
        0,
        0
      );
    });

    // Naar midden (0,0) op bodem verzinking
    if (moves.length > 0) {
      const last = moves[moves.length - 1];
      if (Math.abs(last.x) > 1e-9 || Math.abs(last.y) > 1e-9 || Math.abs(last.z + countersinkDepth) > 1e-9) {
        moves.push({ x: 0, y: 0, z: -countersinkDepth, type: "cut" });
      }
    }

    const depthsBolt = computeDepthLevels(boltHoleDepth, cutParams.stepdown);
    const boltPath = generateSpiralPocketCircle(
      { diameter: boltDiameter },
      cutParams.stepover,
      toolRadiusPocket
    );
    const maxHelixRadiusBolt = Math.max(0, boltDiameter / 2 - toolRadiusPocket);
    const useRampForBolt = entryMethod === EntryMethod.RAMP && maxHelixRadiusBolt > 1e-6;

    depthsBolt.forEach((depthZRel, depthIndex) => {
      const depthZ = -countersinkDepth + depthZRel;
      if (depthIndex === 0 && useRampForBolt && boltPath.length > 1) {
        // Eerste boutlaag met ramp: helix start op hoogte verzonken gat (-countersinkDepth), niet bovenaan
        const R = Math.max(1e-6, Math.min(toolRadiusPocket, maxHelixRadiusBolt));
        const cx = 0;
        const cy = 0;
        const helixStartX = cx + R;
        const helixStartY = cy;
        const zStart = -countersinkDepth; // start helix op bodem verzinking
        const targetZ = depthZ;
        const start = { x: boltPath[0].x, y: boltPath[0].y };
        const rampAngleRad = degToRad(cutParams.rampAngleMax || 3);
        const maxDepth = Math.abs(targetZ - zStart);
        // Van (0,0,zStart) naar helix-start op dezelfde Z, dan helix omlaag
        moves.push({ x: helixStartX, y: helixStartY, z: zStart, type: "cut" });
        const maxAnglePerMove = degToRad(8);
        const twoPi = 2 * Math.PI;
        const targetAngleNorm = (Math.atan2(start.y - cy, start.x - cx) + twoPi) % twoPi;
        let angle = 0;
        let currentZ = zStart;
        while (currentZ > targetZ - 1e-6) {
          const remainingZ = currentZ - targetZ;
          const segmentDeltaZ = Math.abs(remainingZ) > maxDepth ? -maxDepth : -Math.abs(remainingZ);
          const segmentZ = currentZ + segmentDeltaZ;
          const angleNorm = ((angle % twoPi) + twoPi) % twoPi;
          let angleToTarget = (targetAngleNorm - angleNorm + twoPi) % twoPi;
          if (angleToTarget < 1e-6) angleToTarget = twoPi;
          const isLastSegment = segmentZ <= targetZ + 1e-6;
          let deltaAngleTotal;
          if (isLastSegment) {
            const minAngleForRamp = R > 1e-6 && rampAngleRad > 0 ? Math.abs(targetZ - currentZ) / (R * Math.tan(rampAngleRad)) : 0;
            deltaAngleTotal = angleToTarget + twoPi * Math.ceil(Math.max(0, minAngleForRamp - angleToTarget) / twoPi);
          } else {
            let arcLength = rampAngleRad > 0 ? Math.abs(segmentDeltaZ) / Math.tan(rampAngleRad) : 0;
            if (!isFinite(arcLength) || arcLength <= 0) arcLength = 0;
            deltaAngleTotal = R > 1e-6 ? arcLength / R : 0;
          }
          const numSteps = Math.max(1, Math.ceil(deltaAngleTotal / maxAnglePerMove));
          const deltaAngle = deltaAngleTotal / numSteps;
          const deltaZTotal = isLastSegment ? targetZ - currentZ : segmentDeltaZ;
          const deltaZPerStep = deltaZTotal / numSteps;
          for (let step = 0; step < numSteps; step++) {
            angle += deltaAngle;
            const z = currentZ + deltaZPerStep * (step + 1);
            moves.push({ x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle), z, type: "cut" });
          }
          currentZ = isLastSegment ? targetZ : segmentZ;
          if (currentZ <= targetZ + 1e-6) break;
        }
        if (distance2D({ x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) }, start) > 1e-6) {
          moves.push({ x: start.x, y: start.y, z: depthZ, type: "cut" });
        }
        for (let i = 1; i < boltPath.length; i++) {
          moves.push({ x: boltPath[i].x, y: boltPath[i].y, z: depthZ, type: "cut" });
        }
      } else {
        addLayerForPath(
          moves,
          boltPath,
          depthZ,
          cutParams,
          false,
          entryMethod,
          true,
          safeZ,
          undefined,
          false,
          true,
          toolRadiusPocket,
          true,
          maxHelixRadiusBolt,
          0,
          0
        );
      }
    });

    if (moves.length > 0) {
      const last = moves[moves.length - 1];
      if (last.z < safeZ - 1e-6) {
        moves.push({ x: last.x, y: last.y, z: safeZ, type: "rapid" });
      }
    }

    applyOriginTransform(
      moves,
      originParams,
      countersinkDepth + boltHoleDepth,
      0,
      OperationType.POCKET,
      "inside"
    );
    return { moves };
  }

  // Voor contour: pad met halve freesdiameter offset (binnen- of buitencontour),
  // behalve in het speciale geval "binnencontour exact freesdiameter".
  let contourPath =
    operation === OperationType.CONTOUR
      ? generateContourPathWithOffset(
          shape,
          shapeParams,
          toolRadius,
          contourType === "inside"
        )
      : generateBasePath(shape, shapeParams, operation);

  // Speciaal geval: binnencontour exact freesdiameter
  if (
    operation === OperationType.CONTOUR &&
    contourType === "inside" &&
    equalToToolDiameter
  ) {
    if (
      shape === ShapeType.CIRCLE ||
      shape === ShapeType.ELLIPSE ||
      shape === ShapeType.SQUARE
    ) {
      // Cirkels, ellipsen én vierkanten: enkel boorgat in het midden
      contourPath = [{ x: 0, y: 0, z: 0 }];
    } else if (shape === ShapeType.RECTANGLE) {
      const w = shapeParams.width;
      const h = shapeParams.height;
      if (Math.abs(w - cutParams.toolDiameter) <= epsSize && Math.abs(h - cutParams.toolDiameter) <= epsSize) {
        contourPath = [{ x: 0, y: 0, z: 0 }];
      } else if (Math.abs(w - cutParams.toolDiameter) <= epsSize) {
        // Breedte = diameter → verticale lijn (langs hoogte)
        const halfLine = Math.max(h / 2 - toolRadius, 0);
        contourPath = [
          { x: 0, y: -halfLine, z: 0 },
          { x: 0, y: halfLine, z: 0 },
        ];
      } else {
        // Hoogte = diameter → horizontale lijn (langs breedte)
        const halfLine = Math.max(w / 2 - toolRadius, 0);
        contourPath = [
          { x: -halfLine, y: 0, z: 0 },
          { x: halfLine, y: 0, z: 0 },
        ];
      }
    }
  }

  // Voor vierkant/rechthoek: startpunt van contourpad verplaatsen naar midden van een zijde
  if (
    operation === OperationType.CONTOUR &&
    contourPath &&
    contourPath.length >= 4 &&
    (shape === ShapeType.SQUARE || shape === ShapeType.RECTANGLE)
  ) {
    contourPath = adjustRectContourStartToEdgeMid(contourPath);
  }

  // Tabs voorbereiden (alleen contour)
  let tabConfig = null;
  if (operation === OperationType.CONTOUR && tabs && tabs.enabled) {
    tabConfig = buildTabConfig(
      contourPath,
      tabs.interval,
      tabs.width,
      cutParams.totalDepth,
      tabs.height
    );
  }

  // Voor facing: parallelle strips (alleen vierkant/rechthoek)
  /** @type {{x:number,y:number,z:number}[][]} */
  let facingPaths = [];
  if (shape === ShapeType.FACING || (operation === OperationType.FACING && (shape === ShapeType.SQUARE || shape === ShapeType.RECTANGLE))) {
    const mode = (params.facingMode && String(params.facingMode).toLowerCase().trim() === "within") ? "within" : "full";
    const useShape = shape === ShapeType.FACING ? ShapeType.RECTANGLE : shape;
    const useParams = shapeParams;
    facingPaths = generateFacingPaths(
      useShape,
      useParams,
      cutParams.stepover,
      toolRadius,
      mode
    );
  }

  // Voor pocket: één spiraalpad per vorm (stepover, volledige dekking)
  /** @type {{x:number,y:number,z:number}[][]} */
  let pocketPaths = [];
  if (operation === OperationType.POCKET) {
    if (equalToToolDiameter) {
      // Speciaal geval: pocket precies freesdiameter
      if (shape === ShapeType.PATTERNED_HOLES) {
        const countX = Math.max(1, shapeParams.countX || 1);
        const countY = Math.max(1, shapeParams.countY || 1);
        const spacingX = shapeParams.spacingX || 96;
        const spacingY = shapeParams.spacingY || 96;
        pocketPaths = [];
        for (let j = 0; j < countY; j++) {
          for (let i = 0; i < countX; i++) {
            const cx = i * spacingX;
            const cy = j * spacingY;
            pocketPaths.push([{ x: cx, y: cy, z: 0 }]);
          }
        }
      } else if (
        shape === ShapeType.CIRCLE ||
        shape === ShapeType.ELLIPSE ||
        shape === ShapeType.SQUARE
      ) {
        // Cirkels, ellipsen én vierkanten: enkel "boor"-pad op het midden.
        pocketPaths = [[{ x: 0, y: 0, z: 0 }]];
      } else if (shape === ShapeType.RECTANGLE) {
        const w = shapeParams.width;
        const h = shapeParams.height;
        if (Math.abs(w - cutParams.toolDiameter) <= epsSize && Math.abs(h - cutParams.toolDiameter) <= epsSize) {
          pocketPaths = [[{ x: 0, y: 0, z: 0 }]];
        } else if (Math.abs(w - cutParams.toolDiameter) <= epsSize) {
          const halfLine = Math.max(h / 2 - toolRadius, 0);
          pocketPaths = [[
            { x: 0, y: -halfLine, z: 0 },
            { x: 0, y: halfLine, z: 0 },
          ]];
        } else {
          const halfLine = Math.max(w / 2 - toolRadius, 0);
          pocketPaths = [[
            { x: -halfLine, y: 0, z: 0 },
            { x: halfLine, y: 0, z: 0 },
          ]];
        }
      }
    } else {
      if (shape === ShapeType.CIRCLE) {
        pocketPaths = [generateSpiralPocketCircle(shapeParams, cutParams.stepover, toolRadius)];
      } else if (shape === ShapeType.ELLIPSE) {
        pocketPaths = [generateSpiralPocketEllipse(shapeParams, cutParams.stepover, toolRadius)];
      } else if (shape === ShapeType.SQUARE || shape === ShapeType.RECTANGLE) {
        pocketPaths = [generateSpiralPocketRectangle(shape, shapeParams, cutParams.stepover, toolRadius)];
      } else if (shape === ShapeType.PATTERNED_HOLES) {
        const countX = Math.max(1, shapeParams.countX || 1);
        const countY = Math.max(1, shapeParams.countY || 1);
        const spacingX = shapeParams.spacingX || 96;
        const spacingY = shapeParams.spacingY || 96;
        const holeShapeParams = { diameter: shapeParams.diameter };
        const singlePath = generateSpiralPocketCircle(holeShapeParams, cutParams.stepover, toolRadius);
        pocketPaths = [];
        for (let j = 0; j < countY; j++) {
          for (let i = 0; i < countX; i++) {
            const cx = i * spacingX;
            const cy = j * spacingY;
            const translatedPath = singlePath.map((p) => ({ x: p.x + cx, y: p.y + cy, z: p.z }));
            pocketPaths.push(translatedPath);
          }
        }
      }
    }
  }

  /** @type {{x:number,y:number}[]} - per pocket het midden (alleen bij patterned holes) */
  let pocketCenters = [];
  if (shape === ShapeType.PATTERNED_HOLES && operation === OperationType.POCKET) {
    const countX = Math.max(1, shapeParams.countX || 1);
    const countY = Math.max(1, shapeParams.countY || 1);
    const spacingX = shapeParams.spacingX || 96;
    const spacingY = shapeParams.spacingY || 96;
    for (let j = 0; j < countY; j++) {
      for (let i = 0; i < countX; i++) {
        pocketCenters.push({ x: i * spacingX, y: j * spacingY });
      }
    }
  }

  const entryMethod = cutParams.entryMethod;
  const safeZ = cutParams.safeHeight;

  depths.forEach((depthZ, depthIndex) => {
    if (operation === OperationType.CONTOUR) {
      if (contourPath.length < 2) return; // te kleine vorm na offset
      const isLastLayer = depthIndex === depths.length - 1;
      addLayerForPath(
        moves,
        contourPath,
        depthZ,
        cutParams,
        plungeOutside,
        entryMethod,
        true,
        safeZ,
        tabConfig,
        contourType === "inside",
        false,
        0,
        isLastLayer
      );
    } else if (operation === OperationType.FACING) {
      const toolRadiusFacing = cutParams.toolDiameter / 2;
      const isFacingShape = shape === ShapeType.FACING;
      const hw = (isFacingShape ? shapeParams.width : (shape === ShapeType.SQUARE ? shapeParams.size : shapeParams.width)) / 2 - toolRadiusFacing;
      const hh = (isFacingShape ? shapeParams.height : (shape === ShapeType.SQUARE ? shapeParams.size : shapeParams.height)) / 2 - toolRadiusFacing;
      const maxHelixRadiusFacing = Math.max(0, Math.min(hw, hh));
      facingPaths.forEach((path, idx) => {
        addLayerForPath(
          moves,
          path,
          depthZ,
          cutParams,
          false,
          entryMethod,
          idx === 0,
          safeZ,
          undefined,
          false,
          true,
          toolRadiusFacing,
          true,
          maxHelixRadiusFacing,
          0,
          0
        );
      });
    } else {
      // Pocket: één spiraalpad per laag (cirkel/ellips/rechthoek), stepover gerespecteerd
      const toolRadiusPocket = cutParams.toolDiameter / 2;
      let maxHelixRadiusPocket = undefined;
      if (shape === ShapeType.CIRCLE) {
        maxHelixRadiusPocket = Math.max(0, (shapeParams.diameter / 2) - toolRadiusPocket);
      } else if (shape === ShapeType.ELLIPSE) {
        const rx = (shapeParams.major || 0) / 2 - toolRadiusPocket;
        const ry = (shapeParams.minor || 0) / 2 - toolRadiusPocket;
        maxHelixRadiusPocket = Math.max(0, Math.min(rx, ry));
      } else if (shape === ShapeType.SQUARE || shape === ShapeType.RECTANGLE) {
        const hw = (shape === ShapeType.SQUARE ? shapeParams.size : shapeParams.width) / 2 - toolRadiusPocket;
        const hh = (shape === ShapeType.SQUARE ? shapeParams.size : shapeParams.height) / 2 - toolRadiusPocket;
        maxHelixRadiusPocket = Math.max(0, Math.min(hw, hh));
      } else if (shape === ShapeType.PATTERNED_HOLES) {
        maxHelixRadiusPocket = Math.max(0, (shapeParams.diameter / 2) - toolRadiusPocket);
      }
      pocketPaths.forEach((path, idx) => {
        const outside = plungeOutside && idx === 0;
        const center = shape === ShapeType.PATTERNED_HOLES && pocketCenters[idx] ? pocketCenters[idx] : { x: 0, y: 0 };
        addLayerForPath(
          moves,
          path,
          depthZ,
          cutParams,
          outside,
          entryMethod,
          idx === 0,
          safeZ,
          undefined,
          false,
          true,
          toolRadiusPocket,
          true,
          maxHelixRadiusPocket,
          center.x,
          center.y
        );
      });
      // Bij meerdere pockets (patterned holes): na elke dieptelaag retracten zodat de volgende laag
      // niet als "continuing from previous layer" een cut-lijn naar het eerste gat maakt
      if (shape === ShapeType.PATTERNED_HOLES && pocketPaths.length > 1 && depthIndex < depths.length - 1) {
        const last = moves[moves.length - 1];
        if (last && last.z < safeZ - 1e-6) {
          moves.push({ x: last.x, y: last.y, z: safeZ, type: "rapid" });
        }
      }
    }
  });

  // Aan het einde alleen terug naar veilige hoogte boven de laatste XY-positie,
  // niet terug naar de origin.
  if (moves.length > 0) {
    const last = moves[moves.length - 1];
    if (last.z < safeZ - 1e-6) {
      if (operation === OperationType.POCKET || operation === OperationType.FACING) {
        // Eerst een recht lijntje richting het midden (net van de rand af), dan retract — geen boog, geen sporen
        const cx = 0;
        const cy = 0;
        const dx = cx - last.x;
        const dy = cy - last.y;
        const dist = Math.hypot(dx, dy);
        const pullbackMm = 1.5;
        if (dist > 1e-6 && pullbackMm > 0) {
          const step = Math.min(pullbackMm, dist);
          const endX = last.x + (dx / dist) * step;
          const endY = last.y + (dy / dist) * step;
          moves.push({ x: endX, y: endY, z: last.z, type: "cut" });
          moves.push({ x: endX, y: endY, z: safeZ, type: "rapid" });
        } else {
          moves.push({ x: last.x, y: last.y, z: safeZ, type: "rapid" });
        }
      } else {
        moves.push({ x: last.x, y: last.y, z: safeZ, type: "rapid" });
      }
    }
  }

  // Origin-transformatie toepassen
  let facingBounds = null;
  if (shape === ShapeType.FACING || operation === OperationType.FACING) {
    const w = shape === ShapeType.FACING ? shapeParams.width : (shape === ShapeType.SQUARE ? shapeParams.size : shapeParams.width);
    const h = shape === ShapeType.FACING ? shapeParams.height : (shape === ShapeType.SQUARE ? shapeParams.size : shapeParams.height);
    if (Number.isFinite(w) && Number.isFinite(h)) {
      facingBounds = { hw: w / 2, hh: h / 2 };
    }
  }
  applyOriginTransform(
    moves,
    originParams,
    cutParams.totalDepth,
    toolRadius,
    operation,
    contourType,
    facingBounds
  );

  return { moves };
}

/**
 * Eén laag toevoegen voor een gegeven polyline-pad.
 * Insteek: plunge of ramp.
 * @param {ToolpathMove[]} moves
 * @param {{x:number,y:number,z:number}[]} path
 * @param {number} depthZ
 * @param {*} cutParams
 * @param {boolean} plungeOutside
 * @param {string} entryMethod
 * @param {boolean} isFirstPathAtDepth  // true = eerste pad op deze Z-laag
 * @param {number} safeZ  // veilige hoogte (mm) voor rapid moves
 * @param {{enabled:boolean,ranges:{start:number,end:number}[],totalLength:number,cumulative:number[],tabZ:number}|null} [tabConfig]
 * @param {boolean} [entryInsideForInsideContour] // bij binnencontour: insteken aan binnenzijde van de contour
 * @param {boolean} [useHelixRamp] // bij pocket: ramp als helix zodat we binnen de pocket blijven
 * @param {number} [toolRadius] // freesstraal (mm), nodig voor helix-straal
 * @param {boolean} [isLastLayer] // bij contour tussenlagen: false = alleen ramp, geen volledige contour; onderste laag wel
 * @param {number} [maxHelixRadius] // bij pocket: max. helixstraal (binnenkant vorm), zodat helix niet buiten pocket komt
 * @param {number} [helixCenterX] // bij pocket: X van midden (helix gecentreerd), anders entryStart
 * @param {number} [helixCenterY] // bij pocket: Y van midden
 */
function addLayerForPath(
  moves,
  path,
  depthZ,
  cutParams,
  plungeOutside,
  entryMethod,
  isFirstPathAtDepth,
  safeZ,
  tabConfig,
  entryInsideForInsideContour = false,
  useHelixRamp = false,
  toolRadius = 0,
  isLastLayer = true,
  maxHelixRadius = undefined,
  helixCenterX = undefined,
  helixCenterY = undefined
) {
  if (!path || path.length === 0) return;

  const start = { x: path[0].x, y: path[0].y };
  const leadInAbove = Math.max(0, cutParams.leadInAboveMm ?? 2);

  // Speciaal geval: enkel punt → boorgat / enkel pad in Z-richting.
  if (path.length === 1) {
    const last = moves[moves.length - 1];
    if (last && last.z < safeZ - 1e-6) {
      moves.push({ x: last.x, y: last.y, z: safeZ, type: "rapid" });
    }
    moves.push({ x: start.x, y: start.y, z: safeZ, type: "rapid" });
    if (safeZ > leadInAbove) {
      moves.push({ x: start.x, y: start.y, z: leadInAbove, type: "rapid" });
    }
    moves.push({ x: start.x, y: start.y, z: 0, type: "cut" });
    moves.push({ x: start.x, y: start.y, z: depthZ, type: "cut" });
    return;
  }

  // Niet het eerste pad op deze Z-laag: retract, rapid naar volgend gat, dan ramp of plunge naar depthZ
  if (!isFirstPathAtDepth) {
    const last = moves[moves.length - 1];
    // Retract naar veilige hoogte
    if (last && last.z < safeZ - 1e-6) {
      moves.push({ x: last.x, y: last.y, z: safeZ, type: "rapid" });
    }
    const cx = Number.isFinite(helixCenterX) ? helixCenterX : start.x;
    const cy = Number.isFinite(helixCenterY) ? helixCenterY : start.y;
    const useRampHere = entryMethod === EntryMethod.RAMP && useHelixRamp && toolRadius > 0 && Number.isFinite(helixCenterX) && Number.isFinite(helixCenterY);

    if (useRampHere) {
      // Helix-ramp naar dit gat (zelfde als eerste gat)
      const R = Math.max(1e-6, Math.min(toolRadius, Number.isFinite(maxHelixRadius) ? maxHelixRadius : toolRadius));
      const helixStartX = cx + R;
      const helixStartY = cy;
      const zStart = leadInAbove;
      const targetZ = depthZ;
      const maxDepth = Math.abs(targetZ - zStart);
      const rampAngleRad = degToRad(cutParams.rampAngleMax || 3);
      moves.push({ x: helixStartX, y: helixStartY, z: safeZ, type: "rapid" });
      if (safeZ > zStart) {
        moves.push({ x: helixStartX, y: helixStartY, z: zStart, type: "rapid" });
      }
      const maxAnglePerMove = degToRad(8);
      const twoPi = 2 * Math.PI;
      const targetAngleNorm = (Math.atan2(start.y - cy, start.x - cx) + twoPi) % twoPi;
      let angle = 0;
      let currentZ = zStart;
      while (currentZ > targetZ - 1e-6) {
        const remainingZ = currentZ - targetZ;
        const segmentDeltaZ = Math.abs(remainingZ) > maxDepth ? -maxDepth : -Math.abs(remainingZ);
        const segmentZ = currentZ + segmentDeltaZ;
        const angleNorm = ((angle % twoPi) + twoPi) % twoPi;
        let angleToTarget = (targetAngleNorm - angleNorm + twoPi) % twoPi;
        if (angleToTarget < 1e-6) angleToTarget = twoPi;
        const isLastSegment = segmentZ <= targetZ + 1e-6;
        let deltaAngleTotal;
        if (isLastSegment) {
          const minAngleForRamp = R > 1e-6 && rampAngleRad > 0 ? Math.abs(targetZ - currentZ) / (R * Math.tan(rampAngleRad)) : 0;
          deltaAngleTotal = angleToTarget + twoPi * Math.ceil(Math.max(0, minAngleForRamp - angleToTarget) / twoPi);
        } else {
          let arcLength = rampAngleRad > 0 ? Math.abs(segmentDeltaZ) / Math.tan(rampAngleRad) : 0;
          if (!isFinite(arcLength) || arcLength <= 0) arcLength = 0;
          deltaAngleTotal = R > 1e-6 ? arcLength / R : 0;
        }
        const numSteps = Math.max(1, Math.ceil(deltaAngleTotal / maxAnglePerMove));
        const deltaAngle = deltaAngleTotal / numSteps;
        const deltaZTotal = isLastSegment ? targetZ - currentZ : segmentDeltaZ;
        const deltaZPerStep = deltaZTotal / numSteps;
        for (let step = 0; step < numSteps; step++) {
          angle += deltaAngle;
          const z = currentZ + deltaZPerStep * (step + 1);
          const x = cx + R * Math.cos(angle);
          const y = cy + R * Math.sin(angle);
          moves.push({ x, y, z, type: "cut" });
        }
        currentZ = isLastSegment ? targetZ : segmentZ;
        if (currentZ <= targetZ + 1e-6) break;
      }
      const helixEndX = cx + R * Math.cos(((angle % twoPi) + twoPi) % twoPi);
      const helixEndY = cy + R * Math.sin(((angle % twoPi) + twoPi) % twoPi);
      if (distance2D({ x: helixEndX, y: helixEndY }, start) > 1e-6) {
        moves.push({ x: start.x, y: start.y, z: depthZ, type: "cut" });
      }
    } else {
      // Geen ramp: rapid naar start, verticale plunge
      moves.push({ x: start.x, y: start.y, z: safeZ, type: "rapid" });
      if (safeZ > leadInAbove) {
        moves.push({ x: start.x, y: start.y, z: leadInAbove, type: "rapid" });
      }
      moves.push({ x: start.x, y: start.y, z: depthZ, type: "cut" });
    }

    // Volledige ring op deze diepte aflopen
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      moves.push({ x: p.x, y: p.y, z: depthZ, type: "cut" });
    }
    return;
  }

  // Eerste pad op deze Z-laag: normale insteek (plunge of ramp)
  let entryStart = { ...start };

  if (plungeOutside) {
    // Buiten het part insteken, tenzij start in het midden (0,0) ligt (bv. kleine pocket):
    // dan in het midden insteken zodat lead-in de rand niet raakt.
    // Voor een BINNENcontour willen we echter "naast het onderdeel" aan de BINNENkant van de contour insteken.
    const atCenter = Math.abs(start.x) <= 1e-9 && Math.abs(start.y) <= 1e-9;
    if (!atCenter) {
      if (entryInsideForInsideContour) {
        // Binnencontour: offset richting het geometrische midden van het pad (naar binnen toe).
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < path.length; i++) {
          const p = path[i];
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        let vx = cx - start.x;
        let vy = cy - start.y;
        const len = Math.hypot(vx, vy);
        if (len > 1e-9) {
          vx /= len;
          vy /= len;
          const dist = cutParams.toolDiameter * 1.5;
          entryStart = {
            x: start.x + vx * dist,
            y: start.y + vy * dist,
          };
        } else {
          entryStart = { ...start };
        }
      } else {
        // Standaard (buitencontour / buiten het part):
        // insteken in de richting "naar buiten" t.o.v. het pad,
        // ongeveer radiaal vanaf het geometrische midden van de contour.
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < path.length; i++) {
          const p = path[i];
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        let vx = start.x - cx;
        let vy = start.y - cy;
        const len = Math.hypot(vx, vy);
        if (len > 1e-9) {
          vx /= len;
          vy /= len;
          const dist = cutParams.toolDiameter * 1.5;
          entryStart = {
            x: start.x + vx * dist,
            y: start.y + vy * dist,
          };
        } else {
          // fallback: kleine verschuiving in X/Y
          const dist = cutParams.toolDiameter * 1.5;
          entryStart = {
            x: start.x + dist,
            y: start.y,
          };
        }
      }
    }
  }

  // Helper: maak een gebogen lead-in (quadratische Bézier) van 'fromPoint'
  // naar 'start', die vloeiend (tangent) overloopt in de eerste lijn
  // van het pad (start -> nextPoint).
  function addCurvedLeadIn(fromPoint, startPoint, nextPoint, depth) {
    if (!nextPoint) {
      // Geen volgend punt bekend: val terug op rechte lijn.
      if (fromPoint.x !== startPoint.x || fromPoint.y !== startPoint.y) {
        moves.push({ x: startPoint.x, y: startPoint.y, z: depth, type: "cut" });
      }
      return;
    }

    const vx = nextPoint.x - startPoint.x;
    const vy = nextPoint.y - startPoint.y;
    const segLen = Math.hypot(vx, vy);
    if (segLen < 1e-9) {
      // Te kort om een nette curve te maken → rechte lijn.
      if (fromPoint.x !== startPoint.x || fromPoint.y !== startPoint.y) {
        moves.push({ x: startPoint.x, y: startPoint.y, z: depth, type: "cut" });
      }
      return;
    }

    // Eenvoudige boog via een quadratische Bézier:
    // B(0) = fromPoint, B(1) = startPoint.
    // Tangent bij B(1) evenwijdig aan (startPoint -> nextPoint).
    // Speciaal voor rechthoekige segmenten (horizontaal/verticaal)
    // kiezen we het control point zó dat:
    // - de tangent exact langs de zijde loopt
    // - de boog mooi "rond" is, zonder rare knikken.
    let cx;
    let cy;
    const eps = 1e-9;
    if (Math.abs(vx) < eps) {
      // Eerste segment is (nagenoeg) verticaal: tangent omhoog/omlaag.
      // Kies control point op dezelfde x als de zijde (start.x) en
      // verschuif in de richting van de tangent met een afstand die
      // ongeveer gelijk is aan de normale offset van de insteek.
      const dir = Math.sign(vy) || 1;
      const normalOffset = Math.abs(fromPoint.x - startPoint.x);
      const span = normalOffset || segLen * 0.5;
      cx = startPoint.x;
      cy = startPoint.y + dir * span;
    } else if (Math.abs(vy) < eps) {
      // Eerste segment is (nagenoeg) horizontaal: tangent links/rechts.
      // Analoge constructie, maar dan in X-richting.
      const dir = Math.sign(vx) || 1;
      const normalOffset = Math.abs(fromPoint.y - startPoint.y);
      const span = normalOffset || segLen * 0.5;
      cx = startPoint.x + dir * span;
      cy = startPoint.y;
    } else {
      // Algemene vorm (bijv. cirkel): control point op verlenging van
      // de eerste segmentvector achter het startpunt.
      const CURVE_FACTOR = 1.5;
      cx = startPoint.x - CURVE_FACTOR * vx;
      cy = startPoint.y - CURVE_FACTOR * vy;
    }

    const STEPS = 12;
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const omt = 1 - t;
      const bx =
        omt * omt * fromPoint.x +
        2 * omt * t * cx +
        t * t * startPoint.x;
      const by =
        omt * omt * fromPoint.y +
        2 * omt * t * cy +
        t * t * startPoint.y;
      moves.push({ x: bx, y: by, z: depth, type: "cut" });
    }
  }

  const rampAngleRad = degToRad(cutParams.rampAngleMax || 3);

  const last = moves[moves.length - 1];
  /** Volgende laag: ramp direct onder vorige eindpositie (geen retract naar boven); onderste laag sluit wel dicht. */
  const continuingFromPreviousLayer =
    last && last.z < -1e-6 && depthZ < last.z - 1e-6;

  if (!continuingFromPreviousLayer) {
    if (last && last.z < safeZ - 1e-6) {
      moves.push({ x: last.x, y: last.y, z: safeZ, type: "rapid" });
    }
    if (
      !(entryMethod === EntryMethod.RAMP && useHelixRamp && toolRadius > 0) &&
      !(entryMethod === EntryMethod.RAMP && plungeOutside)
    ) {
      moves.push({ x: entryStart.x, y: entryStart.y, z: safeZ, type: "rapid" });
    }
  }

  /** Pad niet nogmaals: bij RAMP op tussenlaag alleen ramp (geen contour); bij plunge altijd contour per laag.
   * Uitzondering: bij insteken buiten doen we wél de volledige contour op elke laag (meerdere rechthoeken). */
  let pathAlreadyAtDepth = false;
  /** Bij contour ramp + insteken buiten: na ramp+lead-in staan we al op path[0], dus die niet dubbel toevoegen. */
  let skipFirstPathPoint = false;
  if (entryMethod === EntryMethod.RAMP && !isLastLayer && !plungeOutside) {
    pathAlreadyAtDepth = true;
  }

  if (entryMethod === EntryMethod.RAMP) {
    const zStart = continuingFromPreviousLayer ? last.z : 0;
    const targetZ = depthZ;
    const maxDepth = Math.abs(targetZ - zStart);

    if (useHelixRamp && toolRadius > 0) {
      const R = Math.max(1e-6, Math.min(toolRadius, Number.isFinite(maxHelixRadius) ? maxHelixRadius : toolRadius));
      const cx = Number.isFinite(helixCenterX) ? helixCenterX : entryStart.x;
      const cy = Number.isFinite(helixCenterY) ? helixCenterY : entryStart.y;
      const helixStartX = cx + R;
      const helixStartY = cy;
      // Pocket-helix: rechte stuk boven materiaal is onderdeel van de ramp; helix start op zStart+leadInAbove.
      const helixRampStartZ = continuingFromPreviousLayer ? zStart : zStart + leadInAbove;
      if (!continuingFromPreviousLayer) {
        moves.push({ x: helixStartX, y: helixStartY, z: safeZ, type: "rapid" });
        if (safeZ > zStart + leadInAbove) {
          moves.push({ x: helixStartX, y: helixStartY, z: zStart + leadInAbove, type: "rapid" });
        }
        // Geen aparte rechte cut naar zStart; helix start direct op helixRampStartZ
      } else {
        moves.push({ x: helixStartX, y: helixStartY, z: zStart, type: "cut" });
      }

      const maxAnglePerMove = degToRad(8);
      const twoPi = 2 * Math.PI;
      const targetAngleNorm = (Math.atan2(start.y - cy, start.x - cx) + twoPi) % twoPi;
      let angle = 0;
      let currentZ = helixRampStartZ;

      while (currentZ > targetZ - 1e-6) {
        const remainingZ = currentZ - targetZ;
        const segmentDeltaZ =
          Math.abs(remainingZ) > maxDepth ? -maxDepth : -Math.abs(remainingZ);
        const segmentZ = currentZ + segmentDeltaZ;

        const angleNorm = ((angle % twoPi) + twoPi) % twoPi;
        let angleToTarget = (targetAngleNorm - angleNorm + twoPi) % twoPi;
        if (angleToTarget < 1e-6) angleToTarget = twoPi;
        const isLastSegment = segmentZ <= targetZ + 1e-6;

        let deltaAngleTotal;
        if (isLastSegment) {
          const minAngleForRamp =
            R > 1e-6 && rampAngleRad > 0
              ? Math.abs(targetZ - currentZ) / (R * Math.tan(rampAngleRad))
              : 0;
          deltaAngleTotal =
            angleToTarget +
            twoPi * Math.ceil(Math.max(0, minAngleForRamp - angleToTarget) / twoPi);
        } else {
          let arcLength =
            rampAngleRad > 0 ? Math.abs(segmentDeltaZ) / Math.tan(rampAngleRad) : 0;
          if (!isFinite(arcLength) || arcLength <= 0) arcLength = 0;
          deltaAngleTotal = R > 1e-6 ? arcLength / R : 0;
        }

        const numSteps = Math.max(
          1,
          Math.ceil(deltaAngleTotal / maxAnglePerMove)
        );
        const deltaAngle = deltaAngleTotal / numSteps;
        const deltaZTotal = isLastSegment ? targetZ - currentZ : segmentDeltaZ;
        const deltaZPerStep = deltaZTotal / numSteps;

        for (let step = 0; step < numSteps; step++) {
          angle += deltaAngle;
          const z = currentZ + deltaZPerStep * (step + 1);
          const x = cx + R * Math.cos(angle);
          const y = cy + R * Math.sin(angle);
          moves.push({ x, y, z, type: "cut" });
        }
        currentZ = isLastSegment ? targetZ : segmentZ;
        if (currentZ <= targetZ + 1e-6) break;
      }

      const helixEndX = cx + R * Math.cos(((angle % twoPi) + twoPi) % twoPi);
      const helixEndY = cy + R * Math.sin(((angle % twoPi) + twoPi) % twoPi);
      if (distance2D({ x: helixEndX, y: helixEndY }, start) > 1e-6) {
        moves.push({ x: start.x, y: start.y, z: depthZ, type: "cut" });
      }
    } else if (plungeOutside) {
      // Contour met insteken buiten: kleine helix rond entryStart (naast het onderdeel) tot op diepte,
      // dan rechte lijn naar start; zo snijden we nooit door de vorm.
      // Rechte stuk boven materiaal is onderdeel van de ramp; helix start op zStart+leadInAbove.
      const cx = entryStart.x;
      const cy = entryStart.y;
      const helixR = Math.max(0.5, Math.min(1.5, (cutParams.toolDiameter || 6) / 2));
      const helixStartX = cx + helixR;
      const helixStartY = cy;
      const helixRampStartZ = continuingFromPreviousLayer ? zStart : zStart + leadInAbove;

      if (!continuingFromPreviousLayer) {
        moves.push({ x: helixStartX, y: helixStartY, z: safeZ, type: "rapid" });
        if (safeZ > zStart + leadInAbove) {
          moves.push({ x: helixStartX, y: helixStartY, z: zStart + leadInAbove, type: "rapid" });
        }
        // Geen aparte rechte cut naar zStart; helix start direct op helixRampStartZ
      } else {
        // Volgende laag: geen retract; direct op diepte (last.z) naar helixstart, dan helix naar depthZ
        moves.push({ x: helixStartX, y: helixStartY, z: last.z, type: "cut" });
      }
      let currentAngle = 0;
      let currentZ = continuingFromPreviousLayer ? last.z : helixRampStartZ;

      const maxAnglePerMove = degToRad(8);
      const R = Math.max(1e-6, helixR);

      while (currentZ > targetZ - 1e-6) {
        const remainingZ = currentZ - targetZ;
        const segmentDeltaZ =
          Math.abs(remainingZ) > maxDepth ? -maxDepth : -Math.abs(remainingZ);
        const segmentZ = currentZ + segmentDeltaZ;
        const isLastSegment = segmentZ <= targetZ + 1e-6;

        let arcLength =
          rampAngleRad > 0 ? Math.abs(segmentDeltaZ) / Math.tan(rampAngleRad) : 0;
        if (!isFinite(arcLength) || arcLength <= 0) arcLength = 0;
        let deltaAngleTotal = R > 1e-6 ? arcLength / R : 0;
        if (isLastSegment) {
          const minAngleForRamp =
            R > 1e-6 && rampAngleRad > 0
              ? Math.abs(targetZ - currentZ) / (R * Math.tan(rampAngleRad))
              : 0;
          deltaAngleTotal = Math.max(deltaAngleTotal, minAngleForRamp);
        }
        const numSteps = Math.max(1, Math.ceil(deltaAngleTotal / maxAnglePerMove));
        const deltaAngle = deltaAngleTotal / numSteps;
        const deltaZTotal = isLastSegment ? targetZ - currentZ : segmentDeltaZ;
        const deltaZPerStep = deltaZTotal / numSteps;

        for (let step = 0; step < numSteps; step++) {
          currentAngle += deltaAngle;
          const z = currentZ + deltaZPerStep * (step + 1);
          const x = cx + R * Math.cos(currentAngle);
          const y = cy + R * Math.sin(currentAngle);
          moves.push({ x, y, z, type: "cut" });
        }
        currentZ = isLastSegment ? targetZ : segmentZ;
        if (currentZ <= targetZ + 1e-6) break;
      }

      moves.push({ x: start.x, y: start.y, z: depthZ, type: "cut" });
      skipFirstPathPoint = true;
    } else {
      // Contour ramp: P(path[0]) → ramp → B op diepte; dan contour van B naar P. Onderste laag: contour afmaken tot B.
      // Het rechte stuk boven het materiaal (leadInAbove) is onderdeel van de ramp: ramp start bij zStart+leadInAbove.
      pathAlreadyAtDepth = true;
      const rampStartZ = continuingFromPreviousLayer ? zStart : zStart + leadInAbove;
      const requiredPathLength =
        rampAngleRad > 0 ? Math.abs(targetZ - rampStartZ) / Math.tan(rampAngleRad) : 0;
      if (!continuingFromPreviousLayer) {
        if (safeZ > zStart + leadInAbove) {
          moves.push({ x: start.x, y: start.y, z: zStart + leadInAbove, type: "rapid" });
        }
        // Geen aparte rechte cut naar zStart meer; ramp start direct op rampStartZ
      }

      const n = path.length;
      if (n < 2 || requiredPathLength <= 1e-6) {
        moves.push({ x: start.x, y: start.y, z: depthZ, type: "cut" });
      } else {
        let dist = 0;
        let rampEndSeg = 0;
        let rampEndPoint = null;
        // Gesloten contour: segmenten (path[i], path[(i+1)%n]); meerdere rondes tot requiredPathLength
        rampLoop: while (true) {
          for (let i = 0; i < n; i++) {
            const a = path[i];
            const b = path[(i + 1) % n];
            const segLen = distance2D(a, b);
            if (segLen < 1e-9) continue;

            if (dist + segLen <= requiredPathLength) {
              dist += segLen;
              const z = rampStartZ + (depthZ - rampStartZ) * (dist / requiredPathLength);
              moves.push({ x: b.x, y: b.y, z, type: "cut" });
            } else {
              const remaining = requiredPathLength - dist;
              const t = remaining / segLen;
              const rx = a.x + t * (b.x - a.x);
              const ry = a.y + t * (b.y - a.y);
              rampEndPoint = { x: rx, y: ry };
              moves.push({ x: rx, y: ry, z: depthZ, type: "cut" });
              rampEndSeg = (i + 1) % n;
              break rampLoop;
            }
          }
        }

        if (rampEndPoint !== null) {
          if (isLastLayer) {
            if (tabConfig && tabConfig.enabled && tabConfig.totalLengthClosed != null) {
              const prevIdx = (rampEndSeg + n - 1) % n;
              const sRampEnd =
                tabConfig.cumulative[prevIdx] +
                distance2D(path[prevIdx], rampEndPoint);
              const eps = 1e-9;

              // Eerste deel: rampEndPoint → path[rampEndSeg]; op depthZ houden (geen tab-profiel) zodat geen plunge
              const sEndFirst = rampEndSeg === 0 ? tabConfig.totalLengthClosed : tabConfig.cumulative[rampEndSeg];
              const p0First = rampEndPoint;
              const p1First = path[rampEndSeg];
              const segLenFirst = sEndFirst - sRampEnd;
              const sListFirst = getTabBoundarySInSegment(sRampEnd, sEndFirst, tabConfig);
              for (const s of sListFirst) {
                if (s <= sRampEnd + eps) continue;
                const t = segLenFirst > 1e-12 ? (s - sRampEnd) / segLenFirst : 0;
                moves.push({
                  x: p0First.x + t * (p1First.x - p0First.x),
                  y: p0First.y + t * (p1First.y - p0First.y),
                  z: depthZ,
                  type: "cut",
                });
              }

              // Volle segmenten in wrap-volgorde met tab-profiel
              for (let k = 1; k < n; k++) {
                const idx = (rampEndSeg + k) % n;
                const nextIdx = (rampEndSeg + k + 1) % n;
                const sStart = tabConfig.cumulative[idx];
                const sEnd =
                  nextIdx === 0 ? tabConfig.totalLengthClosed : tabConfig.cumulative[nextIdx];
                const sList = getTabBoundarySInSegment(sStart, sEnd, tabConfig);
                const p0 = path[idx];
                const p1 = path[nextIdx];
                const segLen = sEnd - sStart;
                for (const s of sList) {
                  const t = segLen > 1e-12 ? (s - sStart) / segLen : 0;
                  moves.push({
                    x: p0.x + t * (p1.x - p0.x),
                    y: p0.y + t * (p1.y - p0.y),
                    z: getZForTabProfile(s, depthZ, tabConfig),
                    type: "cut",
                  });
                }
              }

              // Laatste deel: path[prevIdx] → rampEndPoint; daarna rampEndPoint om te sluiten
              const sListLast = getTabBoundarySInSegment(
                tabConfig.cumulative[prevIdx],
                sRampEnd,
                tabConfig
              );
              const p0Last = path[prevIdx];
              const segLenLast = sRampEnd - tabConfig.cumulative[prevIdx];
              for (const s of sListLast) {
                if (s >= sRampEnd - eps) continue;
                const t =
                  segLenLast > 1e-12
                    ? (s - tabConfig.cumulative[prevIdx]) / segLenLast
                    : 0;
                moves.push({
                  x: p0Last.x + t * (rampEndPoint.x - p0Last.x),
                  y: p0Last.y + t * (rampEndPoint.y - p0Last.y),
                  z: getZForTabProfile(s, depthZ, tabConfig),
                  type: "cut",
                });
              }
              moves.push({
                x: rampEndPoint.x,
                y: rampEndPoint.y,
                z: getZForTabProfile(sRampEnd, depthZ, tabConfig),
                type: "cut",
              });
            } else {
              for (let k = 0; k < n; k++) {
                const idx = (rampEndSeg + k) % n;
                const s = tabConfig ? tabConfig.cumulative[idx] : 0;
                const z = k === 0 ? depthZ : getZForTabProfile(s, depthZ, tabConfig);
                moves.push({ x: path[idx].x, y: path[idx].y, z, type: "cut" });
              }
              if (rampEndSeg !== 0) {
                const s =
                  rampEndSeg > 0 && tabConfig
                    ? tabConfig.cumulative[rampEndSeg - 1] +
                      distance2D(path[rampEndSeg - 1], rampEndPoint)
                    : 0;
                const zEnd = getZForTabProfile(s, depthZ, tabConfig);
                moves.push({
                  x: rampEndPoint.x,
                  y: rampEndPoint.y,
                  z: zEnd,
                  type: "cut",
                });
              }
            }
          } else {
            for (let s = rampEndSeg; s < n; s++) {
              moves.push({ x: path[s].x, y: path[s].y, z: depthZ, type: "cut" });
            }
            moves.push({ x: path[0].x, y: path[0].y, z: depthZ, type: "cut" });
          }
        }
      }
    }
  } else {
    // Plunge: verticale insteek (lead-in: alleen laatste leadInAbove mm als cut)
    if (!continuingFromPreviousLayer) {
      if (safeZ > leadInAbove) {
        moves.push({ x: entryStart.x, y: entryStart.y, z: leadInAbove, type: "rapid" });
      }
      moves.push({ x: entryStart.x, y: entryStart.y, z: 0, type: "cut" });
      moves.push({ x: entryStart.x, y: entryStart.y, z: depthZ, type: "cut" });
      if (plungeOutside) {
        addCurvedLeadIn(entryStart, start, path[1], depthZ);
      }
    } else {
      // Volgende laag: geen retract; op diepte (last.z) naar entryStart, dan plunge naar depthZ
      moves.push({ x: entryStart.x, y: entryStart.y, z: last.z, type: "cut" });
      moves.push({ x: entryStart.x, y: entryStart.y, z: depthZ, type: "cut" });
      if (plungeOutside) {
        addCurvedLeadIn(entryStart, start, path[1], depthZ);
      }
    }
  }

  // Nu volledige pad op deze diepte (tenzij we bij contour-ramp het pad al hebben gelopen)
  if (!pathAlreadyAtDepth) {
    const startIdx = skipFirstPathPoint ? 1 : 0;
    if (tabConfig && tabConfig.enabled && tabConfig.totalLengthClosed != null) {
      // Punten op exacte tab-grenzen zodat 50% vlak echt vlak is en ramps gelijke hoek hebben
      for (let i = startIdx; i < path.length - 1; i++) {
        const sStart = tabConfig.cumulative[i];
        const sEnd = tabConfig.cumulative[i + 1];
        const sList = getTabBoundarySInSegment(sStart, sEnd, tabConfig);
        const p0 = path[i];
        const p1 = path[i + 1];
        const segLen = sEnd - sStart;
        for (const s of sList) {
          const t = segLen > 1e-12 ? (s - sStart) / segLen : 0;
          const x = p0.x + t * (p1.x - p0.x);
          const y = p0.y + t * (p1.y - p0.y);
          const z = getZForTabProfile(s, depthZ, tabConfig);
          moves.push({ x, y, z, type: "cut" });
        }
      }
    } else {
      const useTabsHere = !!tabConfig && depthZ < (tabConfig.tabZ + 1e-6);
      for (let i = startIdx; i < path.length; i++) {
        const p = path[i];
        let z = depthZ;
        if (useTabsHere && tabConfig && tabConfig.enabled) {
          const s = tabConfig.cumulative[i];
          const inTab =
            s >= 0 &&
            s <= tabConfig.totalLength &&
            tabConfig.ranges.some((r) => s >= r.start && s <= r.end);
          if (inTab && depthZ < tabConfig.tabZ) {
            z = tabConfig.tabZ;
          }
        }
        moves.push({ x: p.x, y: p.y, z, type: "cut" });
      }
    }
  }
}

/**
 * Origin-transformatie op moves toepassen (XY en Z).
 * @param {ToolpathMove[]} moves
 * @param {*} originParams
 * @param {number} totalDepth
 * @param {number} toolRadiusForXYShift
 * @param {string} operation
 * @param {string} contourType
 * @param {{ hw: number, hh: number } | null} [facingBounds] - bij facing: halve breedte/hoogte van het vlak; (0,0) wordt de hoek van het oppervlak
 */
function applyOriginTransform(
  moves,
  originParams,
  totalDepth,
  toolRadiusForXYShift,
  operation,
  contourType,
  facingBounds
) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  moves.forEach((m) => {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
    if (m.x < minX) minX = m.x;
    if (m.y < minY) minY = m.y;
    if (m.x > maxX) maxX = m.x;
    if (m.y > maxY) maxY = m.y;
  });

  let shiftX = 0;
  let shiftY = 0;
  const r = Number.isFinite(toolRadiusForXYShift) ? toolRadiusForXYShift : 0;
  const isFacing = operation === OperationType.FACING && facingBounds;
  const contourOutside = operation === OperationType.CONTOUR && contourType === "outside";

  if (isFacing) {
    switch (originParams.xyOrigin) {
      case XYOrigin.BOTTOM_LEFT: shiftX = facingBounds.hw; shiftY = facingBounds.hh; break;
      case XYOrigin.BOTTOM_RIGHT: shiftX = -facingBounds.hw; shiftY = facingBounds.hh; break;
      case XYOrigin.TOP_LEFT: shiftX = facingBounds.hw; shiftY = -facingBounds.hh; break;
      case XYOrigin.TOP_RIGHT: shiftX = -facingBounds.hw; shiftY = -facingBounds.hh; break;
      case XYOrigin.CENTER: break;
      default: shiftX = facingBounds.hw; shiftY = facingBounds.hh; break;
    }
  } else if (originParams.xyOrigin !== XYOrigin.CENTER) {
    if (contourOutside) {
      switch (originParams.xyOrigin) {
        case XYOrigin.BOTTOM_LEFT: shiftX = -minX - r; shiftY = -minY - r; break;
        case XYOrigin.BOTTOM_RIGHT: shiftX = r - maxX; shiftY = -minY - r; break;
        case XYOrigin.TOP_LEFT: shiftX = -minX - r; shiftY = r - maxY; break;
        case XYOrigin.TOP_RIGHT: shiftX = r - maxX; shiftY = r - maxY; break;
        default: shiftX = -minX - r; shiftY = -minY - r; break;
      }
    } else {
      // Pocket/binnencontour: vorm binnen het pad. Origin (0,0) = geometrische hoek BUITEN het pad.
      // Frees loopt binnen → pad ligt op afstand r naar binnen van de rand → origin blijft buiten.
      switch (originParams.xyOrigin) {
        case XYOrigin.BOTTOM_LEFT: shiftX = -minX + r; shiftY = -minY + r; break;
        case XYOrigin.BOTTOM_RIGHT: shiftX = -maxX - r; shiftY = r - minY; break;
        case XYOrigin.TOP_LEFT: shiftX = r - minX; shiftY = -maxY - r; break;
        case XYOrigin.TOP_RIGHT: shiftX = -maxX - r; shiftY = -maxY - r; break;
        default: shiftX = -minX + r; shiftY = -minY + r; break;
      }
    }
  } else {
    // CENTER: middelpunt van bounding box naar (0,0)
    shiftX = -(minX + maxX) / 2;
    shiftY = -(minY + maxY) / 2;
  }

  const zOffset = originParams.zOffset || 0;
  const zOriginMode = originParams.zOrigin;

  moves.forEach((m) => {
    m.x += shiftX;
    m.y += shiftY;

    let z = m.z;
    if (zOriginMode === ZOrigin.STOCK_BOTTOM) {
      z += totalDepth; // bodem wordt Z0
    }
    z += zOffset;
    m.z = z;
  });
}

/**
 * Cirkel door 3 punten (xy). Retourneert { cx, cy, r } of null als collinear.
 * Formule: circumcenter van de driehoek.
 */
function circleFromThreePoints(p1, p2, p3) {
  const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y, x3 = p3.x, y3 = p3.y;
  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-10) return null;
  const cx = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
  const cy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
  const r = Math.hypot(x1 - cx, y1 - cy);
  return { cx, cy, r };
}

/**
 * Afwijking van punt t.o.v. cirkel (abs(afstand tot middelpunt - straal)).
 */
function pointToCircleDeviation(px, py, cx, cy, r) {
  return Math.abs(Math.hypot(px - cx, py - cy) - r);
}

/** Max afwijking (mm) om een reeks punten als cirkelboog te accepteren; wat ruimer voor Bézier-benaderingen */
const ARC_FIT_TOLERANCE_MM = 0.03;

/**
 * Vervang reeksen cut-bewegingen in de move-lijst door arc-bewegingen waar mogelijk.
 * Wijzigt de array in plaats; voegt move type 'arc' toe.
 * @param {ToolpathMove[]} moves
 */
function replaceCutRunsWithArcs(moves) {
  const out = [];
  let i = 0;
  while (i < moves.length) {
    const m = moves[i];
    if (m.type === "rapid") {
      out.push(m);
      i++;
      continue;
    }
    if (m.type !== "cut") {
      out.push(m);
      i++;
      continue;
    }
    const cutRun = [];
    while (i < moves.length && moves[i].type === "cut") {
      cutRun.push({ x: moves[i].x, y: moves[i].y, z: moves[i].z });
      i++;
    }
    const fitted = fitArcsToPoints(cutRun);
    for (const seg of fitted) {
      if (seg.type === "arc") {
        out.push({
          x: seg.x,
          y: seg.y,
          z: seg.z,
          type: "arc",
          i: seg.i,
          j: seg.j,
          clockwise: seg.clockwise,
        });
      } else {
        out.push({ x: seg.x, y: seg.y, z: seg.z, type: "cut" });
      }
    }
  }
  moves.length = 0;
  moves.push(...out);
}

/**
 * Consecutieve cut-bewegingen op dezelfde Z omzetten naar een mix van G1 en G2/G3.
 * @param {{ x: number, y: number, z: number }[]} points
 * @returns {{ type: 'line'|'arc', x: number, y: number, z: number, i?: number, j?: number, clockwise?: boolean }[]}
 */
function fitArcsToPoints(points) {
  if (points.length < 3) {
    return points.map((p) => ({ type: "line", ...p }));
  }
  const result = [];
  let i = 0;
  const z = points[0].z;
  while (i < points.length) {
    if (i >= points.length - 2) {
      result.push({ type: "line", ...points[i] });
      i++;
      continue;
    }
    const p0 = points[i];
    let bestJ = i + 2;
    for (let j = i + 3; j <= points.length; j++) {
      const pMid = points[Math.floor((i + j) / 2)];
      const pEnd = points[j - 1];
      const circle = circleFromThreePoints(p0, pMid, pEnd);
      if (!circle) break;
      let ok = true;
      for (let k = i + 1; k < j - 1 && ok; k++) {
        if (pointToCircleDeviation(points[k].x, points[k].y, circle.cx, circle.cy, circle.r) > ARC_FIT_TOLERANCE_MM) {
          ok = false;
        }
      }
      if (!ok) break;
      bestJ = j;
    }
    if (bestJ > i + 2) {
      const pEnd = points[bestJ - 1];
      const pMid = points[Math.floor((i + bestJ) / 2)];
      const circle = circleFromThreePoints(p0, pMid, pEnd);
      if (circle) {
        const dx = p0.x - circle.cx;
        const dy = p0.y - circle.cy;
        const ex = pEnd.x - circle.cx;
        const ey = pEnd.y - circle.cy;
        const cross = dx * ey - dy * ex;
        result.push({
          type: "arc",
          x: pEnd.x,
          y: pEnd.y,
          z,
          i: circle.cx - p0.x,
          j: circle.cy - p0.y,
          clockwise: cross < 0,
        });
        i = bestJ;
        continue;
      }
    }
    result.push({ type: "line", ...p0 });
    i++;
  }
  return result;
}

/**
 * G-code genereren uit toolpath. Cut-reeksen op dezelfde Z worden waar mogelijk als G2/G3-bogen uitgevoerd.
 * Gebruikt de geselecteerde eenheid (mm of inch): bij inch wordt G20 en alle coördinaten/F in inches uitgevoerd.
 * @param {Toolpath} toolpath
 * @param {*} params
 */
function toolpathToGcode(toolpath, params) {
  const { cutParams } = params;
  const unit = getDisplayUnit();
  const useInch = unit === "inch";
  const safeZMm = cutParams.safeHeight ?? DEFAULT_SAFE_Z;
  const safeZ = useInch ? fromMm(safeZMm, "inch") : safeZMm;
  const decimals = useInch ? 4 : 3;
  const feedrate = cutParams.feedrate && cutParams.feedrate > 0
    ? (useInch ? cutParams.feedrate / MM_PER_INCH : cutParams.feedrate)
    : 0;
  const lines = [];

  lines.push(`(${t("gcode.comment.generated")})`);
  lines.push(useInch ? `G20  (${t("gcode.comment.unitsInch")})` : `G21  (${t("gcode.comment.unitsMm")})`);
  lines.push(`G90  (${t("gcode.comment.absolute")})`);
  lines.push(`G0 Z${safeZ.toFixed(decimals)}`);
  lines.push(`M3  (${t("gcode.comment.spindleOn")})`);

  let currentFeed = 0;
  const moves = toolpath.moves;
  let idx = 0;

  function outCoord(v) {
    if (v == null || !Number.isFinite(v)) return null;
    const val = useInch ? fromMm(v, "inch") : v;
    return val.toFixed(decimals);
  }

  while (idx < moves.length) {
    const m = moves[idx];
    const x = Number.isFinite(m.x) ? m.x : null;
    const y = Number.isFinite(m.y) ? m.y : null;
    const z = Number.isFinite(m.z) ? m.z : null;

    if (m.type === "rapid") {
      const xs = x != null ? `X${outCoord(x)}` : "";
      const ys = y != null ? `Y${outCoord(y)}` : "";
      const zs = z != null ? `Z${outCoord(z)}` : "";
      lines.push(`G0 ${xs} ${ys} ${zs}`.trim());
      idx++;
      continue;
    }

    const cutRun = [];
    while (idx < moves.length && moves[idx].type === "cut") {
      const c = moves[idx];
      cutRun.push({ x: c.x, y: c.y, z: c.z });
      idx++;
    }
    for (const c of cutRun) {
      const xs = `X${outCoord(c.x)}`;
      const ys = `Y${outCoord(c.y)}`;
      const zs = c.z != null ? ` Z${outCoord(c.z)}` : "";
      let line = `G1 ${xs} ${ys}${zs}`.trim();
      if (feedrate && feedrate !== currentFeed) {
        line += ` F${(useInch ? feedrate : cutParams.feedrate).toFixed(useInch ? 2 : 0)}`;
        currentFeed = feedrate;
      }
      lines.push(line);
    }
  }

  lines.push(`G0 Z${safeZ.toFixed(decimals)}`);
  lines.push(`M5  (${t("gcode.comment.spindleOff")})`);
  lines.push("M30");

  return lines.join("\n");
}

/** Typische snelle verplaatsing (G0) in mm/min voor tijdsinschatting. */
const DEFAULT_RAPID_FEEDRATE_MM_MIN = 10000;

/**
 * Schat de freesduur op basis van toolpath en feedrate.
 * @param {Toolpath} toolpath
 * @param {{ feedrate: number }} cutParams
 * @returns {{ totalMinutes: number, cutMinutes: number, rapidMinutes: number, cutDistanceMm: number, rapidDistanceMm: number }}
 */
function estimateMillingTime(toolpath, cutParams) {
  const feedrate = cutParams.feedrate && cutParams.feedrate > 0 ? cutParams.feedrate : 1;
  const rapidFeed = DEFAULT_RAPID_FEEDRATE_MM_MIN;
  let cutDist = 0;
  let rapidDist = 0;
  let prev = null;
  for (const m of toolpath.moves) {
    const x = Number.isFinite(m.x) ? m.x : 0;
    const y = Number.isFinite(m.y) ? m.y : 0;
    const z = Number.isFinite(m.z) ? m.z : 0;
    if (prev != null) {
      const dx = x - prev.x;
      const dy = y - prev.y;
      const dz = z - prev.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (m.type === "cut") {
        cutDist += d;
      } else {
        rapidDist += d;
      }
    }
    prev = { x, y, z };
  }
  const cutMinutes = cutDist / feedrate;
  const rapidMinutes = rapidDist / rapidFeed;
  const totalMinutes = cutMinutes + rapidMinutes;
  return {
    totalMinutes,
    cutMinutes,
    rapidMinutes,
    cutDistanceMm: cutDist,
    rapidDistanceMm: rapidDist,
  };
}

/**
 * Formatteer geschatte tijd als leesbare string (bijv. "2 min" of "1 u 15 min").
 * @param {number} totalMinutes
 * @returns {string}
 */
function formatEstimatedTime(totalMinutes) {
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return "—";
  if (totalMinutes < 1) {
    const sec = Math.round(totalMinutes * 60);
    return sec <= 0 ? t("preview.estimatedTimeUnder1Min") : t("preview.estimatedTimeSec", { sec });
  }
  if (totalMinutes < 60) {
    return t("preview.estimatedTimeMin", { min: Math.round(totalMinutes) });
  }
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  return t("preview.estimatedTimeHMin", { h, m });
}

/**
 * Bepaal of de gegeven G-code in inches (G20) of mm (G21) is.
 * @param {string} gcodeText
 * @returns {"inch" | "mm"}
 */
function getGcodeUnitFromText(gcodeText) {
  if (!gcodeText || typeof gcodeText !== "string") return "mm";
  const lines = gcodeText.split("\n").slice(0, 20);
  for (const line of lines) {
    if (/G20\b/.test(line.trim())) return "inch";
    if (/G21\b/.test(line.trim())) return "mm";
  }
  return "mm";
}

/**
 * Haal X, Y, Z uit één G-code regel (bijv. "G1 X25.000 Y25.000 Z-1.000").
 * @param {string} line
 * @returns {{ x: number, y: number, z: number } | null} machinecoördinaten in mm, of null als geen X/Y
 */
function parseGcodeLineForPoint(line) {
  if (!line || typeof line !== "string") return null;
  const trimmed = line.trim();
  const xMatch = trimmed.match(/X\s*([-\d.]+)/i);
  const yMatch = trimmed.match(/Y\s*([-\d.]+)/i);
  const zMatch = trimmed.match(/Z\s*([-\d.]+)/i);
  const x = xMatch ? Number(xMatch[1].replace(",", ".")) : NaN;
  const y = yMatch ? Number(yMatch[1].replace(",", ".")) : NaN;
  const z = zMatch ? Number(zMatch[1].replace(",", ".")) : 0;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x,
    y,
    z: Number.isFinite(z) ? z : 0,
  };
}

/**
 * Preview tekenen op canvas.
 * @param {Toolpath} toolpath
 * @param {HTMLCanvasElement} canvas
 * @param {keyof typeof PreviewViewMode} [viewMode]
 * @param {{ x: number, y: number, z: number, diameter: number } | null} [cursorColumn] optionele kolom: midden onderkant op dit punt, hoogte 50 mm, diameter = freesdikte
 */
function renderPreview(toolpath, canvas, viewMode = currentPreviewView, cursorColumn = null) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!toolpath.moves.length) return;

  // 3D/2D-wireframe weergave: afhankelijk van viewMode projecteren.
  const angleZ = degToRad(45); // voor isometrische weergave
  const angleX = degToRad(60);
  const DEPTH_SCALE = 2; // diepte iets overdrijven zodat het beter opvalt

  /** @type {{ x:number, y:number, type:'rapid'|'cut' }[]} */
  const projected = [];

  // Eerst alle punten omzetten naar een gecentreerd 3D-coördinatenstelsel.
  let minX0 = Infinity;
  let minY0 = Infinity;
  let minZ0 = Infinity;
  let maxX0 = -Infinity;
  let maxY0 = -Infinity;
  let maxZ0 = -Infinity;

  toolpath.moves.forEach((m) => {
    if (
      !Number.isFinite(m.x) ||
      !Number.isFinite(m.y) ||
      !Number.isFinite(m.z)
    ) {
      return;
    }
    if (m.x < minX0) minX0 = m.x;
    if (m.y < minY0) minY0 = m.y;
    if (m.z < minZ0) minZ0 = m.z;
    if (m.x > maxX0) maxX0 = m.x;
    if (m.y > maxY0) maxY0 = m.y;
    if (m.z > maxZ0) maxZ0 = m.z;
  });

  if (
    !isFinite(minX0) ||
    !isFinite(minY0) ||
    !isFinite(minZ0) ||
    !isFinite(maxX0) ||
    !isFinite(maxY0) ||
    !isFinite(maxZ0)
  ) {
    return;
  }

  const cx = (minX0 + maxX0) / 2;
  const cy = (minY0 + maxY0) / 2;
  const cz = (minZ0 + maxZ0) / 2;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function projectPoint(x, y, z) {
    // z komt hier al geschaald binnen
    switch (viewMode) {
      case PreviewViewMode.TOP:
        // Bovenaanzicht: gewoon XY
        return { x, y };
      case PreviewViewMode.FRONT:
        // Voor: X horizontaal, Z verticaal
        return { x, y: -z };
      case PreviewViewMode.SIDE:
        // Zijkant: Y horizontaal, Z verticaal
        return { x: y, y: -z };
      case PreviewViewMode.ISO:
      default: {
        // Isometrische projectie met rotaties
        const cosZ = Math.cos(angleZ);
        const sinZ = Math.sin(angleZ);
        const x1 = x * cosZ - y * sinZ;
        const y1 = x * sinZ + y * cosZ;
        const z1 = z;

        const cosX = Math.cos(angleX);
        const sinX = Math.sin(angleX);
        const y2 = y1 * cosX - z1 * sinX;
        // const z2 = y1 * sinX + z1 * cosX; // kan later voor shading gebruikt worden
        const x2 = x1;
        return { x: x2, y: y2 };
      }
    }
  }

  toolpath.moves.forEach((m, idx) => {
    if (
      !Number.isFinite(m.x) ||
      !Number.isFinite(m.y) ||
      !Number.isFinite(m.z)
    ) {
      projected[idx] = null;
      return;
    }

    // Centreer rond (0,0,0) en schaal diepte
    const x = m.x - cx;
    const y = m.y - cy;
    // Inverseer Z zodat "dieper in het materiaal" visueel logischer wordt
    const z = (cz - m.z) * DEPTH_SCALE;

    const p = projectPoint(x, y, z);

    projected[idx] = { x: p.x, y: p.y, type: m.type };

    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  });

  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
    return;
  }

  const width = maxX - minX || 1;
  const height = maxY - minY || 1;
  const margin = 20;
  const scale = Math.min(
    (canvas.width - 2 * margin) / width,
    (canvas.height - 2 * margin) / height
  );

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  function toCanvas(p) {
    const xNorm = (p.x - (minX + maxX) / 2) * scale;
    const yNorm = (p.y - (minY + maxY) / 2) * scale;
    return {
      x: centerX + xNorm,
      y: centerY - yNorm,
    };
  }

  // Achtergrond-raster licht
  ctx.save();
  ctx.strokeStyle = "rgba(148, 163, 184, 0.15)";
  ctx.lineWidth = 1;
  const gridSpacing = 20;
  for (let x = 0; x <= canvas.width; x += gridSpacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= canvas.height; y += gridSpacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
  ctx.restore();

  // Toolpath tekenen
  let last = null;
  for (let i = 0; i < toolpath.moves.length; i++) {
    const m = toolpath.moves[i];
    const proj = projected[i];
    if (!proj) {
      last = null;
      continue;
    }
    const p = toCanvas(proj);
    if (last) {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      if (m.type === "arc" && i > 0) {
        const prevMove = toolpath.moves[i - 1];
        const startP = projectPoint(
          prevMove.x - cx,
          prevMove.y - cy,
          (cz - prevMove.z) * DEPTH_SCALE
        );
        const centerP = projectPoint(
          prevMove.x + m.i - cx,
          prevMove.y + m.j - cy,
          (cz - m.z) * DEPTH_SCALE
        );
        const startC = toCanvas(startP);
        const centerC = toCanvas(centerP);
        const r = Math.hypot(startC.x - centerC.x, startC.y - centerC.y);
        const startAngle = Math.atan2(startC.y - centerC.y, startC.x - centerC.x);
        const endAngle = Math.atan2(p.y - centerC.y, p.x - centerC.x);
        ctx.arc(centerC.x, centerC.y, r, startAngle, endAngle, !m.clockwise);
        ctx.strokeStyle = "#38bdf8";
        ctx.setLineDash([]);
        ctx.lineWidth = 2;
      } else {
        ctx.lineTo(p.x, p.y);
        if (m.type === "rapid") {
          ctx.strokeStyle = "#f97316";
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 1.5;
        } else {
          ctx.strokeStyle = "#38bdf8";
          ctx.setLineDash([]);
          ctx.lineWidth = 2;
        }
      }
      ctx.stroke();
    }
    last = p;
  }

  // Origin markeren (0,0)
  const originProjected = projectPoint(0 - cx, 0 - cy, (cz - 0) * DEPTH_SCALE);
  const originCanvas = toCanvas(originProjected);
  ctx.save();
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 1.5;
  const r = 4;
  ctx.beginPath();
  ctx.moveTo(originCanvas.x - r, originCanvas.y);
  ctx.lineTo(originCanvas.x + r, originCanvas.y);
  ctx.moveTo(originCanvas.x, originCanvas.y - r);
  ctx.lineTo(originCanvas.x, originCanvas.y + r);
  ctx.stroke();
  ctx.restore();

  // Semi-transparante witte kolom op het punt van de gcode-regel onder de cursor (onderkant midden op punt, hoogte 50 mm, diameter = freesdikte)
  if (cursorColumn && toolpath.moves.length > 0) {
    const CYLINDER_HEIGHT_MM = 50;
    const r = (Number.isFinite(cursorColumn.diameter) ? cursorColumn.diameter : 4) / 2;
    const x0 = cursorColumn.x - cx;
    const y0 = cursorColumn.y - cy;
    const zBottom = (cz - cursorColumn.z) * DEPTH_SCALE;
    const zTop = (cz - (cursorColumn.z + CYLINDER_HEIGHT_MM)) * DEPTH_SCALE;
    const segments = 24;
    const bottomPoints = [];
    const topPoints = [];
    for (let i = 0; i <= segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      const bx = x0 + r * Math.cos(t);
      const by = y0 + r * Math.sin(t);
      const pBot = projectPoint(bx, by, zBottom);
      const pTop = projectPoint(bx, by, zTop);
      bottomPoints.push(toCanvas(pBot));
      topPoints.push(toCanvas(pTop));
    }
    ctx.save();
    const isLightTheme = typeof document !== "undefined" && document.body?.dataset.theme === "light";
    ctx.fillStyle = isLightTheme ? "rgba(148, 163, 184, 0.55)" : "rgba(255, 255, 255, 0.45)";
    ctx.strokeStyle = isLightTheme ? "rgba(107, 114, 128, 0.9)" : "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = 1;
    // Ondercirkel
    ctx.beginPath();
    ctx.moveTo(bottomPoints[0].x, bottomPoints[0].y);
    for (let i = 1; i < bottomPoints.length; i++) ctx.lineTo(bottomPoints[i].x, bottomPoints[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Zijvlakken (quads tussen onder- en bovenring)
    for (let i = 0; i < segments; i++) {
      ctx.beginPath();
      ctx.moveTo(bottomPoints[i].x, bottomPoints[i].y);
      ctx.lineTo(bottomPoints[i + 1].x, bottomPoints[i + 1].y);
      ctx.lineTo(topPoints[i + 1].x, topPoints[i + 1].y);
      ctx.lineTo(topPoints[i].x, topPoints[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // Bovencirkel
    ctx.beginPath();
    ctx.moveTo(topPoints[0].x, topPoints[0].y);
    for (let i = 1; i < topPoints.length; i++) ctx.lineTo(topPoints[i].x, topPoints[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Download als .nc bestand.
 */
function downloadGcode(filename, gcode) {
  const blob = new Blob([gcode], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function copyGcodeToClipboard(gcode) {
  try {
    await navigator.clipboard.writeText(gcode);
    alert(t("error.copySuccess"));
  } catch (e) {
    alert(t("error.copyFailed"));
  }
}

/**
 * UI-initialisatie
 */
function setupUI() {
  currentLang = getCurrentLang();
  document.documentElement.lang = currentLang;
  applyTranslations();
  document.querySelectorAll(".lang-switcher .lang-btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.getAttribute("data-lang") === currentLang ? "true" : "false");
    btn.addEventListener("click", () => {
      const lang = btn.getAttribute("data-lang");
      if (lang) setLanguage(lang);
    });
  });

  // Theme switcher (dark / light)
  function applyTheme(theme) {
    const body = document.body;
    if (!body) return;
    const next = theme === "light" ? "light" : "dark";
    body.dataset.theme = next;
    body.classList.toggle("theme-light", next === "light");
    body.classList.toggle("theme-dark", next === "dark");
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch (_) {}
    const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("theme-toggle"));
    if (btn) {
      const isLight = next === "light";
      btn.setAttribute("aria-pressed", isLight ? "true" : "false");
      btn.textContent = isLight ? "☀" : "☾";
    }
  }

  const initialTheme = getCurrentTheme();
  applyTheme(initialTheme);
  const themeToggleBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("theme-toggle"));
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const current = document.body?.dataset.theme === "light" ? "light" : "dark";
      const next = current === "light" ? "dark" : "light";
      applyTheme(next);
    });
  }

  // Unit switcher (mm / inch): bewaar keuze, converteer velden bij wissel, update labels
  const LENGTH_INPUT_IDS = [
    "circle-diameter", "square-size", "rect-width", "rect-height", "ellipse-major", "ellipse-minor", "letter-size",
    "countersunk-head-diameter", "countersunk-depth", "countersunk-bolt-diameter",
    "patterned-holes-diameter", "patterned-holes-spacing-x", "patterned-holes-spacing-y",
    "tab-interval", "tab-width", "tab-height",
    "tool-diameter", "total-depth", "stepdown", "stepover", "feedrate", "safe-height", "lead-in-above", "z-offset",
  ];
  /** Minimum waarden in mm; in inch-modus omrekenen zodat HTML5-validatie en steppers kloppen. */
  const MIN_MM_BY_INPUT = {
    "tool-diameter": 1,
    "letter-size": 1,
    "tab-interval": 1,
    "tab-width": 1,
    "tab-height": 0.1,
  };
  /** Step in mm voor wrapper (data-step); gebruikt voor +/- knoppen en in inch omgerekend. */
  const STEP_MM_BY_INPUT = {
    "circle-diameter": 1, "square-size": 1, "rect-width": 1, "rect-height": 1,
    "ellipse-major": 1, "ellipse-minor": 1, "letter-size": 1,
    "patterned-holes-diameter": 0.1, "patterned-holes-spacing-x": 1, "patterned-holes-spacing-y": 1,
    "countersunk-head-diameter": 1, "countersink-depth": 0.5, "countersunk-bolt-diameter": 0.5,
    "tab-interval": 5, "tab-width": 1, "tab-height": 0.5,
    "tool-diameter": 1, "total-depth": 0.5, "stepdown": 0.5, "feedrate": 50,
    "safe-height": 1, "lead-in-above": 0.5, "z-offset": 0.5,
  };
  /** Inputs met vaste step in HTML (niet "any"); in inch step="any", in mm herstellen. */
  const INPUT_FIXED_STEP_MM = {
    "tool-diameter": 1, "tab-interval": 1, "tab-width": 1, "safe-height": 1,
    "total-depth": 0.5, "stepdown": 0.5, "feedrate": 50, "lead-in-above": 0.5, "z-offset": 0.5,
  };
  /** Default waarden in inch (afgeleid van mm-defaults, afgerond op logische inch-waarden). Stepover blijft %. */
  const DEFAULT_VALUES_INCH = {
    "circle-diameter": 2,
    "square-size": 2,
    "rect-width": 3.5,
    "rect-height": 5,
    "ellipse-major": 2.25,
    "ellipse-minor": 1.5,
    "letter-size": 0.375,
    "patterned-holes-diameter": 0.8,
    "patterned-holes-spacing-x": 3.75,
    "patterned-holes-spacing-y": 3.75,
    "countersunk-head-diameter": 0.5,
    "countersink-depth": 0.125,
    "countersunk-bolt-diameter": 0.25,
    "tab-interval": 1.5,
    "tab-width": 0.25,
    "tab-height": 0.04,
    "tool-diameter": 0.125,
    "total-depth": 0.25,
    "stepdown": 0.04,
    "feedrate": 30,
    "safe-height": 0.5,
    "lead-in-above": 0.1,
  };
  function applyInchDefaults() {
    Object.keys(DEFAULT_VALUES_INCH).forEach((id) => {
      const input = document.getElementById(id);
      if (input && "value" in input) /** @type {HTMLInputElement} */ (input).value = String(DEFAULT_VALUES_INCH[id]);
    });
  }
  function updateInputMinMaxForUnit(unit) {
    const isInch = unit === "inch";
    Object.keys(MIN_MM_BY_INPUT).forEach((id) => {
      const input = document.getElementById(id);
      if (!input || !("min" in input)) return;
      const minMm = MIN_MM_BY_INPUT[id];
      const minDisplay = isInch ? Math.round((minMm / MM_PER_INCH) * 1000) / 1000 : minMm;
      /** @type {HTMLInputElement} */ (input).min = String(minDisplay);
      const wrapper = input.closest(".input-with-stepper");
      if (wrapper) wrapper.setAttribute("data-min", String(minDisplay));
    });
    LENGTH_INPUT_IDS.forEach((id) => {
      const input = document.getElementById(id);
      if (!input || !("step" in input)) return;
      if (isInch) {
        /** @type {HTMLInputElement} */ (input).step = "any";
      } else if (INPUT_FIXED_STEP_MM[id] != null) {
        /** @type {HTMLInputElement} */ (input).step = String(INPUT_FIXED_STEP_MM[id]);
      }
      const stepMm = STEP_MM_BY_INPUT[id];
      if (stepMm != null) {
        const wrapper = input.closest(".input-with-stepper");
        if (wrapper) {
          const stepDisplay = isInch
            ? Math.round((stepMm / MM_PER_INCH) * 1000) / 1000
            : stepMm;
          wrapper.setAttribute("data-step", String(stepDisplay));
        }
      }
    });
  }
  function setDisplayUnit(unit) {
    const prev = getDisplayUnit();
    if (prev === unit) return;
    try {
      localStorage.setItem(UNIT_STORAGE_KEY, unit);
    } catch (_) {}
    const toInch = unit === "inch";
    const stepoverUnit = /** @type {HTMLInputElement} */ (document.querySelector('input[name="stepover-unit"]:checked'))?.value ?? "percent";
    LENGTH_INPUT_IDS.forEach((id) => {
      if (id === "stepover" && stepoverUnit === "percent") return;
      const el = document.getElementById(id);
      if (!el || !("value" in el)) return;
      const val = toNumber(/** @type {HTMLInputElement} */ (el).value);
      if (!Number.isFinite(val)) return;
      /** @type {HTMLInputElement} */ (el).value = toInch
        ? String(Math.round(val / MM_PER_INCH * 1000) / 1000)
        : String(Math.round(val * MM_PER_INCH * 100) / 100);
    });
    updateInputMinMaxForUnit(unit);
    updateStepoverUnitLabel();
    document.querySelectorAll(".unit-switcher .unit-btn").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.getAttribute("data-unit") === unit ? "true" : "false");
    });
    applyTranslations();
    document.dispatchEvent(new CustomEvent("unitchange"));
  }
  function updateStepoverUnitLabel() {
    const span = document.querySelector('.stepover-unit-toggle input[value="mm"] + span');
    if (span) span.textContent = getDisplayUnit() === "inch" ? "in" : "mm";
  }
  const savedUnit = getDisplayUnit();
  updateInputMinMaxForUnit(savedUnit);
  updateStepoverUnitLabel();
  if (savedUnit === "inch") applyInchDefaults();
  document.querySelectorAll(".unit-switcher .unit-btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.getAttribute("data-unit") === savedUnit ? "true" : "false");
    btn.addEventListener("click", () => {
      const u = btn.getAttribute("data-unit");
      if (u === "mm" || u === "inch") setDisplayUnit(u);
    });
  });

  const form = /** @type {HTMLFormElement} */ (
    document.getElementById("gcode-form")
  );
  const shapeSelect = /** @type {HTMLSelectElement} */ (
    document.getElementById("shape")
  );
  const xyOriginSelect = /** @type {HTMLSelectElement} */ (
    document.getElementById("xy-origin")
  );
  const rampSettings = document.getElementById("ramp-settings");
  const entryButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (
    document.querySelectorAll(".entry-method-btn")
  );
  const entryMethodInput = /** @type {HTMLInputElement} */ (
    document.getElementById("entry-method")
  );
  const plungeOutsideButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (
    document.querySelectorAll(".plunge-outside-btn")
  );
  const plungeOutsideInput = /** @type {HTMLInputElement} */ (
    document.getElementById("plunge-outside")
  );
  const contourTypeRow = document.getElementById("contour-type-row");
  const operationSelect = /** @type {HTMLSelectElement} */ (
    document.getElementById("operation")
  );
  const errorMessage = document.getElementById("error-message");
  const gcodeOutput = /** @type {HTMLTextAreaElement} */ (
    document.getElementById("gcode-output")
  );
  const gcodeLineHighlightOverlay = document.getElementById("gcode-line-highlight-overlay");
  const gcodeLineHighlightInner = document.getElementById("gcode-line-highlight-inner");
  const gcodeLineHighlightBar = document.getElementById("gcode-line-highlight-bar");
  const previewCanvas = /** @type {HTMLCanvasElement} */ (
    document.getElementById("preview-canvas")
  );
  const downloadBtn = document.getElementById("download-btn");
  const copyBtn = document.getElementById("copy-btn");
  const viewButtons = /** @type {NodeListOf<HTMLButtonElement>} */ (
    document.querySelectorAll(".preview-view-btn")
  );
  const tabsEnabledCheckbox = /** @type {HTMLInputElement} */ (
    document.getElementById("tabs-enabled")
  );
  const tabParamRows = document.querySelectorAll(".tab-param-row");
  const tabIntervalInput = /** @type {HTMLInputElement} */ (document.getElementById("tab-interval"));
  const tabWidthInput = /** @type {HTMLInputElement} */ (document.getElementById("tab-width"));
  const tabHeightInput = /** @type {HTMLInputElement} */ (document.getElementById("tab-height"));

  function updateTabParamsVisibility() {
    const enabled = !!tabsEnabledCheckbox?.checked;
    tabParamRows.forEach((row) => {
      if (enabled) {
        row.classList.remove("hidden");
      } else {
        row.classList.add("hidden");
      }
    });
    if (tabIntervalInput) tabIntervalInput.disabled = !enabled;
    if (tabWidthInput) tabWidthInput.disabled = !enabled;
    if (tabHeightInput) tabHeightInput.disabled = !enabled;
    updateContourTabsRampHintVisibility();
  }

  const contourTabsRampHintEl = document.getElementById("contour-tabs-ramp-hint");
  function updateContourTabsRampHintVisibility() {
    if (!contourTabsRampHintEl) return;
    const isContour = operationSelect?.value === OperationType.CONTOUR;
    const tabsEnabled = !!tabsEnabledCheckbox?.checked;
    const isRamp = entryMethodInput?.value === EntryMethod.RAMP;
    const show = isContour && tabsEnabled && isRamp;
    if (show) {
      contourTabsRampHintEl.classList.remove("hidden");
    } else {
      contourTabsRampHintEl.classList.add("hidden");
    }
  }

  shapeSelect.addEventListener("change", () => {
    document
      .querySelectorAll(".shape-field")
      .forEach((el) => el.classList.add("hidden"));
    const selected = shapeSelect.value;
    const map = {
      [ShapeType.CIRCLE]: ".shape-circle",
      [ShapeType.SQUARE]: ".shape-square",
      [ShapeType.RECTANGLE]: ".shape-rectangle",
      [ShapeType.FACING]: ".shape-rectangle",
      [ShapeType.ELLIPSE]: ".shape-ellipse",
      [ShapeType.LETTERS]: ".shape-letters",
      [ShapeType.COUNTERSUNK_BOLT]: ".shape-countersunk-bolt",
      [ShapeType.PATTERNED_HOLES]: ".shape-patterned-holes",
    };
    const selector = map[selected];
    if (selector) {
      document
        .querySelectorAll(selector)
        .forEach((el) => el.classList.remove("hidden"));
    }

    const operationRow = document.getElementById("operation-row");
    const contourOnlyElems = document.querySelectorAll(".contour-only");
    const facingOnlyElems = document.querySelectorAll(".facing-only");
    if (selected === ShapeType.LETTERS || selected === ShapeType.COUNTERSUNK_BOLT || selected === ShapeType.PATTERNED_HOLES) {
      if (operationRow) operationRow.classList.add("hidden");
      contourOnlyElems.forEach((el) => el.classList.add("hidden"));
      facingOnlyElems.forEach((el) => el.classList.add("hidden"));
    } else if (selected === ShapeType.FACING) {
      if (operationRow) operationRow.classList.add("hidden");
      contourOnlyElems.forEach((el) => el.classList.add("hidden"));
      facingOnlyElems.forEach((el) => el.classList.remove("hidden"));
    } else {
      if (operationRow) operationRow.classList.remove("hidden");
      facingOnlyElems.forEach((el) => el.classList.add("hidden"));
      updateContourTypeVisibility();
    }

    // Standaard XY-origin per vorm:
    // - Letters / vierkant / rechthoek / facing: linksonder
    // - Cirkel / ellipse / bout verzonken: midden
    if (xyOriginSelect) {
      if (selected === ShapeType.SQUARE || selected === ShapeType.RECTANGLE || selected === ShapeType.FACING || selected === ShapeType.LETTERS || selected === ShapeType.PATTERNED_HOLES) {
        xyOriginSelect.value = XYOrigin.BOTTOM_LEFT;
      } else if (selected === ShapeType.CIRCLE || selected === ShapeType.ELLIPSE || selected === ShapeType.COUNTERSUNK_BOLT) {
        xyOriginSelect.value = XYOrigin.CENTER;
      }
    }

    // Voor letters: standaard totale diepte 0,5 mm (gravering)
    if (selected === ShapeType.LETTERS) {
      const totalDepthEl = /** @type {HTMLInputElement} */ (document.getElementById("total-depth"));
      if (totalDepthEl) totalDepthEl.value = "0.5";
    }

    updateToolDiameterVisibility();
  });

  // Presets: vierkant (50, 100, 150) en rechthoek (A4, A5, A6, foto) via dropdown; geselecteerde preset blijft zichtbaar tot breedte/hoogte handmatig wordt gewijzigd
  const squarePresetSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("square-preset"));
  const rectPresetSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("rect-preset"));
  const squareSizeInput = document.getElementById("square-size");
  const rectWidthInput = document.getElementById("rect-width");
  const rectHeightInput = document.getElementById("rect-height");

  if (squarePresetSelect) {
    squarePresetSelect.addEventListener("change", () => {
      const val = squarePresetSelect.value;
      if (!val) return;
      const mm = toNumber(val);
      if (squareSizeInput) /** @type {HTMLInputElement} */ (squareSizeInput).value = String(fromMm(mm, getDisplayUnit()));
    });
  }
  if (squareSizeInput && squarePresetSelect) {
    squareSizeInput.addEventListener("input", () => {
      const val = /** @type {HTMLInputElement} */ (squareSizeInput).value;
      const match = ["50", "100", "150"].includes(val) ? val : "";
      squarePresetSelect.value = match;
    });
  }

  if (rectPresetSelect) {
    rectPresetSelect.addEventListener("change", () => {
      const val = rectPresetSelect.value;
      if (!val) return;
      const [w, h] = val.split(",").map(Number);
      if (!Number.isFinite(w) || !Number.isFinite(h)) return;
      const u = getDisplayUnit();
      if (rectWidthInput) /** @type {HTMLInputElement} */ (rectWidthInput).value = String(fromMm(w, u));
      if (rectHeightInput) /** @type {HTMLInputElement} */ (rectHeightInput).value = String(fromMm(h, u));
    });
  }
  function syncRectPresetFromInputs() {
    if (!rectPresetSelect || !rectWidthInput || !rectHeightInput) return;
    const w = Math.round(parseFloat(/** @type {HTMLInputElement} */ (rectWidthInput).value) || 0);
    const h = Math.round(parseFloat(/** @type {HTMLInputElement} */ (rectHeightInput).value) || 0);
    const key1 = `${w},${h}`;
    const key2 = `${h},${w}`;
    const options = Array.from(rectPresetSelect.options);
    const match = options.find((opt) => opt.value === key1 || opt.value === key2);
    rectPresetSelect.value = match ? match.value : "";
  }
  if (rectWidthInput) rectWidthInput.addEventListener("input", syncRectPresetFromInputs);
  if (rectHeightInput) rectHeightInput.addEventListener("input", syncRectPresetFromInputs);

  // Preset patterned holes (Festool MFT)
  const patternedHolesPresetSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("patterned-holes-preset"));
  const patternedHolesDiameterInput = document.getElementById("patterned-holes-diameter");
  const patternedHolesSpacingXInput = document.getElementById("patterned-holes-spacing-x");
  const patternedHolesSpacingYInput = document.getElementById("patterned-holes-spacing-y");
  if (patternedHolesPresetSelect) {
    patternedHolesPresetSelect.addEventListener("change", () => {
      const val = patternedHolesPresetSelect.value;
      if (val === "mft") {
        const u = getDisplayUnit();
        if (patternedHolesDiameterInput) /** @type {HTMLInputElement} */ (patternedHolesDiameterInput).value = String(fromMm(20.2, u));
        if (patternedHolesSpacingXInput) /** @type {HTMLInputElement} */ (patternedHolesSpacingXInput).value = String(fromMm(96, u));
        if (patternedHolesSpacingYInput) /** @type {HTMLInputElement} */ (patternedHolesSpacingYInput).value = String(fromMm(96, u));
      }
    });
  }
  function syncPatternedHolesPresetFromInputs() {
    if (!patternedHolesPresetSelect || !patternedHolesDiameterInput || !patternedHolesSpacingXInput || !patternedHolesSpacingYInput) return;
    const d = parseFloat(/** @type {HTMLInputElement} */ (patternedHolesDiameterInput).value);
    const sx = parseFloat(/** @type {HTMLInputElement} */ (patternedHolesSpacingXInput).value);
    const sy = parseFloat(/** @type {HTMLInputElement} */ (patternedHolesSpacingYInput).value);
    const isMft = Math.abs(d - 20.2) < 0.01 && Math.abs(sx - 96) < 0.01 && Math.abs(sy - 96) < 0.01;
    patternedHolesPresetSelect.value = isMft ? "mft" : "";
  }
  if (patternedHolesDiameterInput) patternedHolesDiameterInput.addEventListener("input", syncPatternedHolesPresetFromInputs);
  if (patternedHolesSpacingXInput) patternedHolesSpacingXInput.addEventListener("input", syncPatternedHolesPresetFromInputs);
  if (patternedHolesSpacingYInput) patternedHolesSpacingYInput.addEventListener("input", syncPatternedHolesPresetFromInputs);

  // Initiële sync zodat standaardwaarden (bijv. vierkant 50) in de preset-dropdown zichtbaar zijn
  if (squareSizeInput && squarePresetSelect) {
    const v = /** @type {HTMLInputElement} */ (squareSizeInput).value;
    if (["50", "100", "150"].includes(v)) squarePresetSelect.value = v;
  }
  syncRectPresetFromInputs();
  syncPatternedHolesPresetFromInputs();

  const letterModeSelect = /** @type {HTMLSelectElement} */ (document.getElementById("letter-mode"));
  const toolDiameterRow = document.getElementById("tool-diameter-row");
  const toolDiameterOutlineHint = document.getElementById("tool-diameter-outline-hint");
  function updateToolDiameterVisibility() {
    const isLettersOutline =
      shapeSelect.value === ShapeType.LETTERS &&
      (letterModeSelect?.value || "outline") === "outline";
    if (toolDiameterRow) {
      if (isLettersOutline) {
        toolDiameterRow.classList.add("hidden");
      } else {
        toolDiameterRow.classList.remove("hidden");
      }
    }
    if (toolDiameterOutlineHint) {
      if (isLettersOutline) {
        toolDiameterOutlineHint.classList.remove("hidden");
      } else {
        toolDiameterOutlineHint.classList.add("hidden");
      }
    }
    const toolDInput = /** @type {HTMLInputElement} */ (document.getElementById("tool-diameter"));
    if (toolDInput) {
      toolDInput.disabled = !!isLettersOutline;
      toolDInput.removeAttribute("required");
      if (!isLettersOutline) toolDInput.setAttribute("required", "");
    }
  }
  if (letterModeSelect) letterModeSelect.addEventListener("change", updateToolDiameterVisibility);
  updateToolDiameterVisibility();

  function updateContourTypeVisibility() {
    const op = operationSelect.value;
    const shape = shapeSelect.value;
    const showContour = op === OperationType.CONTOUR;
    const showFacing = shape === ShapeType.FACING;

    const contourOnlyElems = document.querySelectorAll(".contour-only");
    contourOnlyElems.forEach((el) => {
      if (showContour) {
        el.classList.remove("hidden");
      } else {
        el.classList.add("hidden");
      }
    });

    const facingOnlyElems = document.querySelectorAll(".facing-only");
    facingOnlyElems.forEach((el) => {
      if (showFacing) {
        el.classList.remove("hidden");
      } else {
        el.classList.add("hidden");
      }
    });

    // Bij wisselen naar niet-contour: tabs uitzetten en parameters verbergen; insteken naast part uit
    if (!showContour) {
      if (tabsEnabledCheckbox) {
        tabsEnabledCheckbox.checked = false;
        updateTabParamsVisibility();
      }
      if (plungeOutsideInput) {
        plungeOutsideInput.value = "off";
        plungeOutsideButtons.forEach((b) => {
          b.classList.toggle("entry-method-btn--active", b.dataset.plungeOutside === "off");
        });
      }
    }
    updateContourTabsRampHintVisibility();
  }
  operationSelect.addEventListener("change", updateContourTypeVisibility);
  updateContourTypeVisibility();

  const rampAngleInput = /** @type {HTMLInputElement} */ (document.getElementById("ramp-angle"));
  function updateRampInputsDisabled() {
    const rampVisible = rampSettings && !rampSettings.classList.contains("hidden");
    if (rampAngleInput) rampAngleInput.disabled = !rampVisible;
  }
  entryButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.dataset.entry;
      if (!value || !entryMethodInput) return;

      entryMethodInput.value = value;

      entryButtons.forEach((b) =>
        b.classList.remove("entry-method-btn--active")
      );
      btn.classList.add("entry-method-btn--active");

      if (value === EntryMethod.RAMP) {
        rampSettings.classList.remove("hidden");
      } else if (value === EntryMethod.PLUNGE) {
        rampSettings.classList.add("hidden");
      }
      updateRampInputsDisabled();
      updateContourTabsRampHintVisibility();
    });
  });
  // init zichtbaarheid ramp-instellingen op basis van huidige entry-method
  if (entryMethodInput && entryMethodInput.value === EntryMethod.RAMP) {
    rampSettings.classList.remove("hidden");
  } else {
    rampSettings.classList.add("hidden");
  }
  updateRampInputsDisabled();
  updateContourTabsRampHintVisibility();

  // Toggle-knoppen voor "Insteken naast part"
  plungeOutsideButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.dataset.plungeOutside;
      if (!value || !plungeOutsideInput) return;

      plungeOutsideInput.value = value;

      plungeOutsideButtons.forEach((b) =>
        b.classList.remove("entry-method-btn--active")
      );
      btn.classList.add("entry-method-btn--active");
    });
  });

  // Algemene stepper-knoppen: leest data-step/data-min/data-max bij elke klik (zodat stepover toggle werkt)
  const toolDiameterInput = /** @type {HTMLInputElement} */ (document.getElementById("tool-diameter"));
  const stepoverInput = /** @type {HTMLInputElement} */ (document.getElementById("stepover"));
  if (tabsEnabledCheckbox) {
    tabsEnabledCheckbox.addEventListener("change", updateTabParamsVisibility);
  }
  updateTabParamsVisibility();
  document.querySelectorAll(".input-with-stepper[data-step]").forEach((wrapper) => {
    const input = /** @type {HTMLInputElement} */ (wrapper.querySelector("input[type='number']"));
    const downBtn = wrapper.querySelector(".stepper-down");
    const upBtn = wrapper.querySelector(".stepper-up");
    if (!input || !downBtn || !upBtn) return;

    function getStepMinMax() {
      const step = parseFloat(/** @type {string} */ (wrapper.getAttribute("data-step")));
      const minAttr = wrapper.getAttribute("data-min");
      const maxAttr = wrapper.getAttribute("data-max");
      const min = minAttr === "" || minAttr === null ? -Infinity : parseFloat(minAttr);
      const max = maxAttr === "" || maxAttr === null ? Infinity : parseFloat(maxAttr);
      return { step: Number.isFinite(step) ? step : 1, min, max };
    }

    function applyDelta(delta) {
      const { step, min, max } = getStepMinMax();
      const decimals = step < 1 ? (String(step).split(".")[1]?.length || 2) : 0;
      const roundValue = (v) => decimals ? Math.round(v * Math.pow(10, decimals)) / Math.pow(10, decimals) : Math.round(v);
      const current = toNumber(input.value) || 0;
      const next = roundValue(current + delta);
      const clamped = Math.min(max, Math.max(min, next));
      input.value = String(clamped);
      if (input.id === "tool-diameter" || input.id === "stepover") updateStepoverHint();
    }

    downBtn.addEventListener("click", () => applyDelta(-getStepMinMax().step));
    upBtn.addEventListener("click", () => applyDelta(getStepMinMax().step));
  });

  // Stepover eenheid toggle: % ↔ mm, waarde omrekenen en input/wrapper aanpassen
  const stepoverWrapper = document.getElementById("stepover-input-wrapper");
  const stepoverUnitRadios = /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('input[name="stepover-unit"]'));
  stepoverUnitRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!stepoverInput || !stepoverWrapper || !toolDiameterInput) return;
      const d = toNumber(toolDiameterInput.value) || 6;
      const currentVal = toNumber(stepoverInput.value);
      if (radio.value === "mm") {
        const mm = Number.isFinite(currentVal) && d > 0 ? (currentVal / 100) * d : d * 0.5;
        stepoverInput.value = String(Math.round(mm * 100) / 100);
        stepoverInput.min = "0";
        stepoverInput.max = String(d);
        stepoverInput.step = "any";
        stepoverWrapper.setAttribute("data-step", "0.5");
        stepoverWrapper.setAttribute("data-min", "0");
        stepoverWrapper.setAttribute("data-max", String(d));
      } else {
        const pct = d > 0 && Number.isFinite(currentVal) ? Math.round((currentVal / d) * 100) : 50;
        stepoverInput.value = String(Math.min(100, Math.max(1, pct)));
        stepoverInput.min = "1";
        stepoverInput.max = "100";
        stepoverInput.step = "any";
        stepoverWrapper.setAttribute("data-step", "10");
        stepoverWrapper.setAttribute("data-min", "1");
        stepoverWrapper.setAttribute("data-max", "100");
      }
      updateStepoverHint();
    });
  });

  // Stepover-hint: in %-modus tonen we mm of in (d en val zijn altijd in display-eenheid), in mm/in-modus tonen we %
  const stepoverMmHint = document.getElementById("stepover-mm-hint");
  function updateStepoverHint() {
    if (!stepoverMmHint || !stepoverInput || !toolDiameterInput) return;
    const d = toNumber(toolDiameterInput.value);
    const val = toNumber(stepoverInput.value);
    const stepoverUnit = /** @type {HTMLInputElement} */ (document.querySelector('input[name="stepover-unit"]:checked'))?.value;
    const displayUnit = getDisplayUnit();
    if (!Number.isFinite(d) || !Number.isFinite(val)) {
      stepoverMmHint.textContent = "";
      return;
    }
    if (stepoverUnit === "percent" && d > 0) {
      const stepoverInDisplayUnit = (val / 100) * d;
      const showVal = displayUnit === "inch" ? stepoverInDisplayUnit.toFixed(3) : stepoverInDisplayUnit.toFixed(2);
      stepoverMmHint.textContent = displayUnit === "inch"
        ? t("form.stepoverInHint", { val: showVal })
        : t("form.stepoverMmHint", { val: showVal });
    } else if (stepoverUnit === "mm" && d > 0) {
      const pct = Math.round((val / d) * 100);
      stepoverMmHint.textContent = t("form.stepoverPctHint", { pct });
    } else {
      stepoverMmHint.textContent = "";
    }
  }
  if (toolDiameterInput) toolDiameterInput.addEventListener("input", () => { updateStepoverHint(); if (stepoverWrapper && stepoverInput) updateStepoverMaxWhenMm(); });
  if (stepoverInput) stepoverInput.addEventListener("input", updateStepoverHint);
  document.addEventListener("languagechange", updateStepoverHint);
  document.addEventListener("unitchange", updateStepoverHint);
  function updateStepoverMaxWhenMm() {
    const unit = /** @type {HTMLInputElement} */ (document.querySelector('input[name="stepover-unit"]:checked'))?.value;
    if (unit === "mm" && stepoverWrapper && stepoverInput && toolDiameterInput) {
      const d = toNumber(toolDiameterInput.value);
      if (Number.isFinite(d) && d > 0) {
        stepoverInput.max = String(d);
        stepoverWrapper.setAttribute("data-max", String(d));
        const current = toNumber(stepoverInput.value);
        if (current > d) {
          stepoverInput.value = String(d);
        }
      }
    }
  }
  updateStepoverHint();

  // Meerdere dieptes: stepdown-row tonen/verbergen; default stepdown = totale diepte / 2 (max laaghoogte)
  const multipleDepthsCheckbox = /** @type {HTMLInputElement} */ (document.getElementById("multiple-depths"));
  const stepdownRow = document.getElementById("stepdown-row");
  const totalDepthInput = /** @type {HTMLInputElement} */ (document.getElementById("total-depth"));
  const stepdownInput = /** @type {HTMLInputElement} */ (document.getElementById("stepdown"));
  function setDefaultStepdownFromTotalDepth() {
    if (!stepdownInput || !totalDepthInput) return;
    const depth = toNumber(totalDepthInput.value);
    if (Number.isFinite(depth) && depth > 0) {
      const defaultStepdown = Math.round((depth / 2) * 100) / 100;
      stepdownInput.value = String(defaultStepdown);
    }
  }
  function updateStepdownVisibility() {
    if (!stepdownRow || !multipleDepthsCheckbox) return;
    if (multipleDepthsCheckbox.checked) {
      stepdownRow.classList.remove("hidden");
      setDefaultStepdownFromTotalDepth();
    } else {
      stepdownRow.classList.add("hidden");
    }
  }
  if (multipleDepthsCheckbox) {
    function onMultipleDepthsToggle() {
      setTimeout(updateStepdownVisibility, 0);
    }
    multipleDepthsCheckbox.addEventListener("change", onMultipleDepthsToggle);
    multipleDepthsCheckbox.addEventListener("click", onMultipleDepthsToggle);
  }
  updateStepdownVisibility();

  // Preview-weergave knoppen
  viewButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.view;
      if (!mode) return;
      currentPreviewView = /** @type {keyof typeof PreviewViewMode} */ (mode);

      viewButtons.forEach((b) => b.classList.remove("preview-view-btn--active"));
      btn.classList.add("preview-view-btn--active");

      renderPreview(lastToolpath, previewCanvas, currentPreviewView, getDisplayedColumn());
    });
  });

  // Kolom in preview op het punt van de gcode-regel waar de cursor staat (diameter = freesdikte, hoogte 50 mm)
  let cursorColumnForPreview = null;

  // Playback: gcode van boven naar beneden doorlopen met freespositie in preview
  const GCODE_HEADER_LINES = 5; // aantal regels vóór de eerste beweging in gegenereerde gcode
  let playbackMoveIndex = 0;
  let isPlaying = false;
  let playbackTimeoutId = null;
  let playbackSpeedMultiplier = 1; // 0.5–15× feedrate

  /**
   * Berekent de preview-duur in ms voor het segment van move index naar index+1.
   * @param {ToolpathMove[]} moves
   * @param {number} index
   * @param {number} feedrateMmMin
   * @param {number} speedMultiplier
   * @returns {number}
   */
  function getSegmentDurationMs(moves, index, feedrateMmMin, speedMultiplier) {
    if (index + 1 >= moves.length) return 0;
    const prev = moves[index];
    const next = moves[index + 1];
    const dx = (Number.isFinite(next.x) ? next.x : 0) - (Number.isFinite(prev.x) ? prev.x : 0);
    const dy = (Number.isFinite(next.y) ? next.y : 0) - (Number.isFinite(prev.y) ? prev.y : 0);
    const dz = (Number.isFinite(next.z) ? next.z : 0) - (Number.isFinite(prev.z) ? prev.z : 0);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const feedrate = next.type === "cut" ? (feedrateMmMin > 0 ? feedrateMmMin : 800) : DEFAULT_RAPID_FEEDRATE_MM_MIN;
    const tijdMs = (d * 60000) / feedrate;
    return Math.max(1, tijdMs / speedMultiplier);
  }

  function getDisplayedColumn() {
    if (isPlaying && lastToolpath.moves.length > 0 && playbackMoveIndex < lastToolpath.moves.length) {
      const m = lastToolpath.moves[playbackMoveIndex];
      const isLettersOutline = shapeSelect.value === ShapeType.LETTERS && (letterModeSelect?.value || "outline") === "outline";
      const diameter = isLettersOutline ? 0.5 : (toolDiameterInput ? toNumber(toolDiameterInput.value) || 6 : 6);
      return { x: m.x, y: m.y, z: m.z, diameter };
    }
    return cursorColumnForPreview;
  }

  function syncGcodeCursorToPlayback() {
    if (!gcodeOutput || !gcodeOutput.value) return;
    const lines = gcodeOutput.value.split("\n");
    const lineIndex = GCODE_HEADER_LINES + playbackMoveIndex;
    if (lineIndex < 0 || lineIndex >= lines.length) return;
    let offset = 0;
    for (let j = 0; j < lineIndex && j < lines.length; j++) offset += lines[j].length + 1;
    gcodeOutput.selectionStart = gcodeOutput.selectionEnd = offset;
    gcodeOutput.focus();
    updateGcodeLineHighlight();
  }

  function getCurrentLineIndex() {
    if (!gcodeOutput) return 0;
    const text = gcodeOutput.value;
    if (isPlaying && lastToolpath.moves.length > 0) {
      return Math.min(GCODE_HEADER_LINES + playbackMoveIndex, text.split("\n").length - 1);
    }
    const pos = gcodeOutput.selectionStart;
    return Math.max(0, text.substring(0, pos).split("\n").length - 1);
  }

  function getGcodePaddingTop() {
    if (!gcodeOutput) return 8;
    const pt = getComputedStyle(gcodeOutput).paddingTop;
    const px = parseFloat(pt);
    return Number.isFinite(px) ? px : 8;
  }

  function getGcodePaddingBottom() {
    if (!gcodeOutput) return 8;
    const pb = getComputedStyle(gcodeOutput).paddingBottom;
    const px = parseFloat(pb);
    return Number.isFinite(px) ? px : 8;
  }

  /**
   * Berekent de effectieve regelhoogte uit de echte scrollHeight van de textarea,
   * zodat er geen cumulatieve afrondingsfout ontstaat (geen scheeflopen bij veel regels).
   */
  function getGcodeEffectiveLineHeight(lineCount) {
    if (!gcodeOutput || lineCount <= 0) return 18;
    const paddingTop = getGcodePaddingTop();
    const paddingBottom = getGcodePaddingBottom();
    const contentHeight = gcodeOutput.scrollHeight - paddingTop - paddingBottom;
    const lineHeight = contentHeight / lineCount;
    return lineHeight > 0 ? lineHeight : 18;
  }

  function updateGcodeLineHighlight() {
    if (!gcodeOutput || !gcodeLineHighlightInner || !gcodeLineHighlightBar) return;
    const text = gcodeOutput.value;
    const lines = text.split("\n");
    const lineCount = lines.length;
    const paddingTop = getGcodePaddingTop();
    const lineHeight = getGcodeEffectiveLineHeight(lineCount);
    const lineIndex = getCurrentLineIndex();

    gcodeLineHighlightInner.style.height = `${gcodeOutput.scrollHeight}px`;

    if (lineCount === 0) {
      gcodeLineHighlightBar.style.display = "none";
      syncGcodeOverlayScroll();
      return;
    }
    gcodeLineHighlightBar.style.display = "block";
    const clampedIndex = Math.max(0, Math.min(lineIndex, lineCount - 1));
    gcodeLineHighlightBar.style.top = `${paddingTop + clampedIndex * lineHeight}px`;
    gcodeLineHighlightBar.style.height = `${lineHeight}px`;

    // Mee scrollen met preview: actieve regel zichtbaar houden (grofweg gecentreerd)
    const targetScrollTop = Math.max(
      0,
      paddingTop + clampedIndex * lineHeight - gcodeOutput.clientHeight / 2 + lineHeight / 2
    );
    gcodeOutput.scrollTop = Math.round(targetScrollTop);
    syncGcodeOverlayScroll();
  }

  function syncGcodeOverlayScroll() {
    if (gcodeLineHighlightInner && gcodeOutput) {
      gcodeLineHighlightInner.style.transform = `translateY(-${gcodeOutput.scrollTop}px)`;
    }
  }

  function stopPlayback() {
    isPlaying = false;
    if (playbackTimeoutId !== null) {
      clearTimeout(playbackTimeoutId);
      playbackTimeoutId = null;
    }
    if (previewCanvas) renderPreview(lastToolpath, previewCanvas, currentPreviewView, getDisplayedColumn());
  }

  function scheduleNextPlaybackStep() {
    if (!isPlaying || !lastToolpath.moves.length) return;
    const feedrateInput = document.getElementById("feedrate");
    const feedrate =
      feedrateInput && feedrateInput instanceof HTMLInputElement
        ? toNumber(feedrateInput.value) || 800
        : 800;
    const delay = getSegmentDurationMs(lastToolpath.moves, playbackMoveIndex, feedrate, playbackSpeedMultiplier);
    if (delay > 0) {
      playbackTimeoutId = setTimeout(advancePlayback, delay);
    }
  }

  function advancePlayback() {
    if (!lastToolpath.moves.length) return;
    playbackMoveIndex++;
    if (playbackMoveIndex >= lastToolpath.moves.length) {
      playbackMoveIndex = lastToolpath.moves.length - 1;
      stopPlayback();
      updatePlaybackButtonsState();
      return;
    }
    syncGcodeCursorToPlayback();
    if (previewCanvas) renderPreview(lastToolpath, previewCanvas, currentPreviewView, getDisplayedColumn());
    scheduleNextPlaybackStep();
  }

  const playPauseBtn = /** @type {HTMLButtonElement} */ (document.getElementById("preview-play-pause-btn"));
  const resetBtn = /** @type {HTMLButtonElement} */ (document.getElementById("preview-reset-btn"));
  const speedSlider = /** @type {HTMLInputElement} */ (document.getElementById("preview-speed"));
  const speedValueEl = document.getElementById("preview-speed-value");

  // Snelheidsslider: 0.2, 0.5, 1, 1.5, 2, 3, 5, 7, 10, 15
  const ALLOWED_MULTIPLIERS = [0.2, 0.5, 1, 1.5, 2, 3, 5, 7, 10, 15];
  const MULTIPLIER_DEFAULT = 1;

  function speedSliderToMultiplier(norm) {
    const n = Number.isFinite(norm) ? norm : 0;
    const index = Math.round(n * (ALLOWED_MULTIPLIERS.length - 1));
    return ALLOWED_MULTIPLIERS[Math.max(0, Math.min(index, ALLOWED_MULTIPLIERS.length - 1))];
  }

  function speedMultiplierToSlider(value) {
    let bestIndex = 0;
    let bestDist = Math.abs(ALLOWED_MULTIPLIERS[0] - value);
    for (let i = 1; i < ALLOWED_MULTIPLIERS.length; i++) {
      const d = Math.abs(ALLOWED_MULTIPLIERS[i] - value);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }
    return bestIndex / (ALLOWED_MULTIPLIERS.length - 1);
  }

  function formatMultiplierForDisplay(value) {
    return `${value}×`;
  }

  if (speedSlider) {
    speedSlider.min = "0";
    speedSlider.max = "1";
    speedSlider.step = String(1 / (ALLOWED_MULTIPLIERS.length - 1));
    speedSlider.value = String(speedMultiplierToSlider(MULTIPLIER_DEFAULT));
    if (speedValueEl) speedValueEl.textContent = formatMultiplierForDisplay(MULTIPLIER_DEFAULT);
    playbackSpeedMultiplier = MULTIPLIER_DEFAULT;
  }

  if (playPauseBtn) {
    playPauseBtn.addEventListener("click", () => {
      if (!lastToolpath.moves.length) return;
      if (isPlaying) {
        stopPlayback();
      } else {
        isPlaying = true;
        if (playbackMoveIndex >= lastToolpath.moves.length) playbackMoveIndex = 0;
        syncGcodeCursorToPlayback();
        if (previewCanvas) renderPreview(lastToolpath, previewCanvas, currentPreviewView, getDisplayedColumn());
        scheduleNextPlaybackStep();
      }
      updatePlaybackButtonsState();
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (!lastToolpath.moves.length) return;
      playbackMoveIndex = 0;
      stopPlayback();
      syncGcodeCursorToPlayback();
      if (previewCanvas) renderPreview(lastToolpath, previewCanvas, currentPreviewView, getDisplayedColumn());
      updatePlaybackButtonsState();
    });
  }
  if (speedSlider) {
    speedSlider.addEventListener("input", () => {
      const norm = Number(speedSlider.value);
      playbackSpeedMultiplier = speedSliderToMultiplier(norm);
      speedSlider.value = String(speedMultiplierToSlider(playbackSpeedMultiplier));
      if (speedValueEl) speedValueEl.textContent = formatMultiplierForDisplay(playbackSpeedMultiplier);
      if (isPlaying && playbackTimeoutId !== null) {
        clearTimeout(playbackTimeoutId);
        playbackTimeoutId = null;
        scheduleNextPlaybackStep();
      }
    });
  }

  function updatePreviewWithCursorPoint() {
    if (!gcodeOutput || !previewCanvas) return;
    const text = gcodeOutput.value;
    const pos = gcodeOutput.selectionStart;
    const lineIndex = text.substring(0, pos).split("\n").length - 1;
    const lines = text.split("\n");
    const line = lines[lineIndex] ?? "";
    let point = parseGcodeLineForPoint(line);
    if (point) {
      const gcodeUnit = getGcodeUnitFromText(text);
      if (gcodeUnit === "inch") {
        point = {
          x: toMm(point.x, "inch"),
          y: toMm(point.y, "inch"),
          z: toMm(point.z, "inch"),
        };
      }
      const isLettersOutline = shapeSelect.value === ShapeType.LETTERS && (letterModeSelect?.value || "outline") === "outline";
      const diameter = isLettersOutline ? 0.5 : (toolDiameterInput ? toNumber(toolDiameterInput.value) || 6 : 6);
      cursorColumnForPreview = {
        ...point,
        diameter,
      };
    } else {
      cursorColumnForPreview = null;
    }
    renderPreview(lastToolpath, previewCanvas, currentPreviewView, getDisplayedColumn());
    updateGcodeLineHighlight();
  }

  function clearPreviewCursorPoint() {
    cursorColumnForPreview = null;
    if (previewCanvas) renderPreview(lastToolpath, previewCanvas, currentPreviewView, getDisplayedColumn());
  }

  function updatePlaybackButtonsState() {
    const hasMoves = lastToolpath.moves.length > 0;
    if (playPauseBtn) {
      playPauseBtn.disabled = !hasMoves;
      playPauseBtn.textContent = isPlaying ? t("preview.pause") : t("preview.play");
    }
    if (resetBtn) resetBtn.disabled = !hasMoves;
  }
  document.addEventListener("languagechange", updatePlaybackButtonsState);

  if (gcodeOutput) {
    gcodeOutput.addEventListener("focus", updatePreviewWithCursorPoint);
    gcodeOutput.addEventListener("blur", clearPreviewCursorPoint);
    gcodeOutput.addEventListener("keyup", updatePreviewWithCursorPoint);
    gcodeOutput.addEventListener("click", updatePreviewWithCursorPoint);
    gcodeOutput.addEventListener("input", updatePreviewWithCursorPoint);
    gcodeOutput.addEventListener("scroll", syncGcodeOverlayScroll);
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (errorMessage) errorMessage.textContent = "";

    try {
      const raw = readInputsFromForm();
      const validation = validateInputs(raw);
      if (!validation.ok) {
        if (errorMessage) errorMessage.textContent = validation.errors.join(" ");
        if (gcodeOutput) gcodeOutput.value = "";
        const gcodeEstimateEl = document.getElementById("gcode-estimate");
        if (gcodeEstimateEl) gcodeEstimateEl.textContent = "";
        if (downloadBtn) downloadBtn.disabled = true;
        if (copyBtn) copyBtn.disabled = true;
        lastToolpath = { moves: [] };
        stopPlayback();
        playbackMoveIndex = 0;
        updatePlaybackButtonsState();
        if (previewCanvas) renderPreview(lastToolpath, previewCanvas, currentPreviewView);
        updateGcodeLineHighlight();
        return;
      }

      if (validation.params.shape === ShapeType.LETTERS) {
        try {
          validation.params.letterFont = await loadLetterFont();
        } catch (fontErr) {
          const msg = fontErr instanceof Error ? fontErr.message : String(fontErr);
          if (errorMessage) errorMessage.textContent = msg;
          return;
        }
      }

      const toolpath = generateToolpath(validation.params);
      lastToolpath = toolpath;
      const gcode = toolpathToGcode(toolpath, validation.params);

      stopPlayback();
      playbackMoveIndex = 0;
      updatePlaybackButtonsState();

      if (gcodeOutput) {
        gcodeOutput.value = gcode;
        gcodeOutput.scrollIntoView({ behavior: "smooth", block: "nearest" });
        updateGcodeLineHighlight();
      }
      const gcodeEstimateEl = document.getElementById("gcode-estimate");
      if (gcodeEstimateEl) {
        const est = estimateMillingTime(toolpath, validation.params.cutParams);
        gcodeEstimateEl.textContent = t("preview.estimatedTime", {
          time: formatEstimatedTime(est.totalMinutes),
        });
      }
      if (previewCanvas) renderPreview(toolpath, previewCanvas, currentPreviewView, getDisplayedColumn());

      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.onclick = () => {
          const now = new Date();
          const ts = `${now.getFullYear()}-${String(
            now.getMonth() + 1
          ).padStart(2, "0")}-${String(now.getDate()          ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
            now.getMinutes()
          ).padStart(2, "0")}`;
          const filename =
          raw.shape === ShapeType.LETTERS
            ? `gcode_letters_${ts}.nc`
            : `gcode_${raw.shape}_${raw.operation}_${ts}.nc`;
          downloadGcode(filename, gcode);
        };
      }
      if (copyBtn) {
        copyBtn.disabled = false;
        copyBtn.onclick = () => {
          copyGcodeToClipboard(gcode);
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (errorMessage) errorMessage.textContent = t("error.generateFailed") + msg;
    }
  });

  // init defaults
  shapeSelect.dispatchEvent(new Event("change"));

  // lege preview
  lastToolpath = { moves: [] };
  updatePlaybackButtonsState();
  renderPreview(lastToolpath, previewCanvas, currentPreviewView);
}

document.addEventListener("DOMContentLoaded", setupUI);

