import MarkdownIt from 'markdown-it';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';

const highlighter = createLowlight({ bash, json, javascript, typescript, python, css, xml, yaml, sql, diff });
// Only text and allowlisted spans reach the DOM, never generated HTML.
function highlightCode(text, language, code) {
  code.textContent = text;
  if (!highlighter.registered(language) || text.length > 20_000) return;
  try {
    const append = (nodes, parent) => {
      for (const node of nodes) {
        if (node.type === 'text') parent.append(document.createTextNode(node.value));
        else if (node.type === 'element' && node.tagName === 'span') {
          const span = document.createElement('span');
          span.className = (node.properties.className ?? []).filter(name => /^[a-zA-Z0-9_-]+$/.test(name)).join(' ');
          append(node.children, span); parent.append(span);
        }
      }
    };
    const fragment = document.createDocumentFragment();
    append(highlighter.highlight(language, text).children, fragment);
    code.replaceChildren(fragment);
  } catch { /* Unsupported or incomplete syntax stays readable as plain text. */ }
}

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
        const block = document.createElement('div'); block.className = 'code-container';
        const header = document.createElement('div'); header.className = 'code-header';
        const language = token.info.trim().split(/\s+/)[0].toLowerCase();
        const label = document.createElement('span'); label.className = 'code-language';
        label.textContent = language ? language.slice(0, 40) : 'Code';
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'code-copy';
        const showCopyState = (label, pathData) => {
          copy.setAttribute('aria-label', label); copy.title = label;
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', pathData); svg.append(path);
          const status = document.createElement('span'); status.className = 'sr-only'; status.textContent = label;
          copy.replaceChildren(svg, status);
        };
        const copyPath = 'M9 5H5v14h10v-4M9 3h10v12H9z';
        copy.setAttribute('aria-live', 'polite'); showCopyState('Copy code', copyPath);
        let feedbackTimer;
        copy.onclick = async () => {
          clearTimeout(feedbackTimer);
          try {
            await navigator.clipboard.writeText(token.content);
            showCopyState('Copied', 'm5 12 4 4L19 6');
          } catch { showCopyState('Copy failed', 'm6 6 12 12M6 18 18 6'); }
          feedbackTimer = setTimeout(() => { showCopyState('Copy code', copyPath); }, 1500);
        };
        const pre = document.createElement('pre'); pre.className = 'code-block';
        const code = document.createElement('code'); highlightCode(token.content, language, code); pre.append(code);
        header.append(label, copy); block.append(header, pre); current.append(block);
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
