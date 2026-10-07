/**
 * Event delegation.
 *
 * One listener on the root, dispatching on a `data-action` attribute, rather
 * than a handler attached to each element. That is not a style preference
 * here: the panels are rebuilt by assigning innerHTML, which destroys their
 * child nodes, so any listener attached to a generated element would be
 * silently dropped on the next rebuild. A single listener on an ancestor
 * survives every re-render.
 *
 * It also replaces the inline `onclick="Lab.foo()"` attributes, which only
 * worked because the simulation object happened to be global. Those are gone,
 * and with them the last reason for it to be.
 */

export type ActionHandler = (element: HTMLElement, event: Event) => void;

/**
 * `closest` returns the *innermost* matching ancestor, which gives correct
 * behaviour for free where the old code needed `event.stopPropagation()`: the
 * Save button sits inside a panel header that toggles on click, and the button
 * wins because it is the nearer match. Delegation is simpler here, not merely
 * equivalent.
 */
export function installActions(root: ParentNode, handlers: Record<string, ActionHandler>): void {
  root.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const element = target.closest<HTMLElement>('[data-action]');
    if (!element) return;
    const action = element.dataset.action;
    if (!action) return;
    const handler = handlers[action];
    if (handler) handler(element, event);
  });
}

/**
 * Hover, delegated.
 *
 * mouseenter and mouseleave do not bubble, so they cannot be delegated at all.
 * mouseover and mouseout do, but they also fire when the pointer crosses
 * between children of the same element — hence the relatedTarget check, which
 * ignores movement that stays inside the element we are tracking.
 */
export function installHover(
  root: ParentNode,
  selector: string,
  onEnter: (element: HTMLElement) => void,
  onLeave: (element: HTMLElement) => void,
): void {
  const resolve = (event: Event): HTMLElement | null => {
    const target = event.target;
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>(selector);
  };

  const stayedInside = (element: HTMLElement, event: Event): boolean => {
    const related = (event as MouseEvent).relatedTarget;
    return related instanceof Node && element.contains(related);
  };

  root.addEventListener('mouseover', (event) => {
    const element = resolve(event);
    if (element && !stayedInside(element, event)) onEnter(element);
  });

  root.addEventListener('mouseout', (event) => {
    const element = resolve(event);
    if (element && !stayedInside(element, event)) onLeave(element);
  });
}

/** Escape closes whatever is open. Keyboard parity the inline handlers never had. */
export function installEscape(onEscape: () => void): void {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') onEscape();
  });
}
