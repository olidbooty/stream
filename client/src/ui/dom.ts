export interface ElementProps {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
}

// A small createElement helper so components read as their markup.
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  { className, text, attrs }: ElementProps = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      element.setAttribute(name, value);
    }
  }
  element.append(...children);
  return element;
}

let nextId = 0;

// Unique ids for label/aria wiring within the page.
export function uniqueId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}
