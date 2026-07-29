/** Tiny DOM helpers, so the two UIs read as markup instead of createElement noise. */

export interface ElementOptions {
  class?: string
  id?: string
  text?: string
  title?: string
  type?: string
  href?: string
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (options.class !== undefined) node.className = options.class
  if (options.id !== undefined) node.id = options.id
  if (options.title !== undefined) node.title = options.title
  if (options.type !== undefined) node.setAttribute('type', options.type)
  if (options.href !== undefined) node.setAttribute('href', options.href)
  if (options.text !== undefined) node.textContent = options.text
  for (const child of children) {
    node.append(child)
  }
  return node
}

export function button(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const node = el('button', { class: className, text: label })
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}

/**
 * Copy text to the clipboard. The async Clipboard API is not reliably permitted
 * from a file:// page, which is the normal way these builds are opened, so fall
 * back to the old selection trick rather than failing silently.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const scratch = el('textarea')
    scratch.value = text
    scratch.setAttribute('readonly', 'readonly')
    scratch.style.position = 'fixed'
    scratch.style.opacity = '0'
    document.body.appendChild(scratch)
    scratch.select()
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    scratch.remove()
    return copied
  }
}

/** Plain-text paragraphs. Descriptions are untrusted input; never innerHTML. */
export function paragraphs(text: string): HTMLElement[] {
  return text
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(block => block !== '')
    .map(block => el('p', { text: block }))
}

export function download(filename: string, text: string, mime = 'text/plain'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
  const link = el('a', { href: url })
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoke on the next task: Safari needs the URL to still resolve at click time.
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
