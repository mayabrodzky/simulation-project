/**
 * Building HTML safely.
 *
 * The UI builds markup from template strings and assigns it with innerHTML,
 * which parses its input as HTML rather than treating it as text. Any value
 * that came from a person — a staff name, a business name, a task title, all of
 * which arrive from the onboarding form by way of the database — could
 * therefore close a tag and open a new one. A business named
 * `<img src=x onerror=…>` executes. That is stored XSS: persistent, and it
 * fires in the browser of whoever views it rather than whoever typed it.
 *
 * `html` escapes every interpolated value by default. The guarantee is enforced
 * by the type system rather than by remembering: it returns a branded `Raw`,
 * and `setHtml` accepts nothing else, so an unescaped string cannot reach
 * innerHTML by accident. Deliberately-trusted markup has to say so, by being
 * another `html` result or by going through `raw()`.
 *
 * Why not a framework: the escaping guarantee is identical to lit-html's or
 * Preact's, but those would mean rewriting every template and risking visual
 * drift across eighteen call sites. This produces the same string the existing
 * code already produces, so the conversion is mechanical and the output is
 * unchanged.
 *
 * Two rules this does NOT cover, so they are written down instead:
 *   1. Only interpolate into text or *quoted* attribute positions. Escaping
 *      quotes does not make `href="${x}"` safe against `javascript:` URLs, nor
 *      `style="${x}"` safe against CSS injection.
 *   2. Never interpolate into a <script> context.
 */

const RAW = Symbol('raw-html');

export interface Raw {
  readonly [RAW]: string;
}

/** Marks a string as already-safe markup. Every use is a deliberate decision. */
export function raw(markup: string): Raw {
  return { [RAW]: markup };
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(stringify).join('');
  if (typeof value === 'object' && RAW in value) return (value as Raw)[RAW];
  return escapeHtml(value);
}

/**
 * Tagged template that escapes its interpolations.
 *
 * Nested `html` results pass through unescaped, and arrays are flattened, so
 * `${items.map((i) => html`<li>${i}</li>`)}` works without a join.
 */
export function html(parts: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = parts[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += stringify(values[i]) + (parts[i + 1] ?? '');
  }
  return raw(out);
}

/** The only sanctioned way to write markup into the document. */
export function setHtml(target: Element | null, content: Raw): void {
  if (!target) return;
  target.innerHTML = content[RAW];
}

/** Appends, for the few places that build a list incrementally. */
export function appendHtml(target: Element | null, content: Raw): void {
  if (!target) return;
  target.insertAdjacentHTML('beforeend', content[RAW]);
}

export function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}
