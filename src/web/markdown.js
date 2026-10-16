import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt({ html: false, breaks: true, linkify: false });
const allowed = new Set(['p', 'strong', 'em', 's', 'code', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
function safeLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
/** Build an allowlisted DOM from parser tokens. Never insert generated or raw HTML. */
export function renderMarkdown(text, root) {
  function append(tokens, parent) {
    const stack = [parent];
    for (const token of tokens) {
      const current = stack.at(-1);
      if (token.type === 'inline') { append(token.children ?? [], current); continue; }
      if (token.nesting === -1) { if (stack.length > 1) stack.pop(); continue; }
      if (token.nesting === 1) {
        let node;
        if (token.type === 'link_open') {
          const href = safeLink(token.attrGet('href'));
          node = document.createElement(href ? 'a' : 'span');
          if (href) { node.href = href; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
        } else node = document.createElement(allowed.has(token.tag) ? token.tag : 'span');
        if (token.tag === 'ol' && /^\d{1,9}$/.test(token.attrGet('start') ?? '')) node.start = Number(token.attrGet('start'));
        current.append(node); stack.push(node); continue;
      }
      if (['fence', 'code_block'].includes(token.type)) {
        const pre = document.createElement('pre'); pre.className = 'code-block';
        const code = document.createElement('code'); code.textContent = token.content; pre.append(code); current.append(pre);
      } else if (token.type === 'code_inline') {
        const code = document.createElement('code'); code.textContent = token.content; current.append(code);
      } else if (['softbreak', 'hardbreak'].includes(token.type)) current.append(document.createElement('br'));
      else if (token.type === 'hr') current.append(document.createElement('hr'));
      else if (token.type === 'image') current.append(document.createTextNode(token.content || 'Image'));
      else current.append(document.createTextNode(token.content ?? ''));
    }
  }
  root.classList.add('markdown'); append(parser.parse(text, {}), root);
}
