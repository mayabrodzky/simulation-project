/**
 * The permanent proof that the stored-XSS hole is closed.
 *
 * This replaces a screenshot. The "before" was demonstrated by hand — a staff
 * name containing an <img onerror> tag popped an alert — but a screenshot
 * cannot fail a build. These assertions run on every commit, and would fail the
 * moment someone reintroduces raw interpolation.
 */
import { describe, expect, it } from 'vitest';
import { escapeHtml, html, raw, toHtmlString as render } from './dom';

const PAYLOAD = '<img src=x onerror="alert(1)">';

describe('escapeHtml', () => {
  it('neutralises every character that can change HTML structure', () => {
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes the ampersand so an escape cannot be smuggled through', () => {
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });
});

describe('html', () => {
  it('renders the real attack payload as text, not as a tag', () => {
    const out = render(html`<span class="staff-name">${PAYLOAD}</span>`);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).toContain('onerror=&quot;alert(1)&quot;');
  });

  it('keeps the surrounding markup intact', () => {
    const out = render(html`<span class="staff-name">${PAYLOAD}</span>`);
    expect(out.startsWith('<span class="staff-name">')).toBe(true);
    expect(out.endsWith('</span>')).toBe(true);
  });

  it('escapes a value interpolated into a quoted attribute', () => {
    const out = render(html`<div title="${'" onmouseover="alert(1)'}"></div>`);
    expect(out).toBe('<div title="&quot; onmouseover=&quot;alert(1)"></div>');
  });

  it('leaves nested templates unescaped, so composition works', () => {
    const inner = html`<b>${'A & B'}</b>`;
    expect(render(html`<p>${inner}</p>`)).toBe('<p><b>A &amp; B</b></p>');
  });

  it('flattens arrays, which is what replaced the old .join(fragments)', () => {
    const tags = ['A', 'B'].map((s) => html`<span>${s}</span>`);
    expect(render(html`<div>${tags}</div>`)).toBe('<div><span>A</span><span>B</span></div>');
  });

  it('renders null, undefined and false as nothing rather than as words', () => {
    expect(render(html`[${null}${undefined}${false}]`)).toBe('[]');
  });

  it('still escapes a value that merely looks like safe markup', () => {
    expect(render(html`<p>${'<b>bold</b>'}</p>`)).toBe('<p>&lt;b&gt;bold&lt;/b&gt;</p>');
  });

  it('lets trusted markup through only when it says so explicitly', () => {
    expect(render(html`<p>${raw('<b>bold</b>')}</p>`)).toBe('<p><b>bold</b></p>');
  });
});
