/**
 * Icon glyphs drawn onto the 3D node sprites.
 *
 * Hand-drawn on a 2D canvas rather than loaded as image files, for two reasons.
 * The Architecture tab has to render with no backend and no network — a missing
 * logo mid-demo is worse than a simplified one. And brand SVGs are trademarked
 * artwork; a recognisable glyph in the product's own colour identifies the
 * technology without redistributing someone's mark.
 *
 * Each icon is drawn into a unit box from (0,0) to (1,1) and scaled by the
 * caller, so adding one means describing a shape, not matching a coordinate
 * system.
 */

export type IconKey =
  | "user"
  | "assistant"
  | "browser"
  | "gateway"
  | "shield"
  | "brain"
  | "chip"
  | "database"
  | "archive"
  | "chart"
  | "ledger"
  | "cluster"
  | "cache"
  | "scissors"
  | "loop"
  | "thumb"
  | "compare"
  | "layers";

type Draw = (ctx: CanvasRenderingContext2D, s: number) => void;

/**
 * A stroked path helper. `s` is the box size, so every coordinate below reads
 * as a fraction of the icon regardless of the resolution it is rendered at.
 */
const stroke =
  (draw: (ctx: CanvasRenderingContext2D, s: number) => void): Draw =>
  (ctx, s) => {
    ctx.lineWidth = s * 0.085;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    draw(ctx, s);
  };

