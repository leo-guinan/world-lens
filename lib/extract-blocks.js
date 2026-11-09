// Paragraph-level evidence with positions, read from the page the lens is looking at.
//
// Self-contained so it can be serialized into a page (Playwright's page.evaluate, chrome.scripting): no imports,
// no closures over module state. It reads only; it never changes the document.
//
// Each block is the visible text of one block-level element (a paragraph, a list item, a heading, a table cell…),
// with inline children (links, emphasis, spans) folded in. Its box is the union of the text's own line boxes,
// as fractions of the viewport [x, y, w, h], so it lines up with a viewport screenshot taken at the same moment.
// Blocks scrolled out of view keep their position (outside 0–1) and are marked inView: false.
// Text that is present for screen readers but not drawn (the usual "visually hidden" patterns: clip to nothing,
// a 1px box with overflow hidden) is still returned, as drawn: false with box: null, never with a made-up position.
// Pages often paint text on a canvas and keep an accessible copy like that; canvases are listed with their boxes
// so a reader of the receipt knows where painted content is, without claiming what it says.
export function extractVisibleBlocks(options) {
  const maxBlocks = (options && options.maxBlocks) || 200, maxChars = (options && options.maxChars) || 2000;
  const clean = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const excluded = 'script,style,noscript,template,input,textarea,select,option,[contenteditable],[hidden],[aria-hidden="true"]';
  const vw = window.innerWidth, vh = window.innerHeight;
  const hiddenCache = new Map();
  const hidden = element => {
    if (!element) return true;
    if (hiddenCache.has(element)) return hiddenCache.get(element);
    let result = false;
    if (element.closest(excluded)) result = true;
    else {
      const css = getComputedStyle(element);
      if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || Number(css.opacity) === 0) result = true;
      else if (element.parentElement) result = hidden(element.parentElement);
    }
    hiddenCache.set(element, result);
    return result;
  };
  const srCache = new Map();
  const visuallyHidden = element => {
    if (!element || element === document.body) return false;
    if (srCache.has(element)) return srCache.get(element);
    const css = getComputedStyle(element), r = element.getBoundingClientRect();
    const clipped = /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(css.clip) || /inset\(50%\)/.test(css.clipPath);
    const tiny = r.width <= 1 && r.height <= 1 && css.overflow !== 'visible';
    const result = clipped || tiny || visuallyHidden(element.parentElement);
    srCache.set(element, result);
    return result;
  };
  const inline = element => { const d = getComputedStyle(element).display; return d === 'inline' || d === 'inline-block' || d === 'inline-flex' || d === 'contents'; };
  const blockOf = element => { let el = element; while (el && el !== document.body && inline(el)) el = el.parentElement; return el || document.body; };
  const cssPath = element => {
    const parts = [];
    for (let el = element; el && el.nodeType === 1 && el !== document.documentElement && parts.length < 6; el = el.parentElement) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      const tag = el.tagName.toLowerCase();
      if (el === document.body) { parts.unshift('body'); break; }
      const same = el.parentElement ? Array.from(el.parentElement.children).filter(c => c.tagName === el.tagName) : [el];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag);
    }
    return parts.join(' > ');
  };
  const groups = new Map(), order = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  while (walker.nextNode()) {
    const node = walker.currentNode, parent = node.parentElement;
    if (!parent || hidden(parent)) continue;
    // whitespace between inline elements is part of the text ("essays, and"), but has no box of its own
    if (!clean(node.textContent)) { const g = groups.get(blockOf(parent)); if (g) g.text.push(' '); continue; }
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    if (!rects.length) continue;
    const block = blockOf(parent);
    let g = groups.get(block);
    if (!g) { if (order.length >= maxBlocks) continue; g = { block, drawn: !visuallyHidden(parent), text: [], l: Infinity, t: Infinity, r: -Infinity, b: -Infinity }; groups.set(block, g); order.push(g); }
    g.text.push(node.textContent);
    for (const r of rects) { g.l = Math.min(g.l, r.left); g.t = Math.min(g.t, r.top); g.r = Math.max(g.r, r.right); g.b = Math.max(g.b, r.bottom); }
  }
  range.detach();
  const round = v => Math.round(v * 1e4) / 1e4;
  const blocks = order.map(g => {
    const tag = g.block.tagName.toLowerCase(), role = g.block.getAttribute('role');
    const kind = /^h[1-6]$/.test(tag) || role === 'heading' ? 'heading' : 'text';
    const text = clean(g.text.join('')).slice(0, maxChars), locator = cssPath(g.block);
    if (!g.drawn) return { kind, text, locator, box: null, inView: false, drawn: false };
    const box = [round(g.l / vw), round(g.t / vh), round((g.r - g.l) / vw), round((g.b - g.t) / vh)];
    const inView = g.r > 0 && g.b > 0 && g.l < vw && g.t < vh;
    return { kind, text, locator, box, inView, drawn: true };
  }).filter(b => b.text);
  const canvases = Array.from(document.querySelectorAll('canvas')).filter(c => !hidden(c)).map(c => { const r = c.getBoundingClientRect(); return { locator: cssPath(c), box: [round(r.left / vw), round(r.top / vh), round(r.width / vw), round(r.height / vh)] }; })
    .filter(c => c.box[2] * c.box[3] > 0.001).slice(0, 20);
  return { viewport: { width: vw, height: vh, deviceScaleFactor: window.devicePixelRatio || 1 }, blocks, canvases };
}
