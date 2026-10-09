// Tiny DOM helpers for menus and HUD. No framework: keeps the download small.

type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: {
    class?: string;
    id?: string;
    onclick?: (e: MouseEvent) => void;
    style?: string;
    disabled?: boolean;
    title?: string;
    [data: `data-${string}`]: string;
  } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'class') el.className = v as string;
    else if (k === 'onclick') el.addEventListener('click', v as EventListener);
    else if (k === 'style') el.setAttribute('style', v as string);
    else if (k === 'disabled') (el as HTMLButtonElement).disabled = Boolean(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const root = (): HTMLElement => document.getElementById('ui')!;

/** Replaces the current full-screen menu (pass null to close it). */
export function showScreen(el: HTMLElement | null): void {
  root()
    .querySelectorAll('.screen')
    .forEach((s) => s.remove());
  if (el) {
    el.classList.add('screen');
    root().appendChild(el);
  }
}

export function hex(color: number): string {
  return '#' + color.toString(16).padStart(6, '0');
}

/** Big centred text that pops in and fades out. */
export function banner(text: string, tone: 'good' | 'bad' | 'neutral', sub = '', ms = 1300): Promise<void> {
  const el = h(
    'div',
    { class: `banner ${tone}` },
    h('div', { class: 'banner-title' }, text),
    sub ? h('div', { class: 'banner-sub' }, sub) : null,
  );
  root().appendChild(el);
  return new Promise((done) =>
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 250);
      done();
    }, ms),
  );
}

export function toast(text: string, ms = 2200): void {
  const el = h('div', { class: 'toast' }, text);
  root().appendChild(el);
  setTimeout(() => el.remove(), ms);
}