export const ICONS: Record<IconKey, Draw> = {
  // A person: the customer asking the question.
  user: stroke((ctx, s) => {
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.33, s * 0.17, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s * 0.2, s * 0.85);
    ctx.quadraticCurveTo(s * 0.5, s * 0.55, s * 0.8, s * 0.85);
    ctx.stroke();
  }),

  // The AI assistant itself: a head, with the antenna and the eyes that read as
  // "bot" instantly. Paired opposite the human `user` glyph, so the first two
  // nodes of the pipeline say "person asks, assistant answers" without a label.
  assistant: stroke((ctx, s) => {
    // Antenna.
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.2);
    ctx.lineTo(s * 0.5, s * 0.1);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.08, s * 0.055, 0, Math.PI * 2);
    ctx.fill();

    // Head.
    ctx.beginPath();
    ctx.roundRect(s * 0.18, s * 0.22, s * 0.64, s * 0.5, s * 0.14);
    ctx.stroke();

    // Eyes.
    ctx.beginPath();
    ctx.arc(s * 0.37, s * 0.45, s * 0.055, 0, Math.PI * 2);
    ctx.arc(s * 0.63, s * 0.45, s * 0.055, 0, Math.PI * 2);
    ctx.fill();

    // Mouth.
    ctx.beginPath();
    ctx.moveTo(s * 0.38, s * 0.59);
    ctx.lineTo(s * 0.62, s * 0.59);
    ctx.stroke();

    // Ears.
    ctx.beginPath();
    ctx.moveTo(s * 0.18, s * 0.4);
    ctx.lineTo(s * 0.09, s * 0.4);
    ctx.lineTo(s * 0.09, s * 0.54);
    ctx.lineTo(s * 0.18, s * 0.54);
    ctx.moveTo(s * 0.82, s * 0.4);
    ctx.lineTo(s * 0.91, s * 0.4);
    ctx.lineTo(s * 0.91, s * 0.54);
    ctx.lineTo(s * 0.82, s * 0.54);
    ctx.stroke();
  }),

  // A browser window: the assistant UI the customer talks to.
  browser: stroke((ctx, s) => {
    ctx.strokeRect(s * 0.13, s * 0.2, s * 0.74, s * 0.6);
    ctx.beginPath();
    ctx.moveTo(s * 0.13, s * 0.37);
    ctx.lineTo(s * 0.87, s * 0.37);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s * 0.23, s * 0.285, s * 0.028, 0, Math.PI * 2);
    ctx.arc(s * 0.33, s * 0.285, s * 0.028, 0, Math.PI * 2);
    ctx.fill();
  }),

  // A gate: the single public entrance.
  gateway: stroke((ctx, s) => {
    ctx.beginPath();
    ctx.moveTo(s * 0.16, s * 0.84);
    ctx.lineTo(s * 0.16, s * 0.3);
    ctx.moveTo(s * 0.84, s * 0.84);
    ctx.lineTo(s * 0.84, s * 0.3);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s * 0.1, s * 0.3);
    ctx.lineTo(s * 0.9, s * 0.3);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s * 0.38, s * 0.84);
    ctx.lineTo(s * 0.38, s * 0.5);
    ctx.moveTo(s * 0.62, s * 0.84);
    ctx.lineTo(s * 0.62, s * 0.5);
    ctx.stroke();
  }),

  // A shield: injection defence.
  shield: stroke((ctx, s) => {
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.14);
    ctx.lineTo(s * 0.83, s * 0.28);
    ctx.lineTo(s * 0.83, s * 0.52);
    ctx.quadraticCurveTo(s * 0.83, s * 0.76, s * 0.5, s * 0.87);
    ctx.quadraticCurveTo(s * 0.17, s * 0.76, s * 0.17, s * 0.52);
    ctx.lineTo(s * 0.17, s * 0.28);
    ctx.closePath();
    ctx.stroke();
  }),

  // Retrieval: a magnifier over a page.
  brain: stroke((ctx, s) => {
    ctx.strokeRect(s * 0.18, s * 0.14, s * 0.46, s * 0.6);
    ctx.beginPath();
    ctx.arc(s * 0.62, s * 0.62, s * 0.19, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s * 0.76, s * 0.76);
    ctx.lineTo(s * 0.88, s * 0.88);
    ctx.stroke();
  }),

  // A processor die: the model weights themselves.
  chip: stroke((ctx, s) => {
    ctx.strokeRect(s * 0.26, s * 0.26, s * 0.48, s * 0.48);
    ctx.strokeRect(s * 0.4, s * 0.4, s * 0.2, s * 0.2);
    ctx.beginPath();
    for (const t of [0.36, 0.5, 0.64]) {
      ctx.moveTo(s * t, s * 0.26);
      ctx.lineTo(s * t, s * 0.13);
      ctx.moveTo(s * t, s * 0.74);
      ctx.lineTo(s * t, s * 0.87);
      ctx.moveTo(s * 0.26, s * t);
      ctx.lineTo(s * 0.13, s * t);
      ctx.moveTo(s * 0.74, s * t);
      ctx.lineTo(s * 0.87, s * t);
    }
    ctx.stroke();
  }),

  // The universal database cylinder.
  database: stroke((ctx, s) => {
    ctx.beginPath();
    ctx.ellipse(s * 0.5, s * 0.26, s * 0.31, s * 0.12, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s * 0.19, s * 0.26);
    ctx.lineTo(s * 0.19, s * 0.74);
    ctx.moveTo(s * 0.81, s * 0.26);
    ctx.lineTo(s * 0.81, s * 0.74);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(s * 0.5, s * 0.5, s * 0.31, s * 0.12, 0, 0, Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(s * 0.5, s * 0.74, s * 0.31, s * 0.12, 0, 0, Math.PI);
    ctx.stroke();
  }),

  // A box: versioned artifacts.
  archive: stroke((ctx, s) => {
    ctx.strokeRect(s * 0.16, s * 0.3, s * 0.68, s * 0.5);
    ctx.beginPath();
    ctx.moveTo(s * 0.12, s * 0.3);
    ctx.lineTo(s * 0.88, s * 0.3);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s * 0.4, s * 0.48);
    ctx.lineTo(s * 0.6, s * 0.48);
    ctx.stroke();
  }),

  // A rising chart: metrics and dashboards.
  chart: stroke((ctx, s) => {
    ctx.beginPath();
    ctx.moveTo(s * 0.16, s * 0.16);
    ctx.lineTo(s * 0.16, s * 0.82);
    ctx.lineTo(s * 0.86, s * 0.82);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s * 0.28, s * 0.66);
    ctx.lineTo(s * 0.46, s * 0.44);
    ctx.lineTo(s * 0.6, s * 0.56);
    ctx.lineTo(s * 0.8, s * 0.28);
    ctx.stroke();
  }),

  // Chained links: the tamper-evident audit log.
  ledger: stroke((ctx, s) => {
    ctx.beginPath();
    ctx.ellipse(s * 0.36, s * 0.5, s * 0.2, s * 0.13, -Math.PI / 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(s * 0.64, s * 0.5, s * 0.2, s * 0.13, -Math.PI / 5, 0, Math.PI * 2);
    ctx.stroke();
  }),

  // A hub with spokes: the orchestrator.
  cluster: stroke((ctx, s) => {
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.5, s * 0.13, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI * 2 * i) / 6 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(s * (0.5 + Math.cos(a) * 0.17), s * (0.5 + Math.sin(a) * 0.17));
      ctx.lineTo(s * (0.5 + Math.cos(a) * 0.36), s * (0.5 + Math.sin(a) * 0.36));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s * (0.5 + Math.cos(a) * 0.4), s * (0.5 + Math.sin(a) * 0.4), s * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
  }),

  // Stacked memory pages: the KV cache.
  cache: stroke((ctx, s) => {
    for (const [i, y] of [0.24, 0.44, 0.64].entries()) {
      ctx.strokeRect(s * (0.2 + i * 0.02), s * y, s * 0.6, s * 0.14);
    }
  }),

  // Cut weights: pruning.
  scissors: stroke((ctx, s) => {
    ctx.beginPath();
    ctx.arc(s * 0.26, s * 0.74, s * 0.12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s * 0.74, s * 0.74, s * 0.12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s * 0.33, s * 0.65);
    ctx.lineTo(s * 0.72, s * 0.18);
    ctx.moveTo(s * 0.67, s * 0.65);
    ctx.lineTo(s * 0.28, s * 0.18);
    ctx.stroke();
  }),

  // A closed cycle: the improvement loop. The only shape in the set that
  // returns to where it started, which is exactly what distinguishes it.
  loop: stroke((ctx, s) => {
    // Two opposing half-arcs with arrowheads, not one nearly-closed circle:
    // a single arc with a small gap renders as the letter C at node size, which
    // is what the first attempt looked like on screen.
    const r = s * 0.3;
    const c = s * 0.5;

    ctx.beginPath();
    ctx.arc(c, c, r, Math.PI * 0.95, Math.PI * 1.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, r, Math.PI * -0.05, Math.PI * 0.85);
    ctx.stroke();

    // An arrowhead at the open end of each arc, pointing the way round.
    const head = (angle: number, direction: number) => {
      const x = c + Math.cos(angle) * r;
      const y = c + Math.sin(angle) * r;
      // Tangent at the arc's end, which is where the arrow must point.
      const t = angle + (direction * Math.PI) / 2;
      const size = s * 0.13;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(t) * size, y + Math.sin(t) * size);
      ctx.lineTo(
        x + Math.cos(t + 2.4) * size * 0.9,
        y + Math.sin(t + 2.4) * size * 0.9,
      );
      ctx.lineTo(
        x + Math.cos(t - 2.4) * size * 0.9,
        y + Math.sin(t - 2.4) * size * 0.9,
      );
      ctx.closePath();
      ctx.fill();
    };

    head(Math.PI * 1.85, 1);
    head(Math.PI * 0.85, 1);
  }),

  // A thumbs-up: the feedback control itself.
  thumb: stroke((ctx, s) => {
    ctx.beginPath();
    ctx.roundRect(s * 0.12, s * 0.46, s * 0.2, s * 0.4, s * 0.04);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s * 0.38, s * 0.86);
    ctx.lineTo(s * 0.38, s * 0.48);
    ctx.lineTo(s * 0.52, s * 0.14);
    ctx.quadraticCurveTo(s * 0.68, s * 0.12, s * 0.64, s * 0.34);
    ctx.lineTo(s * 0.6, s * 0.46);
    ctx.lineTo(s * 0.84, s * 0.46);
    ctx.quadraticCurveTo(s * 0.92, s * 0.5, s * 0.86, s * 0.86);
    ctx.closePath();
    ctx.stroke();
  }),

  // Two panels side by side: the A/B comparison.
  compare: stroke((ctx, s) => {
    ctx.strokeRect(s * 0.1, s * 0.24, s * 0.34, s * 0.52);
    ctx.strokeRect(s * 0.56, s * 0.24, s * 0.34, s * 0.52);
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.16);
    ctx.lineTo(s * 0.5, s * 0.84);
    ctx.stroke();
  }),

  // Interleaved bars: continuous batching.
  layers: stroke((ctx, s) => {
    const rows: [number, number, number][] = [
      [0.16, 0.24, 0.5],
      [0.3, 0.42, 0.42],
      [0.16, 0.6, 0.66],
      [0.36, 0.78, 0.34],
    ];
    for (const [x, y, w] of rows) {
      ctx.beginPath();
      ctx.moveTo(s * x, s * y);
      ctx.lineTo(s * (x + w), s * y);
      ctx.stroke();
    }
  }),
};

export function drawIcon(
  ctx: CanvasRenderingContext2D,
  key: IconKey,
  size: number,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ICONS[key](ctx, size);
  ctx.restore();
}
